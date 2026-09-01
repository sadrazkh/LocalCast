import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { API_PREFIX, type ServerEvent } from '@localcast/contract';
import { SqliteActivityLog } from './activity.js';
import { edgeSecretGuard, peerContext } from './auth/middleware.js';
import { PairingService } from './auth/pairing.js';
import { RateLimiter, type RateLimitOptions } from './auth/rateLimit.js';
import { TokenService } from './auth/tokens.js';
import { loadConfig, type ServerConfig, type ServerConfigOverrides } from './config.js';
import { openDatabase, ownerUserId } from './db/index.js';
import { InMemoryEventBus } from './events/bus.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { createDeviceRouter } from './http/routes/device.js';
import { createEventsRouter } from './http/routes/events.js';
import { createOperatorRouter } from './http/routes/operator.js';
import { mountWebClient } from './http/web.js';
import type { Logger, ServerContext, ServerModule } from './kernel.js';
import { Indexer } from './library/indexer.js';
import { SqlPermissionService } from './library/permissions.js';
import { FsFileResolver } from './library/resolver.js';
import { createLogger } from './logger.js';

export const OPERATOR_PREFIX = '/operator';

export interface CreateServerOptions extends ServerConfigOverrides {
  log?: Logger;
  rateLimits?: Partial<RateLimitOptions>;
  /** Test seam; production always uses the 20 s heartbeat from the contract. */
  sseHeartbeatMs?: number;
}

export interface LocalCastServer {
  app: Express;
  ctx: ServerContext;
  config: ServerConfig;
  indexer: Indexer;
  listen(port?: number): Promise<AddressInfo>;
  address(): AddressInfo | null;
  dispose(): Promise<void>;
}

export async function createServer(options: CreateServerOptions = {}): Promise<LocalCastServer> {
  const { log: providedLog, rateLimits, sseHeartbeatMs, ...configOverrides } = options;
  const config = loadConfig(configOverrides);
  const log = providedLog ?? createLogger(config.logLevel);

  for (const dir of [config.dataDir, config.tempDir, config.vendorDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Spool copies and half-finished uploads are worthless across a restart and would
  // otherwise accumulate a gigabyte at a time.
  cleanDirectory(config.tempDir, log);

  const db = openDatabase({
    path: config.dbPath,
    ...(config.nativeBinding ? { nativeBinding: config.nativeBinding } : {}),
    log,
  });

  const activity = new SqliteActivityLog(db, log);
  const events = new InMemoryEventBus({
    // A print job belongs to one device. Without this filter every subscriber would see
    // every other device's file names go past.
    visibility: (event, deviceId) => isVisibleTo(db, event, deviceId),
  });
  const permissions = new SqlPermissionService(db);
  const files = new FsFileResolver({ db });

  const ctx: ServerContext = {
    db,
    permissions,
    files,
    activity,
    events,
    paths: { dataDir: config.dataDir, tempDir: config.tempDir, vendorDir: config.vendorDir },
    log,
  };

  const tokens = new TokenService(db, config.jwtSecret, {
    accessTokenTtlMs: config.accessTokenTtlMs,
    refreshTokenTtlMs: config.refreshTokenTtlMs,
  });
  const limiter = new RateLimiter(rateLimits ?? {});
  const indexer = new Indexer({ db, log, events });
  const pairing = new PairingService({
    db,
    tokens,
    activity,
    events,
    ticketSecret: config.jwtSecret,
    publicHost: () => config.publicHost,
    ownerUserId: () => ownerUserId(db),
  });

  const app = express();
  app.disable('x-powered-by');
  // We set our own weak ETags on media; express's would try to buffer and hash responses.
  app.set('etag', false);
  app.set('trust proxy', false);

  app.use(express.json({ limit: '1mb' }));
  app.use(peerContext());
  // Nothing below this line is reachable without the secret `netedge` injects — unless the
  // operator has turned on local-network sharing, where there is no edge to inject it and the
  // device token is the credential that matters.
  app.use(edgeSecretGuard(config.edgeSecret, { lanAllowed: config.lan }));

  app.use(OPERATOR_PREFIX, createOperatorRouter({ ctx, tokens, pairing, indexer, activity }));

  const eventsRouter = createEventsRouter({
    bus: events,
    tokens,
    log,
    ...(sseHeartbeatMs === undefined ? {} : { heartbeatMs: sseHeartbeatMs }),
  });
  app.use(API_PREFIX, eventsRouter.router);

  app.use(
    API_PREFIX,
    createDeviceRouter({ ctx, config, tokens, pairing, limiter, files, permissions }),
  );

  /**
   * Feature modules (WebDAV, printing, uploads) live under `src/modules` and are written
   * separately from the core. The import is defensive on purpose: during development that
   * directory may not exist yet, and a core server that refuses to boot because an optional
   * subsystem is missing is worse than one that boots without it and says so.
   */
  const modules = await loadModules(log, ctx);
  for (const mod of modules) {
    try {
      await mod.register(app, ctx);
      log.info('module registered', { module: mod.name });
    } catch (err) {
      log.error('module failed to register', { module: mod.name, error: String(err) });
    }
  }

  // Last, so the SPA fallback can never shadow an API route: anything the routers above
  // did not claim is either an app asset or a genuine 404.
  mountWebClient(app, config.webRoot, log);

  app.use(notFoundHandler);
  app.use(errorHandler(log));

  const server = http.createServer(app);
  let listening = false;

  if (config.indexOnStart) {
    // Deliberately not awaited: a 200k-file library must not delay the first request.
    void indexer.indexAll().catch((err: unknown) => {
      log.error('initial index failed', { error: String(err) });
    });
  }

  return {
    app,
    ctx,
    config,
    indexer,

    listen(port = config.port): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // 0.0.0.0 when the operator has chosen to share over the local network, loopback
        // otherwise — where `netedge` is the only thing in front of us and is on this
        // machine. The operator API is unaffected either way: it carries its own loopback
        // check, so opening the LAN listener never exposes the surface that grants access.
        server.listen(port, config.lan ? '0.0.0.0' : config.host, () => {
          listening = true;
          server.off('error', reject);
          const addr = server.address() as AddressInfo;
          log.info('server listening', { host: addr.address, port: addr.port });
          resolve(addr);
        });
      });
    },

    address(): AddressInfo | null {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr : null;
    },

    async dispose(): Promise<void> {
      eventsRouter.dispose();
      for (const mod of modules) {
        try {
          await mod.dispose?.();
        } catch (err) {
          log.warn('module dispose failed', { module: mod.name, error: String(err) });
        }
      }
      if (listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          // An SSE stream or a paused range read would otherwise hold `close` open until the
          // client noticed; every one of them has already been told to end.
          server.closeAllConnections?.();
        });
      }
      events.dispose();
      db.close();
    },
  };
}

