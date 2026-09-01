import { createHash, scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Database } from 'better-sqlite3';
import type { DeviceIdentity } from '../../kernel.js';

/**
 * Basic-auth verification for the WebDAV mount.
 *
 * The scrypt code is duplicated from `src/auth` rather than imported. The kernel seam says a
 * module may import from `kernel.ts` and from the contract and nothing else, and this is the
 * only credential a module has to check for itself — WebDAV has no bearer token to hand to
 * the core auth middleware. The stored encoding is fixed by the database, not by either
 * implementation: `scrypt$N$r$p$<salt b64>$<key b64>`.
 */

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 32;
const SALT_LEN = 16;
// Node's default maxmem (32 MiB) sits just under 128 * N * r; state it rather than tune N down.
const MAXMEM = 64 * 1024 * 1024;

export async function hashDavPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyDavPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 0 || r <= 0 || p <= 0) return false;

  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    // Absurd parameters in a corrupt row must read as "wrong password", not crash a request.
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface BasicCredentials {
  user: string;
  pass: string;
}

export function parseBasicAuth(header: string | undefined): BasicCredentials | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match || match[1] === undefined) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  // The password may itself contain colons; only the first one separates.
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  status: string;
  token_version: number;
  dav_password_hash: string | null;
}

/**
 * scrypt is deliberately expensive — roughly 60 ms here. Infuse opens a dozen concurrent
 * range requests to seek one file, and iOS Files re-authenticates every PROPFIND, so paying
 * that per request turns a scrub into a stall.
 *
 * The cache holds only the *result* of the KDF. Every request still reads the device row, so
 * a device whose status flips to `revoked`, or whose password hash is rotated, is locked out
 * on its very next request — the property the panel's "بستن" button depends on.
 */
interface CacheEntry {
  hash: string;
  passwordDigest: string;
  expiresAt: number;
}

export interface DavAuthenticatorOptions {
  ttlMs?: number;
  now?: () => number;
}

export type DavAuthResult =
  | { ok: true; device: DeviceIdentity }
  | { ok: false; reason: 'missing' | 'bad-credentials' | 'not-active' };

export class DavAuthenticator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    options: DavAuthenticatorOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  async authenticate(authorization: string | undefined): Promise<DavAuthResult> {
    const credentials = parseBasicAuth(authorization);
    if (!credentials) return { ok: false, reason: 'missing' };

    const row = this.db
      .prepare(
        `SELECT id, user_id, name, platform, status, token_version, dav_password_hash
           FROM devices WHERE id = ?`,
      )
      .get(credentials.user) as DeviceRow | undefined;

    // An unknown device id and a wrong password are the same answer on the wire: the mount
    // must not be usable to enumerate which device ids exist.
    if (!row || !row.dav_password_hash) return { ok: false, reason: 'bad-credentials' };
    if (row.status !== 'active') return { ok: false, reason: 'not-active' };

    if (!(await this.check(row, credentials.pass))) return { ok: false, reason: 'bad-credentials' };

    return {
      ok: true,
      device: {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        platform: row.platform,
        tokenVersion: row.token_version,
      },
    };
  }

  private async check(row: DeviceRow, password: string): Promise<boolean> {
    const stored = row.dav_password_hash;
    if (!stored) return false;
    const digest = createHash('sha256').update(password, 'utf8').digest('hex');
    const cached = this.cache.get(row.id);
    if (
      cached &&
      cached.expiresAt > this.now() &&
      cached.hash === stored &&
      timingSafeEqual(Buffer.from(cached.passwordDigest, 'hex'), Buffer.from(digest, 'hex'))
    ) {
      return true;
    }

    const valid = await verifyDavPassword(password, stored);
    if (valid) {
      this.cache.set(row.id, { hash: stored, passwordDigest: digest, expiresAt: this.now() + this.ttlMs });
    } else {
      this.cache.delete(row.id);
    }
    return valid;
  }

  /** Drops every cached verification. Used on shutdown so credentials do not outlive the run. */
  clear(): void {
    this.cache.clear();
  }
}
