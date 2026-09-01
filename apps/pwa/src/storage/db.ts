/**
 * The one IndexedDB database this app owns, and the names both sides of it agree on.
 *
 * "Both sides" is the point of this file. The page writes the session here through
 * `IdbTokenStore`; the **service worker** reads it back to put a bearer on `<video>` range
 * requests. A service worker is killed and restarted constantly, so it cannot be handed the
 * token once over `postMessage` and trusted to still have it twenty minutes into a film —
 * it has to be able to go and look. That means the store names below are a contract, not an
 * implementation detail, and they live in a module with no DOM imports so the worker bundle
 * can include it.
 */

export const DB_NAME = 'localcast';
export const DB_VERSION = 1;

/** One row, keyed by `SESSION_KEY`, holding the whole `StoredSession`. */
export const SESSION_STORE = 'session';
export const SESSION_KEY = 'current';

/** The offline library: one row per `CacheStore` key. */
export const CACHE_STORE = 'cache';

/**
 * Opened with the raw IndexedDB API rather than `idb`.
 *
 * `idb` is a dependency and would be pleasanter, but this module is imported by the service
 * worker, and keeping the worker's dependency graph at zero is worth forty lines: the SW is
 * the one piece of this app that, if it fails to parse, takes playback down with no error
 * message anywhere a user can see it.
 */
export function openLocalCastDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
    // Another tab holds an older version open. Rejecting is right: retrying would hang.
    request.onblocked = () => reject(new Error('the LocalCast database is blocked by another tab'));
  });
}

function run<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
  const tx = db.transaction(store, 'readonly');
  const value = await run<T | undefined>(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
  return value ?? null;
}

export async function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  await run(tx.objectStore(store).put(value, key));
}

export async function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  await run(tx.objectStore(store).delete(key));
}

export async function idbClear(db: IDBDatabase, store: string): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  await run(tx.objectStore(store).clear());
}
