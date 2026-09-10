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
import { CapabilityReports } from './http/capabilities.js';
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
import { buildLanAccess, type LanAccess } from './net/lanAccess.js';
import { lanCandidates } from './net/lanAddress.js';
import { LanPublisher } from './net/lanPublisher.js';
import { createPlaintextListener } from './net/plaintext.js';
import type { LanCertificate } from './net/selfSigned.js';

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
   * The **unencrypted** local-network listener's address, or null — which is the normal case.
   * Non-null only when the operator deliberately turned it on.
   */
  lanPlaintextAddress(): AddressInfo | null;
  /**
   * Every address this machine answers on for the local network, encrypted and not, for the
   * panel to render. The plaintext ones appear here and nowhere else: they are never put in a
   * QR code, so the only way a device reaches them is for a person to read one off the panel.
   */
  lanAccess(): LanAccess;
  /**
   * Where a device on the same Wi-Fi should connect, and the fingerprint of the certificate
   * it will be shown. Null when LAN sharing is off, or when the machine has no address on it.
   */
  lanEndpoint(): LanEndpoint | null;
  /** The certificate the LAN listener presents, for the panel and for logs. */
  lanCertificate(): LanCertificate | null;
  /**
   * Whether local-network sharing is actually working, and why not when it is not.
   *
   * The panel needs the difference between the three ways it can be unavailable — switched off,
   * no address on this machine yet, could not bind — because they call for three different
   * things from the user and used to be indistinguishable from a null URL.
   */
  lanStatus(): LanStatus;
  /**
   * Re-read the machine's addresses now instead of waiting for the next poll. Returns true when
   * something changed. Called by the desktop when the user asks, from the panel.
   */
  refreshLanAddress(): boolean;
  /**
   * Open or close the unencrypted listener without restarting. Returns the resulting status.
   *
   * A no-op when local sharing is off entirely: an unencrypted door onto a network we are not
   * otherwise sharing on would be a way to *start* sharing without ever choosing to.
   */
  setLanPlaintext(enabled: boolean): Promise<LanStatus>;
  dispose(): Promise<void>;
}

export interface LanStatus {
  state: 'off' | 'listening' | 'no-address' | 'failed';
  /** The address published to devices, scheme and port included. Null unless `listening`. */
  url: string | null;
  fingerprint256: string | null;
  /** False when the published address is the plaintext listener's. */
  encrypted: boolean;
  securePort: number | null;
  plaintextPort: number | null;
  /** Set only when `state` is `failed`; a sentence, not an errno. */
  error: string | null;
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
   * What each device's browser says it was actually granted.
   *
   * In memory on purpose — see `http/capabilities.ts`. Constructed here so the device route
   * that writes it and the operator route that reads it are looking at one object rather than
   * at two that agree by coincidence.
   */
  const capabilities = new CapabilityReports();

  /**
   * The certificate for the local network, and the thing that keeps it current.
   *
   * Issued here rather than lazily inside `listen` so that a machine which cannot write to its
   * own data directory fails at boot, with the reason in the log — not on the first phone that
   * tries to connect. From then on `LanPublisher` re-reads the machine's addresses and re-issues
   * when they move, which is what stops a laptop that started before its Wi-Fi came up from
   * insisting for the rest of the session that it has no local network.
   */
  const publisher: LanPublisher | null = config.lan
    ? new LanPublisher({
        dir: path.join(config.dataDir, 'tls'),
        extraHosts: config.lanHosts,
        log,
        // Swapped on the bound socket, not rebound. A phone halfway through a 4 GB film must not
        // have its connection cut because the laptop got a new DHCP lease.
        onCertificateChanged: (next) => {
          try {
            lanServer?.setSecureContext({ key: next.keyPem, cert: next.certPem });
          } catch (err) {
            log.error('could not adopt the new local-network certificate', { error: String(err) });
          }
        },
        ...(config.lanWatchIntervalMs > 0 ? { intervalMs: config.lanWatchIntervalMs } : {}),
      })
    : null;

  // The certificate as it was when the listener was constructed. Everything that needs the
  // *current* one calls `lanCertificateNow`; this exists only to build the TLS server.
  const initialCert: LanCertificate | null = publisher?.start() ?? null;
  const lanCertificateNow = (): LanCertificate | null => publisher?.certificate() ?? null;

