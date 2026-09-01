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
    logLevel: overrides.logLevel ?? 'info',
  };
}
