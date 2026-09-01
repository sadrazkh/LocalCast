import { SHELL_CACHE_PREFIX, dropStaleCaches, precache } from './sw/appShell.js';
import { routeRequest } from './sw/router.js';
import type { SwDeps } from './sw/router.js';
import { createTokenReader } from './sw/media.js';
import { SESSION_KEY, SESSION_STORE, idbGet, openLocalCastDb } from './storage/db.js';

/**
 * The LocalCast service worker.
 *
 * It is hand-written rather than generated because the one thing it has to do — put a bearer
 * on `<video>` range requests — is the one thing a caching strategy cannot express. Everything
 * else here is deliberately conservative: precache the shell, serve it when the network is
 * gone, and decline to answer anything else.
 *
 * Build wiring: this file is written for `vite-plugin-pwa`'s `injectManifest` strategy, which
 * replaces `self.__WB_MANIFEST` with the build's asset list. The reference is guarded so the
 * worker still installs (with an empty shell cache) under any other configuration, rather
 * than throwing at the top level and leaving the app with no worker at all.
 */

// The worker's globals, declared locally. The app's tsconfig enables both `DOM` and
// `WebWorker`, and reaching for the ambient `ServiceWorkerGlobalScope` from a file that also
// sees `DOM` is how a build starts failing on a lib conflict that has nothing to do with the
// code. A five-line structural type costs nothing and cannot conflict with anything.
interface PrecacheEntry {
  url: string;
  revision?: string | null;
}

interface WorkerScope {
  readonly location: { origin: string };
  readonly caches: CacheStorage;
  readonly clients: { claim(): Promise<void> };
  __WB_MANIFEST?: readonly PrecacheEntry[];
  skipWaiting(): Promise<void>;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void,
  ): void;
  addEventListener(
    type: 'fetch',
    listener: (event: { request: Request; respondWith(response: Promise<Response>): void }) => void,
  ): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

/**
 * `__WB_MANIFEST` is a build-time substitution, and Workbox finds its injection point by
 * searching the emitted bundle for the literal text `self.__WB_MANIFEST`. Reading it through
 * the `scope` alias used everywhere else in this file emits `scope.__WB_MANIFEST`, which
 * matches nothing and fails the build with a message about swSrc and swDest — so this one
 * read goes through `self` on purpose.
 */
declare const self: WorkerScope;
const manifest: readonly PrecacheEntry[] = self.__WB_MANIFEST ?? [];

/**
 * Cache name derived from the manifest itself.
 *
 * Every build produces different revisions, so the name changes with the build and
 * `dropStaleCaches` retires the previous one on activate. Deriving it beats hard-coding a
 * version somebody has to remember to bump.
 */
const CACHE_NAME = `${SHELL_CACHE_PREFIX}${fingerprint(manifest)}`;

function fingerprint(entries: readonly PrecacheEntry[]): string {
  let hash = 2166136261;
  for (const entry of entries) {
    const text = `${entry.url}@${entry.revision ?? ''}`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36);
}

const tokens = createTokenReader(async () => {
  const db = await openLocalCastDb();
  return idbGet<{ accessToken: string }>(db, SESSION_STORE, SESSION_KEY);
});

const deps: SwDeps = {
  origin: scope.location.origin,
  caches: scope.caches,
  cacheName: CACHE_NAME,
  fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  getToken: tokens.getToken,
  invalidateToken: tokens.invalidateToken,
};

scope.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await precache(deps, manifest.map((entry) => entry.url));
      // Take over immediately. A phone that has just been handed a new build should not have
      // to be closed from the app switcher before playback stops 401ing on an old token path.
      await scope.skipWaiting();
    })(),
  );
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await dropStaleCaches(deps);
      await scope.clients.claim();
    })(),
  );
});

scope.addEventListener('fetch', (event) => {
  const handled = routeRequest(event.request, deps);
  // No `respondWith` for anything this worker does not own: the request then behaves exactly
  // as it would with no worker installed, which is the correct failure mode for a file whose
  // job is to add a header.
  if (handled !== null) event.respondWith(handled);
});

scope.addEventListener('message', (event) => {
  // The page tells the worker when it has just rotated the access token, so the next range
  // request re-reads the store instead of waiting out the memo.
  if (typeof event.data === 'object' && event.data !== null && 'type' in event.data) {
    if ((event.data as { type: unknown }).type === 'localcast:session-changed') {
      tokens.invalidateToken();
    }
  }
});