  if (config.lan) {
    /**
     * Every address the machine holds and what was decided about each one.
     *
     * One line, at boot, because the failure this guards against is silent: the app publishes an
     * address, the phone cannot route to it, and there is nothing anywhere saying which of the
     * machine's four addresses was chosen or why the other three were not. With this, a user who
     * reports "the address is wrong" has already sent the answer.
     */
    log.info('local network addresses', {
      published: initialCert?.publishHost ?? '(none)',
      seen: lanCandidates()
        .map((c) => `${c.address} on ${c.adapter}${c.tunnel ? ` — skipped: ${c.note}` : ''}`)
        .join('; '),
    });
  }

  /**
   * Why the local network is not being served, when it was asked for. Null when nothing is wrong.
   *
   * A failure to bind used to propagate out of `listen`, out of `startServer`, and into the
   * desktop's fatal-error dialog — so a port held by anything at all (a previous copy of the app
   * still in the tray, most often) took down the whole application, operator API and panel
   * included. The user's report for that was "the server does not connect at all". It is a
   * recoverable condition and is now recorded rather than thrown.
   */
  let lanFailure: string | null = null;

  /**
   * Where a device should connect, computed on every call rather than cached at boot.
   *
   * Cached, it was wrong after any of the four ordinary events that move a machine's address —
   * and it was the value the QR code was minted from, so "the address in the QR is stale" and
   * "pairing does not work" were the same bug wearing two faces.
   *
   * The plaintext listener wins when it is bound, and only then. A QR pointing at the encrypted
   * listener leads a phone to a certificate interstitial, and somebody who has deliberately
   * turned plaintext on has already accepted what it costs; publishing an address they cannot
   * use would make the switch pointless. Nothing turns that listener on implicitly.
   */
  function currentLanEndpoint(): LanEndpoint | null {
    const cert = lanCertificateNow();
    const host = cert?.publishHost ?? null;
    if (host === null || cert === null) return null;

    const plainPort = portOf(plaintextServer);
    // Empty fingerprint, deliberately: there is no certificate on this address to pin, and a
    // client must read the absence as "nothing to verify", never as "skip verification".
    if (plainPort !== null) return { url: `http://${host}:${plainPort}`, fingerprint256: '' };

    const securePort = portOf(lanServer);
    if (securePort === null) return null;
    return { url: `https://${host}:${securePort}`, fingerprint256: cert.fingerprint256 };
  }

  /**
   * Every address a device on the local network can reach this server at, best first.
   *
   * The published endpoint leads; then the same listener under the machine's `.local` name,
   * which survives a DHCP lease moving; then the other listener, if it is up. Reported by `/me`
   * so a phone can keep a fallback list.
   */
  function currentLanOrigins(): string[] {
    const access = buildLanAccess({
      certificate: lanCertificateNow(),
      tlsPort: portOf(lanServer),
      plaintextPort: portOf(plaintextServer),
    });
    const published = currentLanEndpoint()?.url;
    const all = [...access.secure, ...access.plaintext].map((a) => a.url);
    const ordered = published === undefined ? all : [published, ...all.filter((u) => u !== published)];
    return [...new Set(ordered)];
  }

  /**
   * Is this one of *this server's* origins — scheme, name and port, all three?
   *
   * The name alone is not enough. `http://192.168.8.92:1` shares a hostname with this server and
   * is a page served by something else entirely on the same machine; a hostname check would have
   * allowed it. So the name must be one the certificate claims (or loopback), and the scheme and
   * port must be one of the listeners actually bound right now — a match on the whole origin,
   * which is what an origin is.
   */
  function isOwnOrigin(origin: string): boolean {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

    const listeners: { scheme: string; port: number | null }[] = [
      { scheme: 'https:', port: portOf(lanServer) },
      { scheme: 'http:', port: portOf(plaintextServer) },
      // The loopback listener, which is where the desktop's own renderer and netedge talk to us.
      { scheme: 'http:', port: portOf(server) },
    ];
    const onOurListener = listeners.some((l) => l.port !== null && l.scheme === url.protocol && l.port === port);
    if (!onOurListener) return false;

    if (host === 'localhost' || host === '127.0.0.1') return true;
    const cert = lanCertificateNow();
    return cert !== null && cert.hosts.some((h) => h.toLowerCase() === host);
  }

