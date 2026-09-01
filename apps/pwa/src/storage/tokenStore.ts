import type { StoredSession, TokenStore } from '@localcast/client-core';
import {
  DB_NAME,
  SESSION_KEY,
  SESSION_STORE,
  idbClear,
  idbGet,
  idbPut,
  openLocalCastDb,
} from './db.js';

/**
 * `TokenStore` on IndexedDB.
 *
 * IndexedDB rather than `localStorage` for one reason that matters and one that follows from
 * it: a service worker cannot read `localStorage` at all, and the service worker is what puts
 * the bearer on media requests. The whole session is written as a single record, as
 * `StoredSession` intends — a half-written refresh that updated the access token but not the
 * refresh token would strand the device permanently.
 */
export class IdbTokenStore implements TokenStore {
  #db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  async read(): Promise<StoredSession | null> {
    const db = await this.#open();
    return idbGet<StoredSession>(db, SESSION_STORE, SESSION_KEY);
  }

  async write(session: StoredSession): Promise<void> {
    const db = await this.#open();
    await idbPut(db, SESSION_STORE, SESSION_KEY, session);
  }

  async clear(): Promise<void> {
    const db = await this.#open();
    await idbClear(db, SESSION_STORE);
  }

  #open(): Promise<IDBDatabase> {
    // Memoised, but the memo is dropped on failure so a transient open error (a blocking tab
    // that has since gone away) does not poison every later read for the life of the page.
    this.#db ??= openLocalCastDb(this.factory).catch((error: unknown) => {
      this.#db = null;
      throw error;
    });
    return this.#db;
  }
}

/**
 * An in-memory `TokenStore` for the private-browsing case.
 *
 * Safari in a private window throws on `indexedDB.open`. Pairing still has to work there —
 * the session simply does not survive the tab. Silently degrading is right here: the
 * alternative is an app that shows a database error on a screen whose whole job is to scan a
 * QR code.
 */
export class MemoryTokenStore implements TokenStore {
  #session: StoredSession | null = null;

  read(): Promise<StoredSession | null> {
    return Promise.resolve(this.#session);
  }

  write(session: StoredSession): Promise<void> {
    this.#session = session;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#session = null;
    return Promise.resolve();
  }
}

/** True when IndexedDB is present and usable at all. */
export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null && DB_NAME.length > 0;
  } catch {
    return false;
  }
}
