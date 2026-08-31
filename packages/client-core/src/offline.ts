import type { ZodType } from 'zod';
import { decode, LocalCastError, NetworkError } from './errors.js';
import type { CacheStore, Clock, Logger } from './ports.js';

/**
 * The offline library, as policy only.
 *
 * This module decides *what may be shown when the server cannot be reached, and for how
 * long*. It never touches storage — that is the `CacheStore` port, IndexedDB on the PWA and
 * something else everywhere else. Splitting it this way is what keeps the interesting half
 * (the rules below) testable without a database.
 *
 * The rule behind the whole table: a stale answer is acceptable when being wrong means
 * "this list is a few minutes out of date", and unacceptable when being wrong means the user
 * concludes something false — a file was deleted, a job finished, a printer is available.
 */
export type CacheableResource =
  | 'me'
  | 'folders'
  | 'entries'
  | 'file-meta'
  | 'search'
  | 'printers'
  | 'print-jobs';

export interface CachePolicy {
  /** How long a cached value is served without asking the server at all. */
  ttlMs: number;
  /** Whether it may be served past its TTL when the server is unreachable. */
  staleWhileOffline: boolean;
  /** Hard limit on staleness; `null` means "as old as it is, if we are offline". */
  maxStaleMs: number | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CACHE_POLICIES: Record<CacheableResource, CachePolicy> = {
  /**
   * Identity and the permission summary. Safe to show stale — it drives which affordances
   * are rendered, and the server re-reads permissions from SQLite on every request anyway,
   * so a stale `full` here cannot grant anything.
   */
  me: { ttlMs: 15 * MINUTE, staleWhileOffline: true, maxStaleMs: 7 * DAY },

  /** The folder list is the offline library's front door; without it there is no UI at all. */
  folders: { ttlMs: 5 * MINUTE, staleWhileOffline: true, maxStaleMs: 7 * DAY },

  /** Listings age gracefully: a file that has since been renamed simply 404s when opened. */
  entries: { ttlMs: 5 * MINUTE, staleWhileOffline: true, maxStaleMs: 7 * DAY },

  /** Size, kind and playability of one file barely change; this is what the player needs. */
  'file-meta': { ttlMs: HOUR, staleWhileOffline: true, maxStaleMs: 30 * DAY },

  /**
   * Never served stale. An offline search runs against whatever listings happen to be cached
   * and would return *fewer* results than exist, which the user reads as "my file is gone".
   * An honest empty state beats a quietly incomplete answer.
   */
  search: { ttlMs: MINUTE, staleWhileOffline: false, maxStaleMs: null },

  /**
   * Never served stale. Printing needs a live server by definition, and offering a printer
   * that cannot be reached produces a job that fails a second later.
   */
  printers: { ttlMs: MINUTE, staleWhileOffline: false, maxStaleMs: null },

  /**
   * Never cached at all. Job state is the entire content of the screen; a cached "done" is
   * a lie about a physical printer, and the spec insists "انجام‌شده" means the spooler said so.
   */
  'print-jobs': { ttlMs: 0, staleWhileOffline: false, maxStaleMs: null },
};

export type CacheVerdict = 'fresh' | 'stale-ok' | 'expired' | 'miss';

export interface FreshnessInput {
  resource: CacheableResource;
  /** `null` when nothing is cached. */
  storedAt: number | null;
  now: number;
  online: boolean;
}

/**
 * The single decision point. Pure, so the policy table above can be argued about in a test
 * rather than inferred from the behaviour of a cache.
 */
export function evaluate(input: FreshnessInput): CacheVerdict {
  const policy = CACHE_POLICIES[input.resource];
  if (input.storedAt === null) return 'miss';
  const age = input.now - input.storedAt;
  if (policy.ttlMs > 0 && age < policy.ttlMs) return 'fresh';
  if (!input.online && policy.staleWhileOffline) {
    if (policy.maxStaleMs === null || age <= policy.maxStaleMs) return 'stale-ok';
  }
  return 'expired';
}

export interface OfflineCacheOptions {
  store: CacheStore;
  clock: Clock;
  /** How the cache learns whether it is worth going to the network at all. */
  isOnline: () => boolean;
  logger?: Logger;
}

export interface CachedResult<T> {
  value: T;
  /** True when this came from the cache past its TTL — the UI shows "آفلاین" for these. */
  stale: boolean;
}

/**
 * Wraps a fetcher with the policy above.
 *
 * Cached values are re-validated against the same contract schema on the way out. A cache
 * written by an older build of the app is drift just as much as a wrong server response is,
 * and it must not be handed to a component that expects the current shape.
 */
export class OfflineCache {
  readonly #store: CacheStore;
  readonly #clock: Clock;
  readonly #isOnline: () => boolean;
  readonly #logger: Logger | undefined;

