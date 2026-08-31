import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';

/**
 * Every secret LocalCast holds at rest goes through here.
 *
 * The Headscale pre-auth key, the DNS provider token and the JWT signing key are all stored
 * as DPAPI ciphertext, so a copy of the database or the config file taken off the machine is
 * useless. `config.json` never contains a secret in any form.
 *
 * `safeStorage` is only usable after the `ready` event, so nothing here may run at import
 * time — every function checks and fails loudly rather than silently writing plaintext.
 */

export class SecretStorageUnavailable extends Error {
  constructor() {
    super(
      'The operating system refused to provide encrypted storage. LocalCast will not fall ' +
        'back to writing secrets in the clear.',
    );
    this.name = 'SecretStorageUnavailable';
  }
}

function assertAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new SecretStorageUnavailable();
}

/** @returns base64 ciphertext safe to put in SQLite or a config file. */
export function encryptSecret(plaintext: string): string {
  assertAvailable();
  return safeStorage.encryptString(plaintext).toString('base64');
}

export function decryptSecret(ciphertext: string): string {
  assertAvailable();
  return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
}

/**
 * Decrypts without throwing, for the paths that must keep working when a secret was written
 * under a different Windows user profile and can no longer be decrypted. The caller treats
 * `null` as "no key configured" and asks the user for it again.
 */
export function tryDecryptSecret(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

/**
 * The HMAC key that signs device access tokens. Generated once and then stable: regenerating
 * it would sign every paired device out, which is exactly what must NOT happen when the user
 * switches between the default coordination server and their own Headscale.
 */
export function ensureSigningKey(read: () => string | null, write: (enc: string) => void): Buffer {
  const existing = tryDecryptSecret(read());
  if (existing) return Buffer.from(existing, 'base64');

  const key = randomBytes(32);
  write(encryptSecret(key.toString('base64')));
  return key;
}

/**
 * The shared secret proving a request arrived through `netedge` rather than from something
 * else on the machine pointing a browser at loopback. It is per-run and never persisted —
 * there is nothing to steal from disk, and a restart invalidates any leaked copy.
 */
export function mintEdgeSecret(): string {
  return randomBytes(32).toString('hex');
}
