import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Everything the core needs to boot, resolved once. Nothing here is read from the
 * environment at use time, so a test can build a completely isolated server by passing
 * overrides instead of mutating `process.env` and racing every other test in the file.
 */
export interface ServerConfig {
  /** `%LOCALAPPDATA%\LocalCast` in production. */
  dataDir: string;
  tempDir: string;
  vendorDir: string;
  dbPath: string;
  /**
   * Always loopback. `netedge` is the only thing in front of us and it lives on the same
   * machine; binding anything else would put the API on the LAN without the edge secret
   * ever having been checked.
   */
  host: string;
  /** 0 asks the OS for an ephemeral port, which is what Electron does. */
  port: number;
  /**
   * Shared with `netedge`, which injects it on every proxied request. Without it another
   * local process could reach the API simply by pointing a browser at 127.0.0.1.
   */
  edgeSecret: string;
  /** HS256 signing key for access tokens. Held by Electron in DPAPI, never on disk here. */
  jwtSecret: Uint8Array;
  serverName: string;
  version: string;
  /** MagicDNS FQDN handed to clients in the QR payload and in `/me`. */
  publicHost: string;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  /** Walk the shared folders once at boot. Off in tests that drive the indexer directly. */
  indexOnStart: boolean;
  /**
   * Directory holding the built PWA. Served from this same origin, so the phone never has
   * to be told a second address — whatever host the QR code carried serves both the app and
   * its data. Empty disables it, which is how tests and a dev server run.
   */
  webRoot: string;
  /**
   * A `better_sqlite3.node` built for the host runtime, when it is not the one in
   * node_modules. Electron sets this; tests and the CLI leave it empty.
   */
  nativeBinding: string;
  /**
   * Also listen on the local network, not only on loopback.
   *
   * This is what makes signing in optional. `netedge` is for reaching the machine from
   * somewhere else; on the same Wi-Fi nothing needs a coordination server, an account or a
   * certificate authority, and the original design was explicit that it should not.
   *
   * That listener is **HTTPS**, on a certificate the app generates for itself. No certificate
   * authority is installed on any device; the cost is one browser warning the first time a
   * phone connects. What it buys, beyond the traffic no longer being readable by everyone
   * else on the Wi-Fi, is a secure context — so the phone gets its service worker (offline
   * library) and its camera (QR scanning), neither of which a plain-HTTP origin can have.
   */
  lan: boolean;
  /**
   * Port for the local-network HTTPS listener. Separate from `port` because one socket cannot
   * speak both HTTP and HTTPS, and loopback has to stay plain HTTP: `netedge` terminates its
   * own TLS and proxies to us, so a second TLS hop over loopback would buy nothing and would
   * ask the sidecar to trust a certificate it has no reason to.
   */
  lanPort: number;
  /**
   * Extra names to put in the certificate's SAN, on top of loopback, this machine's hostname
   * and its detected LAN addresses. Empty in production; a fixed value makes a test's
   * certificate predictable.
   */
  lanHosts: string[];
  /**
   * A **second, unencrypted** local-network listener, for devices whose browser will not use
   * the encrypted one at all.
   *
   * Off, and it stays off unless a person turns it on and is shown what it costs. It is not a
   * repair for the offline library: a plain-`http://` origin is not a secure context on any
   * browser, so it has no service worker and no camera — strictly fewer capabilities than the
   * HTTPS listener with an accepted warning, not more. What it is for is the narrow case where
   * a device cannot get past the certificate interstitial in the first place (an embedded
   * webview with no "proceed" affordance, a TV browser, a kiosk policy): there the choice is
   * plaintext or nothing at all.
   *
   * Every consequence of turning it on is local to this listener. The HTTPS listener keeps
   * running, keeps its certificate, and stays the address published in the QR code — nothing
   * moves onto this one unless somebody types its address by hand.
   */
  lanPlaintext: boolean;
  /** Port for the unencrypted listener. Separate socket, so it can never share TLS state. */
  lanPlaintextPort: number;
  logLevel: LogLevel;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type ServerConfigOverrides = Partial<Omit<ServerConfig, 'jwtSecret'>> & {
  jwtSecret?: Uint8Array | string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function defaultDataDir(): string {
  const local = process.env['LOCALAPPDATA'];
  if (local) return path.join(local, 'LocalCast');
  // Non-Windows only happens in CI; keep it working rather than throwing at import time.
  return path.join(os.homedir(), '.localcast');
}

export function loadConfig(overrides: ServerConfigOverrides = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  const jwtSecret =
    typeof overrides.jwtSecret === 'string'
      ? Buffer.from(overrides.jwtSecret, 'utf8')
      : (overrides.jwtSecret ?? randomBytes(32));

  return {
    dataDir,
    tempDir: overrides.tempDir ?? path.join(dataDir, 'temp'),
    vendorDir: overrides.vendorDir ?? path.join(dataDir, 'vendor'),
    dbPath: overrides.dbPath ?? path.join(dataDir, 'localcast.db'),
    host: overrides.host ?? '127.0.0.1',
    port: overrides.port ?? 0,
    edgeSecret: overrides.edgeSecret ?? randomBytes(32).toString('base64url'),
    jwtSecret,
    serverName: overrides.serverName ?? 'LocalCast',
    version: overrides.version ?? '0.1.0',
    publicHost: overrides.publicHost ?? 'localcast.local',
    accessTokenTtlMs: overrides.accessTokenTtlMs ?? 30 * DAY_MS,
    refreshTokenTtlMs: overrides.refreshTokenTtlMs ?? 180 * DAY_MS,
    indexOnStart: overrides.indexOnStart ?? true,
    webRoot: overrides.webRoot ?? '',
    nativeBinding: overrides.nativeBinding ?? '',
    lan: overrides.lan ?? false,
    lanPort: overrides.lanPort ?? 0,
    lanHosts: overrides.lanHosts ?? [],
    // Default false, and deliberately not derived from `lan`: sharing over the local network
    // must never imply sharing it unencrypted.
    lanPlaintext: overrides.lanPlaintext ?? false,
    lanPlaintextPort: overrides.lanPlaintextPort ?? 0,
    logLevel: overrides.logLevel ?? 'info',
  };
}