  constructor(options: OfflineCacheOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#isOnline = options.isOnline;
    this.#logger = options.logger;
  }

  async read<T>(resource: CacheableResource, key: string, schema: ZodType<T>): Promise<CachedResult<T> | null> {
    const entry = await this.#store.read(this.#key(resource, key));
    if (entry === null) return null;
    const verdict = evaluate({
      resource,
      storedAt: entry.storedAt,
      now: this.#clock.now(),
      online: this.#isOnline(),
    });
    if (verdict === 'miss' || verdict === 'expired') return null;
    try {
      return { value: decode(schema, entry.value, `cache:${resource}`), stale: verdict === 'stale-ok' };
    } catch (error) {
      // A cache written by a previous build is worse than no cache. Drop it and refetch.
      this.#logger?.log('warn', 'discarding a cache entry that no longer matches the contract', {
        resource,
        error,
      });
      await this.#store.delete(this.#key(resource, key));
      return null;
    }
  }

  async write(resource: CacheableResource, key: string, value: unknown): Promise<void> {
    if (CACHE_POLICIES[resource].ttlMs === 0 && !CACHE_POLICIES[resource].staleWhileOffline) {
      // `print-jobs` and friends: writing them would only create something to serve wrongly.
      return;
    }
    await this.#store.write(this.#key(resource, key), { value, storedAt: this.#clock.now() });
  }

  /**
   * Serve from the cache when policy allows, otherwise fetch; and when the fetch fails
   * because nothing could be reached, fall back to a stale copy if the resource permits it.
   * A failure that came *from* the server (403, 404) is never papered over with a cache —
   * that would show a folder an operator has just closed.
   */
  async withCache<T>(
    resource: CacheableResource,
    key: string,
    schema: ZodType<T>,
    fetcher: () => Promise<T>,
  ): Promise<CachedResult<T>> {
    const cached = await this.read(resource, key, schema);
    if (cached !== null && !cached.stale) return cached;

    try {
      const value = await fetcher();
      await this.write(resource, key, value);
      return { value, stale: false };
    } catch (error) {
      const unreachable = error instanceof NetworkError;
      if (unreachable && cached !== null) return cached;
      if (unreachable) {
        const fallback = await this.#staleFallback(resource, key, schema);
        if (fallback !== null) return fallback;
      }
      throw error;
    }
  }

  async invalidate(resource: CacheableResource, key: string): Promise<void> {
    await this.#store.delete(this.#key(resource, key));
  }

  /** Called on sign-out: an offline library belonging to a revoked device must not survive. */
  async clear(): Promise<void> {
    await this.#store.clear();
  }

  /**
   * Re-read ignoring the online flag, for the moment a request has just proved we are not.
   * `read()` above may have been called while the app still believed it was online.
   */
  async #staleFallback<T>(
    resource: CacheableResource,
    key: string,
    schema: ZodType<T>,
  ): Promise<CachedResult<T> | null> {
    const policy = CACHE_POLICIES[resource];
    if (!policy.staleWhileOffline) return null;
    const entry = await this.#store.read(this.#key(resource, key));
    if (entry === null) return null;
    const age = this.#clock.now() - entry.storedAt;
    if (policy.maxStaleMs !== null && age > policy.maxStaleMs) return null;
    try {
      return { value: decode(schema, entry.value, `cache:${resource}`), stale: true };
    } catch (error) {
      if (error instanceof LocalCastError) return null;
      throw error;
    }
  }

  #key(resource: CacheableResource, key: string): string {
    return `${resource}:${key}`;
  }
}
