import type { CacheEntry, CacheStore } from '@localcast/client-core';
import { CACHE_STORE, idbClear, idbDelete, idbGet, idbPut, openLocalCastDb } from './db.js';

/**
 * `CacheStore` on IndexedDB — the bytes half of the offline library.
 *
 * All the interesting decisions (what may be served stale, and for how long) live in
 * `client-core`'s `OfflineCache`. This class knows nothing about freshness and must not
 * learn: the moment a store starts making policy, the policy exists in two places.
 */
export class IdbCacheStore implements CacheStore {
  #db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  async read(key: string): Promise<CacheEntry | null> {
    const db = await this.#open();
    return idbGet<CacheEntry>(db, CACHE_STORE, key);
  }

  async write(key: string, entry: CacheEntry): Promise<void> {
    const db = await this.#open();
    await idbPut(db, CACHE_STORE, key, entry);
  }

  async delete(key: string): Promise<void> {
    const db = await this.#open();
    await idbDelete(db, CACHE_STORE, key);
  }

  async clear(): Promise<void> {
    const db = await this.#open();
    await idbClear(db, CACHE_STORE);
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= openLocalCastDb(this.factory).catch((error: unknown) => {
      this.#db = null;
      throw error;
    });
    return this.#db;
  }
}

/** The no-IndexedDB fallback. An offline library that lives for one tab is still a library. */
export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, CacheEntry>();

  read(key: string): Promise<CacheEntry | null> {
    return Promise.resolve(this.#entries.get(key) ?? null);
  }

  write(key: string, entry: CacheEntry): Promise<void> {
    this.#entries.set(key, entry);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#entries.clear();
    return Promise.resolve();
  }
}
