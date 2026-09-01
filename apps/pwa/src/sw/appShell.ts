import { SW_API_PREFIX, SW_DAV_PREFIX } from './media.js';

/**
 * The app shell: enough of the build precached that opening LocalCast from the home screen
 * with no server in reach lands on the offline library rather than on Safari's error page.
 *
 * What is deliberately *not* here is as important as what is. Nothing under `/api/` or
 * `/dav/` is ever cached or even intercepted by this half of the worker. Listings, metadata
 * and their staleness rules belong to `client-core`'s `OfflineCache`, which knows that a
 * stale printer list is a lie and a stale folder list is not; a Cache Storage entry keyed by
 * URL knows none of that and would happily serve a print job as "done".
 */

export const SHELL_CACHE_PREFIX = 'localcast-shell-';

/** The document every navigation falls back to. The app is a hash router, so one is enough. */
export const APP_SHELL_URL = '/index.html';

export interface ShellDeps {
  origin: string;
  cacheName: string;
  caches: CacheStorage;
  fetch: typeof globalThis.fetch;
}

/**
 * Fill the cache on install.
 *
 * `cache.addAll` is deliberately not used: it rejects the whole batch if any single entry
 * 404s, which turns one renamed asset into a service worker that never installs and an app
 * that never updates. Failures are counted and reported instead.
 */
export async function precache(deps: ShellDeps, urls: readonly string[]): Promise<number> {
  const cache = await deps.caches.open(deps.cacheName);
  let failed = 0;
  await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await deps.fetch(new Request(url, { cache: 'reload' }));
        if (!response.ok) {
          failed += 1;
          return;
        }
        await cache.put(url, response);
      } catch {
        failed += 1;
      }
    }),
  );
  return failed;
}

/** Drop every shell cache but the current one, so an update does not leave the old build behind. */
export async function dropStaleCaches(deps: ShellDeps): Promise<string[]> {
  const names = await deps.caches.keys();
  const stale = names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== deps.cacheName);
  await Promise.all(stale.map((name) => deps.caches.delete(name)));
  return stale;
}

/** Requests this worker must keep its hands off entirely. */
export function isApiPath(pathname: string): boolean {
  return (
    pathname === SW_API_PREFIX ||
    pathname.startsWith(`${SW_API_PREFIX}/`) ||
    pathname === SW_DAV_PREFIX ||
    pathname.startsWith(`${SW_DAV_PREFIX}/`)
  );
}

/**
 * The shell branch of the router.
 *
 * Navigations are network-first so a deployed update is picked up on the next launch, with
 * the precached document as the fallback that makes the offline screen possible at all.
 * Everything else same-origin is cache-first, because the build's assets are content-hashed
 * and a hit is therefore always correct.
 */
export function routeAppShell(request: Request, deps: ShellDeps): Promise<Response> | null {
  if (request.method !== 'GET') return null;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.origin !== deps.origin) return null;
  if (isApiPath(url.pathname)) return null;

  if (request.mode === 'navigate') return navigate(request, deps);
  return staticAsset(request, deps);
}

async function navigate(request: Request, deps: ShellDeps): Promise<Response> {
  try {
    const response = await deps.fetch(request);
    // Only a real document is worth keeping; a 5xx from a half-started server is not.
    if (response.ok) {
      const cache = await deps.caches.open(deps.cacheName);
      await cache.put(APP_SHELL_URL, response.clone());
    }
    return response;
  } catch {
    const cached = await caughtMatch(deps, APP_SHELL_URL);
    if (cached !== undefined) return cached;
    // No shell yet — the very first launch, offline. Say so in the app's own language rather
    // than handing back the browser's English error page.
    return new Response(
      '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">' +
        '<title>LocalCast</title><body style="background:#08090b;color:#c9ced6;font-family:system-ui;padding:24px">' +
        '<p>ارتباط با سرور برقرار نیست.</p></body></html>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

async function staticAsset(request: Request, deps: ShellDeps): Promise<Response> {
  const cached = await caughtMatch(deps, request);
  if (cached !== undefined) return cached;

  const response = await deps.fetch(request);
  // Opaque and partial responses are never stored: an opaque body cannot be validated, and a
  // 206 in a cache is the very failure mode this worker exists to avoid.
  if (response.ok && response.type !== 'opaque' && response.status === 200) {
    const cache = await deps.caches.open(deps.cacheName);
    await cache.put(request, response.clone());
  }
  return response;
}

async function caughtMatch(deps: ShellDeps, request: RequestInfo): Promise<Response | undefined> {
  try {
    const cache = await deps.caches.open(deps.cacheName);
    return await cache.match(request);
  } catch {
    return undefined;
  }
}
