import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoredSession, TokenStore } from '@localcast/client-core';

/**
 * Contribution #1 of two: the Electron-flavoured `TokenStore`.
 *
 * `client-core` defines the port and nothing else; every platform brings the store its
 * operating system actually offers. On Windows that is DPAPI through Electron's
 * `safeStorage`, which ties the ciphertext to the logged-in user account. IndexedDB — the
 * PWA's answer — would be the wrong home here: it is readable by anything with the profile
 * directory, and a desktop has a real keyring sitting unused next to it.
 *
 * One file holds every server's session, each under its own key, and a store handed to one
 * server's client can only read and write that server's key. Session separation is therefore
 * structural rather than a rule someone has to remember: there is no code path through which
 * server A's client can name server B's key.
 */

export interface SecretCodec {
  /** False when the OS refused to provide encrypted storage. */
  available(): boolean;
  /** @returns base64 ciphertext. */
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

interface VaultFile {
  version: 1;
  /** serverId → base64 DPAPI ciphertext of one `StoredSession`. */
  sessions: Record<string, string>;
}

const EMPTY: VaultFile = { version: 1, sessions: {} };

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<StoredSession>;
  return (
    typeof s.deviceId === 'string' &&
    typeof s.accessToken === 'string' &&
    typeof s.refreshToken === 'string' &&
    typeof s.expiresAt === 'number' &&
    typeof s.host === 'string' &&
    typeof s.davPassword === 'string'
  );
}

export class SecretStorageUnavailable extends Error {
  constructor() {
    super(
      'Windows refused to provide encrypted storage, and LocalCast will not fall back to ' +
        'writing a device token to disk in the clear.',
    );
    this.name = 'SecretStorageUnavailable';
  }
}

/**
 * The file, the codec, and a factory for the per-server views onto it.
 *
 * The whole file is re-read before each mutation rather than cached: a second window, or a
 * refresh that landed while another server's client was writing, must not blow away a
 * neighbour's key. The file is tiny — a handful of ciphertext blobs — so the read costs
 * nothing worth optimising away.
 */
export class SessionVault {
  readonly #path: string;
  readonly #codec: SecretCodec;

  constructor(path: string, codec: SecretCodec) {
    this.#path = path;
    this.#codec = codec;
  }

  /** A `TokenStore` bound to exactly one server. */
  storeFor(serverId: string): TokenStore {
    return {
      read: async () => this.read(serverId),
      write: async (session) => {
        this.write(serverId, session);
      },
      clear: async () => {
        this.clear(serverId);
      },
    };
  }

  /** Which servers currently hold a session. Screen 05 uses this to pick `needs-pairing`. */
  pairedServerIds(): string[] {
    return Object.keys(this.#load().sessions);
  }

  read(serverId: string): StoredSession | null {
    const blob = this.#load().sessions[serverId];
    if (blob === undefined) return null;
    let plaintext: string;
    try {
      plaintext = this.#codec.decrypt(blob);
    } catch {
      // Written under a different Windows profile, or the DPAPI master key was reset. The
      // token is gone for good; report "not paired" so the UI offers the code entry rather
      // than looping on a decrypt that will never succeed.
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return null;
    }
    return isStoredSession(parsed) ? parsed : null;
  }

  write(serverId: string, session: StoredSession): void {
    if (!this.#codec.available()) throw new SecretStorageUnavailable();
    const file = this.#load();
    file.sessions[serverId] = this.#codec.encrypt(JSON.stringify(session));
    this.#save(file);
  }

  clear(serverId: string): void {
    const file = this.#load();
    if (!(serverId in file.sessions)) return;
    delete file.sessions[serverId];
    this.#save(file);
  }

  #load(): VaultFile {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return { ...EMPTY, sessions: {} };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<VaultFile>;
      const sessions = parsed.sessions;
      if (typeof sessions !== 'object' || sessions === null) return { ...EMPTY, sessions: {} };
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(sessions)) {
        if (typeof value === 'string') clean[key] = value;
      }
      return { version: 1, sessions: clean };
    } catch {
      // A hand-edited or truncated vault should cost the user their pairings, not the app's
      // ability to start — they can pair again in four keystrokes.
      return { ...EMPTY, sessions: {} };
    }
  }

  #save(file: VaultFile): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    // Rename over the original: a crash mid-write must not leave a half-written vault that
    // signs every paired server out at once.
    renameSync(tmp, this.#path);
  }
}
