import {
  randomBytes,
  scrypt as scryptCb,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt from `node:crypto` rather than argon2. argon2 is the better KDF, but it is a
 * native addon that has to be rebuilt for every Electron ABI on every Windows build agent,
 * and the only things hashed here are a WebDAV password and a pairing secret we generated
 * ourselves — both high-entropy, neither a human-chosen password worth an argon2 dependency.
 */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 32;
const SALT_LEN = 16;
// Node's default maxmem (32 MiB) is just under 128 * N * r; state it rather than tune N down.
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Same format, blocking. Only for the operator's own actions (minting a pairing code), which
 * happen on a click and would otherwise force the whole call chain async for one 60 ms hash.
 * Never call this on a request path.
 */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(password, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Length-independent constant-time comparison. `timingSafeEqual` throws on a length
 * mismatch, which would itself be a timing signal, so both sides are digested first.
 */
export function secureEquals(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * For values we generated with 256 bits of entropy — refresh tokens, claim tickets. There is
 * no dictionary to attack, so a KDF would only slow down every request for no gain.
 */
export function fastHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const DAV_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The one-time WebDAV password. Typed by hand into the iOS Files app, so it avoids
 * characters that are ambiguous in that context and stays free of URL-significant bytes.
 */
export function generateDavPassword(length = 20): string {
  return randomString(DAV_ALPHABET, length);
}

/**
 * Rejection sampling rather than `byte % alphabet.length`: a plain modulo over-represents
 * the first `256 % n` characters, which is a real bias when the alphabet is a code the user
 * may only ever see once.
 */
export function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes((length - out.length) * 2)) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}
