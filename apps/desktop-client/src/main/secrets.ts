import { safeStorage } from 'electron';
import type { SecretCodec } from './tokenStore.js';

/**
 * The one module in this app that touches Electron's `safeStorage`.
 *
 * It is separated from `SessionVault` so the vault's behaviour — atomic writes, per-server
 * key isolation, tolerance of an unreadable blob — can be tested without an Electron runtime,
 * and so there is exactly one place to look when asking "where does the device token get
 * encrypted".
 *
 * `safeStorage` is only usable after `app.whenReady()`, so nothing here runs at import time.
 */
export function electronSecretCodec(): SecretCodec {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString('base64'),
    decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext, 'base64')),
  };
}
