/**
 * The reason this app has a hand-written service worker at all.
 *
 * `<video src>` cannot send an `Authorization` header. There is no attribute for it, no
 * property, no event — the element simply issues its own requests, and the byte-range
 * requests it issues while you scrub a 4K file are the ones that must carry the bearer.
 * `client-core`'s `contentUrl()` therefore returns a bare URL on purpose, and this module is
 * the other half of that decision: a `fetch` handler that recognises the two media prefixes
 * and puts the token on.
 *
 * Two rules govern everything below, and both are the sort that fail silently when broken:
 *
 *  1. **Never cache, never reconstruct.** A Range request answered from a cached `200` is a
 *     full-file body served where 206 + `Content-Range` was expected, and Safari's response
 *     is to make the timeline unseekable. So the media branch touches no `Cache`, reads no
 *     `caches`, and returns the network's own `Response` object untouched.
 *  2. **Rebuild the request rather than clone it.** A media element issues its request in
 *     `no-cors` mode, whose header guard silently drops anything that is not
 *     CORS-safelisted — `Authorization` included. `new Request(original, { headers })`
 *     inherits that mode and would therefore appear to work while sending nothing. The
 *     request is rebuilt at `same-origin` instead, which is what it actually is.
 */

/**
 * Copied from `@localcast/contract`'s `API_PREFIX` / `DAV_PREFIX` rather than imported.
 *
 * Importing the contract would pull zod into the service-worker bundle for two string
 * constants. `media.test.ts` asserts these still equal the contract's values, so the
 * duplication cannot drift without a test failing.
 */
export const SW_API_PREFIX = '/api/v1';
export const SW_DAV_PREFIX = '/dav';

/** `/api/v1/files/<id>/content` — the Range endpoint, and nothing else under `/files`. */
const CONTENT_PATH = new RegExp(`^${SW_API_PREFIX}/files/[^/]+/content$`);

/**
 * Which requests get a bearer.
 *
 * Same-origin only. A cross-origin URL that happens to end in `/content` belongs to somebody
 * else, and attaching this device's access token to it would hand the token away — the one
 * mistake in this file that is a security bug rather than a playback bug.
 */
export function isProtectedMediaUrl(url: URL, origin: string): boolean {
  if (url.origin !== origin) return false;
  if (CONTENT_PATH.test(url.pathname)) return true;
  return url.pathname === SW_DAV_PREFIX || url.pathname.startsWith(`${SW_DAV_PREFIX}/`);
}

export interface MediaFetchDeps {
  /** The scope's own origin; passed in so the module never reads a global. */
  origin: string;
  /** The access token as last persisted by the page, or `null` when unpaired. */
  getToken(): Promise<string | null>;
  /** Drop any memoised token, so the next `getToken()` re-reads the store. */
  invalidateToken(): void;
  fetch: typeof globalThis.fetch;
}

/**
 * Rebuild a request with the bearer attached, preserving everything the player asked for —
 * `Range` above all. The header bag is copied verbatim first, so a future request header this
 * code has never heard of survives untouched.
 */
export function withBearer(request: Request, token: string | null): Request {
  const headers = new Headers();
  request.headers.forEach((value, key) => headers.set(key, value));
  if (token !== null) headers.set('authorization', `Bearer ${token}`);

  return new Request(request.url, {
    method: request.method,
    headers,
    // Explicit, not inherited: see rule 2 above.
    mode: 'same-origin',
    // The device API is bearer-authenticated. Ambient cookies would only widen the surface of
    // an origin that may be published through Funnel.
    credentials: 'omit',
    redirect: 'follow',
    // Scrubbing abandons dozens of in-flight range requests; propagating the abort is what
    // lets the server destroy its read streams instead of running out of descriptors.
    signal: request.signal,
  });
}

/**
 * Fetch a media request with the bearer, retrying exactly once on a 401.
 *
 * The retry exists because the token in the store moves underneath us: the page refreshes it
 * five minutes before expiry, and a film playing for two hours will cross that boundary
 * several times. The service worker cannot run the refresh itself — that would race the
 * page's single-flight gate and burn a rotating refresh token — so it does the only correct
 * thing available to it: forgets what it had memoised and reads the store again.
 *
 * Once, not in a loop. A second 401 with a freshly read token means the device was revoked,
 * and the player is supposed to surface «دسترسی بسته شد» rather than retry for ever.
 */
export async function fetchMedia(request: Request, deps: MediaFetchDeps): Promise<Response> {
  const token = await deps.getToken();
  const response = await deps.fetch(withBearer(request, token));
  if (response.status !== 401) return response;

  deps.invalidateToken();
  const fresh = await deps.getToken();
  if (fresh === null || fresh === token) return response;

  // Release the rejected body rather than leaving it dangling on a connection.
  await response.body?.cancel().catch(() => undefined);
  return deps.fetch(withBearer(request, fresh));
}

/**
 * The media branch of the service worker's router.
 *
 * Returns `null` for anything it does not own, which the caller reads as "do not call
 * `respondWith`" — letting the browser handle the request exactly as it would with no service
 * worker installed. That default matters: it is what keeps a bug here from turning into a
 * blank app rather than a missing feature.
 */
export function routeMedia(request: Request, deps: MediaFetchDeps): Promise<Response> | null {
  // `GET` and `HEAD` are the only methods the Range endpoint serves; WebDAV's PROPFIND and
  // friends are read-only too but are issued by native clients, never through this worker.
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (!isProtectedMediaUrl(url, deps.origin)) return null;

  return fetchMedia(request, deps);
}

/**
 * Read the access token straight out of the session record, memoised briefly.
 *
 * A two-second memo, because a seek fires a burst of range requests within a few hundred
 * milliseconds and an IndexedDB round trip on each one is latency the player pays for
 * nothing. Anything longer would delay a refreshed token past the point where the old one
 * starts 401ing, and the retry above would then do the work on every request.
 */
export function createTokenReader(
  read: () => Promise<{ accessToken: string } | null>,
  now: () => number = () => Date.now(),
  ttlMs = 2_000,
): Pick<MediaFetchDeps, 'getToken' | 'invalidateToken'> {
  let cached: { token: string | null; at: number } | null = null;
  let inFlight: Promise<string | null> | null = null;

  return {
    async getToken(): Promise<string | null> {
      if (cached !== null && now() - cached.at < ttlMs) return cached.token;
      // Single-flight: a burst of range requests on a cold worker must produce one read.
      inFlight ??= read()
        .then((session) => {
          const token = session?.accessToken ?? null;
          cached = { token, at: now() };
          return token;
        })
        .catch(() => null)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    invalidateToken(): void {
      cached = null;
    },
  };
}