  /** Whether local sharing is working, and which of the three ways it is not when it is not. */
  function currentLanStatus(): LanStatus {
    const cert = lanCertificateNow();
    const state: LanStatus['state'] = !config.lan
      ? 'off'
      : lanFailure !== null && portOf(lanServer) === null
        ? 'failed'
        : cert?.publishHost == null
          ? 'no-address'
          : 'listening';
    return {
      state,
      url: currentLanEndpoint()?.url ?? null,
      fingerprint256: cert?.fingerprint256 ?? null,
      encrypted: portOf(plaintextServer) === null,
      securePort: portOf(lanServer),
      plaintextPort: portOf(plaintextServer),
      error: lanFailure,
    };
  }

  const pairing = new PairingService({
    db,
    tokens,
    activity,
    events,
    ticketSecret: config.jwtSecret,
    publicHost: () => config.publicHost,
    lanEndpoint: currentLanEndpoint,
    ownerUserId: () => ownerUserId(db),
  });

  const app = express();
  app.disable('x-powered-by');
  // We set our own weak ETags on media; express's would try to buffer and hash responses.
  app.set('etag', false);
  app.set('trust proxy', false);

  app.use(express.json({ limit: '1mb' }));
  app.use(peerContext());
  /**
   * Cross-origin requests between this server's *own* origins, and no others.
   *
   * A phone pairs at `https://192.168.8.92:8420` and the app is served from there. When the
   * laptop's address changes, the installed app still opens — from the service worker's cache —
   * at the old origin, and its requests fail over to `https://sadra.local:8420`. That is a
   * cross-origin request from one of our addresses to another, and without this header the
   * browser refuses it before the server ever sees it. The allow-list is the certificate's SAN:
   * exactly the names this machine has claimed to be, and nothing a stranger's page could use.
   */
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !isOwnOrigin(origin)) {
      next();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'authorization, content-type, range, last-event-id, x-requested-with',
    );
    res.setHeader('Access-Control-Expose-Headers', 'content-range, accept-ranges, etag, content-length');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  // Nothing below this line is reachable without the secret `netedge` injects — unless the
  // operator has turned on local-network sharing, where there is no edge to inject it and the
  // device token is the credential that matters.
  app.use(edgeSecretGuard(config.edgeSecret, { lanAllowed: config.lan }));

  app.use(
    OPERATOR_PREFIX,
    createOperatorRouter({ ctx, tokens, pairing, indexer, activity, capabilities }),
  );

  const eventsRouter = createEventsRouter({
    bus: events,
    tokens,
    log,
    ...(sseHeartbeatMs === undefined ? {} : { heartbeatMs: sseHeartbeatMs }),
  });
  app.use(API_PREFIX, eventsRouter.router);

  app.use(
    API_PREFIX,
    createDeviceRouter({
      ctx,
      config,
      tokens,
      pairing,
      limiter,
      files,
      permissions,
      capabilities,
      lanOrigins: currentLanOrigins,
    }),
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
   * Two listeners, one Express app — three when the unencrypted fallback is switched on.
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
  const server = tuneForMedia(http.createServer(app));
  const lanServer =
    initialCert === null
      ? null
      : tuneForMedia(https.createServer({ key: initialCert.keyPem, cert: initialCert.certPem }, (req, res) => {
          // Marks the request before Express ever sees it, so `edgeSecretGuard` can waive the
          // edge secret for this listener alone. A property on the request object, not a
          // header: a client has no way to set it.
          (req as http.IncomingMessage & { viaLan?: boolean }).viaLan = true;
          app(req, res);
        }));

  /**
   * The unencrypted fallback, for devices whose browser will not use the encrypted listener at
   * all. Off unless somebody turned it on; see `net/plaintext.ts` for why it exists and why it
   * is not — and cannot be — a repair for the offline library.
   *
   * Requires `lan` as well: an unencrypted door onto a network we are not otherwise sharing on
   * would be a way to *start* sharing without ever choosing to.
   */
  let plaintextServer: http.Server | null =
    config.lan && config.lanPlaintext ? tuneForMedia(createPlaintextListener({ handler: app, log })) : null;

  let listening = false;
  let lanListening = false;
  let plaintextListening = false;

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

      /**
       * The two network listeners are opened inside a `try` and their failure is recorded, never
       * thrown.
       *
       * A rejection here used to travel all the way out to the desktop's fatal-error dialog, so a
       * single busy port — most often a previous copy of the app still sitting in the tray, which
       * is exactly what happens when somebody closes the window and opens it again — killed the
       * whole application. No panel, no operator API, no folders, nothing. The local network not
       * being served is a bad outcome; not starting at all is a worse one, and it hides the cause.
       */
      try {
        if (lanServer !== null) {
          const lanAddr = await bindPreferring(lanServer, config.lanPort, '0.0.0.0', log);
          lanListening = true;
          const cert = lanCertificateNow();
          log.info('local network listening (https)', {
            host: lanAddr.address,
            port: lanAddr.port,
            // Logged so the value published in the QR code can be checked against the one a
            // device reports seeing, without anybody having to run openssl.
            fingerprint: cert?.fingerprint256 ?? '(none)',
            url: currentLanEndpoint()?.url ?? '(none)',
          });
          if (cert?.publishHost == null) {
            // Not fatal, and no longer permanent: `LanPublisher` keeps looking, so a machine that
            // started before its Wi-Fi associated picks the address up within a few seconds.
            log.warn('local network sharing is on but this machine has no address on one yet');
          }
        }

        if (plaintextServer !== null) {
          const plainAddr = await bindPreferring(
            plaintextServer,
            config.lanPlaintextPort,
            '0.0.0.0',
            log,
          );
          plaintextListening = true;
          // A warning, not an info line. This listener is a deliberate exception to "every
          // connection is encrypted", and a log that states it plainly is part of the price.
          log.warn('local network ALSO listening unencrypted (http)', {
            host: plainAddr.address,
            port: plainAddr.port,
            published: currentLanEndpoint()?.url ?? '(none)',
            note: 'devices on this address get no offline library and no camera; http is never a secure context',
          });
        }
      } catch (err) {
        lanFailure = describeBindFailure(err, config.lanPort);
        log.error('local network sharing could not start', {
          error: lanFailure,
          note: 'the app itself is running; only sharing on the Wi-Fi is unavailable',
        });
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

    lanPlaintextAddress(): AddressInfo | null {
      const addr = plaintextServer?.address();
      return addr && typeof addr === 'object' ? addr : null;
    },

    lanAccess(): LanAccess {
      return buildLanAccess({
        certificate: lanCertificateNow(),
        tlsPort: portOf(lanServer),
        plaintextPort: portOf(plaintextServer),
      });
    },

    lanEndpoint(): LanEndpoint | null {
      return currentLanEndpoint();
    },

    lanCertificate(): LanCertificate | null {
      return lanCertificateNow();
    },

    lanStatus(): LanStatus {
      return currentLanStatus();
    },

    refreshLanAddress(): boolean {
      return publisher?.refresh() ?? false;
    },

    /**
     * Open or close the unencrypted listener while the server is running.
     *
     * Encryption is the default, and it costs a phone one certificate warning to accept. Some
     * devices will not let a person past that warning at all — an embedded webview with no
     * "proceed" affordance, a managed configuration profile — and for them the choice is
     * plaintext or nothing. That decision belongs to the operator, in one click, on the machine
     * serving the files. Making them edit a JSON file and restart is not offering a choice.
     *
     * The encrypted listener is untouched either way: it keeps its socket, its port and its
     * certificate. All that changes is which address `lanEndpoint` advertises.
     */
    async setLanPlaintext(enabled: boolean): Promise<LanStatus> {
      if (!config.lan) return currentLanStatus();

      if (enabled && plaintextServer === null) {
        const next = tuneForMedia(createPlaintextListener({ handler: app, log }));
        try {
          const addr = await bindPreferring(next, config.lanPlaintextPort, '0.0.0.0', log);
          plaintextServer = next;
          plaintextListening = true;
          config.lanPlaintext = true;
          log.warn('local network ALSO listening unencrypted (http)', {
            port: addr.port,
            published: currentLanEndpoint()?.url ?? '(none)',
          });
        } catch (err) {
          // Left closed rather than half-open, and the reason is returned as state — the panel
          // showed a switch, so the panel is where the refusal has to appear.
          await shutdown(next).catch(() => undefined);
          lanFailure = describeBindFailure(err, config.lanPlaintextPort);
          log.error('the unencrypted listener could not start', { error: lanFailure });
        }
      } else if (!enabled && plaintextServer !== null) {
        const closing = plaintextServer;
        plaintextServer = null;
        plaintextListening = false;
        config.lanPlaintext = false;
        await shutdown(closing);
        log.info('the unencrypted local-network listener is closed', {
          published: currentLanEndpoint()?.url ?? '(none)',
        });
      }
      return currentLanStatus();
    },

    async dispose(): Promise<void> {
      publisher?.stop();
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
      if (plaintextListening && plaintextServer !== null) await shutdown(plaintextServer);
      events.dispose();
      db.close();
    },
  };
}