/**
 * Resolves the module bundle if it exists. Anything other than "the file is not there" is
 * logged as an error rather than swallowed — a module with a syntax error must not look the
 * same as a module that has not been written yet.
 */
async function loadModules(log: Logger, ctx: ServerContext): Promise<ServerModule[]> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('./modules/index.js')) as Record<string, unknown>;
  } catch (err) {
    if (isModuleMissing(err)) {
      log.warn('feature modules are not present; running with core routes only');
      return [];
    }
    log.error('feature modules failed to load', { error: String(err) });
    return [];
  }

  // Either shape is accepted, because the bundle is written by another hand: a factory that
  // wants the context, or a plain exported array.
  const candidate =
    (typeof mod['createModules'] === 'function'
      ? await (mod['createModules'] as (c: ServerContext) => unknown | Promise<unknown>)(ctx)
      : undefined) ??
    mod['modules'] ??
    mod['default'];

  if (!Array.isArray(candidate)) {
    log.warn('feature module bundle exported nothing usable');
    return [];
  }
  return candidate.filter(isServerModule);
}

function isServerModule(value: unknown): value is ServerModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ServerModule).name === 'string' &&
    typeof (value as ServerModule).register === 'function'
  );
}

function isModuleMissing(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ENOENT') {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    /Cannot find module/i.test(message) ||
    /Failed to load url/i.test(message) ||
    /Failed to resolve import/i.test(message)
  );
}

function isVisibleTo(
  db: ServerContext['db'],
  event: ServerEvent,
  deviceId: string,
): boolean {
  switch (event.type) {
    case 'print-job': {
      const row = db.prepare('SELECT device_id FROM print_jobs WHERE id = ?').get(event.job.id) as
        | { device_id: string }
        | undefined;
      return row?.device_id === deviceId;
    }
    case 'upload': {
      const row = db.prepare('SELECT device_id FROM uploads WHERE id = ?').get(event.uploadId) as
        | { device_id: string }
        | undefined;
      return row?.device_id === deviceId;
    }
    case 'device':
      // A device hears about its own status change and nobody else's.
      return event.deviceId === deviceId;
    case 'folder': {
      const row = db
        .prepare(
          "SELECT 1 AS ok FROM folder_permissions WHERE device_id = ? AND folder_id = ? AND mode <> 'none'",
        )
        .get(deviceId, event.folderId) as { ok: number } | undefined;
      return row !== undefined;
    }
    default:
      return true;
  }
}

function cleanDirectory(dir: string, log: Logger): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(`${dir}/${entry}`, { recursive: true, force: true });
    }
  } catch (err) {
    log.warn('could not clean the temp directory', { dir, error: String(err) });
  }
}

export type { ServerContext, ServerModule } from './kernel.js';
export { openDatabase } from './db/index.js';
export { createLogger, silentLogger } from './logger.js';
export { Indexer } from './library/indexer.js';
export { FsFileResolver } from './library/resolver.js';
export { SqlPermissionService } from './library/permissions.js';
export { TokenService } from './auth/tokens.js';
export { PairingService } from './auth/pairing.js';
export { RateLimiter } from './auth/rateLimit.js';
export { InMemoryEventBus } from './events/bus.js';
export { SqliteActivityLog } from './activity.js';
export { loadConfig } from './config.js';
export type { ServerConfig } from './config.js';
