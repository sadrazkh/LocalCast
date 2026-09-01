import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express, { type Express } from 'express';
import { API_PREFIX, type ServerEvent } from '@localcast/contract';
import { SqliteActivityLog } from './activity.js';
import { edgeSecretGuard, peerContext } from './auth/middleware.js';
import { PairingService, type LanEndpoint } from './auth/pairing.js';
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
import { ensureLanCertificate, type LanCertificate } from './net/selfSigned.js';

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
  /**
   * Binds both listeners and resolves with the **loopback HTTP** address, which is the one
   * `netedge` proxies to and the one the operator API answers on.
   */
  listen(port?: number): Promise<AddressInfo>;
  address(): AddressInfo | null;
  /** The local-network HTTPS listener's address, or null when LAN sharing is off. */
  lanAddress(): AddressInfo | null;
  /**
   * Where a device on the same Wi-Fi should connect, and the fingerprint of the certificate
   * it will be shown. Null when LAN sharing is off, or when the machine has no address on it.
   */
  lanEndpoint(): LanEndpoint | null;
  /** The certificate the LAN listener presents, for the panel and for logs. */
  lanCertificate(): LanCertificate | null;
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

  /**
   * The certificate for the local network, issued (or reloaded) before anything binds.
   *
   * Doing it here rather than lazily inside `listen` means a machine that cannot write to its
   * own data directory fails at boot, with the reason in the log — not on the first phone
   * that tries to connect.
   */
  const lanCert: LanCertificate | null = config.lan
    ? ensureLanCertificate({
        dir: path.join(config.dataDir, 'tls'),
        extraHosts: config.lanHosts,
        log,
      })
    : null;

  // Filled in by `listen`, because the port is not known until the socket is bound.
  let lanEndpoint: LanEndpoint | null = null;

  const pairing = new PairingService({
    db,
    tokens,
    activity,
    events,
    ticketSecret: config.jwtSecret,
    publicHost: () => config.publicHost,
    lanEndpoint: () => lanEndpoint,
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

  /**
   * Two listeners, one Express app.
   *
   * Loopback stays plain HTTP because `netedge` is the only thing that talks to it: the
   * sidecar terminates TLS on the tailnet and reverse-proxies here, so a second TLS hop
   * between two processes on the same machine would encrypt nothing that is not already
   * inside one kernel, and would ask the sidecar to validate a certificate no public root
   * signed.
   *
   * The local network gets HTTPS on the self-signed certificate. Everything a phone or
   * another desktop sends over the Wi-Fi — bearer tokens, file names, the file bytes
   * themselves — is encrypted, which it was not when this listener spoke HTTP.
   */
  const server = http.createServer(app);
  const lanServer =
    lanCert === null
      ? null
      : https.createServer({ key: lanCert.keyPem, cert: lanCert.certPem }, (req, res) => {
          // Marks the request before Express ever sees it, so `edgeSecretGuard` can waive the
          // edge secret for this listener alone. A property on the request object, not a
          // header: a client has no way to set it.
          (req as http.IncomingMessage & { viaLan?: boolean }).viaLan = true;
          app(req, res);
        });

  let listening = false;
  let lanListening = false;

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

    async listen(port = config.port): Promise<AddressInfo> {
      // Loopback only. Binding 0.0.0.0 here would put a plain-HTTP copy of the whole API on
      // the local network next to the encrypted one, which is precisely what this listener
      // stopped doing.
      const addr = await bind(server, port, config.host);
      listening = true;
      log.info('server listening', { host: addr.address, port: addr.port });

      if (lanServer !== null && lanCert !== null) {
        const lanAddr = await bind(lanServer, config.lanPort, '0.0.0.0');
        lanListening = true;
        lanEndpoint =
          lanCert.publishHost === null
            ? null
            : {
                url: `https://${lanCert.publishHost}:${lanAddr.port}`,
                fingerprint256: lanCert.fingerprint256,
              };
        log.info('local network listening (https)', {
          host: lanAddr.address,
          port: lanAddr.port,
          // Logged so the value published in the QR code can be checked against the one a
          // device reports seeing, without anybody having to run openssl.
          fingerprint: lanCert.fingerprint256,
          ...(lanEndpoint === null ? {} : { url: lanEndpoint.url }),
        });
        if (lanEndpoint === null) {
          log.warn('local network sharing is on but this machine has no address on one');
        }
      }

      return addr;
    },

    address(): AddressInfo | null {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr : null;
    },

    lanAddress(): AddressInfo | null {
      const addr = lanServer?.address();
      return addr && typeof addr === 'object' ? addr : null;
    },

    lanEndpoint(): LanEndpoint | null {
      return lanEndpoint;
    },

    lanCertificate(): LanCertificate | null {
      return lanCert;
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
      // An SSE stream or a paused range read would otherwise hold `close` open until the
      // client noticed; every one of them has already been told to end.
      if (listening) await shutdown(server);
      if (lanListening && lanServer !== null) await shutdown(lanServer);
      events.dispose();
      db.close();
    },
  };
}

/** `listen`, promised, with the `error` listener removed once it can no longer fire. */
function bind(
  server: http.Server | https.Server,
  port: number,
  host: string,
): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function shutdown(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
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
export type { LanEndpoint } from './auth/pairing.js';
export {
  defaultSanHosts,
  ensureLanCertificate,
  generateLanCertificate,
  lanIpv4Addresses,
} from './net/selfSigned.js';
export type { LanCertificate } from './net/selfSigned.js';