/**
 * Socket timeouts sized for a media player, not a web page.
 *
 * Node closes an idle keep-alive connection after five seconds. A player reading a film does
 * not read steadily: it fills a buffer, goes quiet for ten or twenty seconds, then wants the
 * next stretch — and by then the socket is gone, so every burst starts with a new connection
 * and, on the encrypted listener, a new TLS handshake. On a phone that is a visible hitch at
 * each buffer refill, on some files and not others depending only on how big a buffer the
 * player chose for that bitrate. Two minutes keeps the socket through any refill a player
 * would do. `headersTimeout` has to stay above `keepAliveTimeout`, or Node ends the connection
 * while it is legitimately idle between requests.
 *
 * No overall socket timeout: a paused player holding a ranged GET open for an hour is not a
 * stuck connection, it is a paused player.
 */
function tuneForMedia<T extends http.Server | https.Server>(listener: T): T {
  listener.keepAliveTimeout = 120_000;
  listener.headersTimeout = 125_000;
  listener.timeout = 0;
  return listener;
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

/** How many ports above the preferred one to try before giving up. */
const PORT_SEARCH_SPAN = 8;

function isAddressInUse(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

/**
 * Bind the port the product documents, or the next free one above it.
 *
 * The fixed port matters — an address somebody reads off a QR code has to be the same address
 * tomorrow — but "fixed" cannot mean "or else nothing works". Ports get held: by a previous copy
 * of this app that has not finished exiting, by a socket in `TIME_WAIT`, by an unrelated program,
 * and on Windows by Hyper-V's reserved dynamic ranges, which swallow whole blocks and answer
 * `EACCES` rather than `EADDRINUSE`. Every one of those produced the same user-visible outcome:
 * the app did not start.
 *
 * So the preferred port is tried first and is what will normally be used; a few above it are
 * tried next, loudly, because the QR code carries the port and will be correct either way.
 */
async function bindPreferring(
  server: http.Server | https.Server,
  preferred: number,
  host: string,
  log: Logger,
): Promise<AddressInfo> {
  let lastError: unknown = null;
  for (let offset = 0; offset <= PORT_SEARCH_SPAN; offset += 1) {
    const port = preferred + offset;
    try {
      const addr = await bind(server, port, host);
      if (offset > 0) {
        log.warn('the preferred port was taken, so a nearby one is in use instead', {
          preferred,
          using: port,
          note: 'the address handed to devices carries this port, so pairing is unaffected',
        });
      }
      return addr;
    } catch (err) {
      lastError = err;
      if (!isAddressInUse(err)) throw err;
    }
  }
  throw lastError;
}

/** A bind failure in words an operator can act on, rather than an errno. */
function describeBindFailure(err: unknown, preferred: number): string {
  if (isAddressInUse(err)) {
    return (
      `ports ${preferred}–${preferred + PORT_SEARCH_SPAN} are all in use or reserved on this ` +
      'machine. Another copy of LocalCast may still be running — check the system tray.'
    );
  }
  return err instanceof Error ? err.message : String(err);
}

/** The bound port, or null when the server does not exist or was never bound. */
function portOf(server: http.Server | https.Server | null): number | null {
  const addr = server?.address();
  return addr !== null && addr !== undefined && typeof addr === 'object' ? addr.port : null;
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
    case 'permissions':
      // A device hears about its own status and its own grants, and nobody else's.
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
} from './net/selfSigned.js';
export type { LanCertificate } from './net/selfSigned.js';
export { lanCandidates, lanIpv4Addresses } from './net/lanAddress.js';
export type { LanCandidate } from './net/lanAddress.js';
export { LanPublisher } from './net/lanPublisher.js';
export { buildLanAccess } from './net/lanAccess.js';
export type { LanAccess, LanAddress } from './net/lanAccess.js';
export { CapabilityReports, deviceCapabilityReportSchema } from './http/capabilities.js';
export type {
  DeviceCapabilityReport,
  ObservedListener,
  ServiceWorkerState,
  StoredCapabilityReport,
} from './http/capabilities.js';
