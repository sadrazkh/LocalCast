import { useCallback, useSyncExternalStore } from 'react';

/**
 * A hash router, in forty lines, because the alternative is worse here.
 *
 * The PWA is served from a static root by the Node server, and a path router would need that
 * server to rewrite every unknown path to `index.html`. It mostly would — but "mostly" means
 * a cold launch straight to `/play/abc123` from the home screen returns a 404 from whatever
 * is in front of it that day, and the app that opens is the browser's error page. A hash
 * never leaves the client, so `#/play/abc123` is one document request for `/` and cannot be
 * routed wrong by anything in between.
 *
 * `react-router` would also work and would weigh more than this file by two orders of
 * magnitude; the rule for this app is no UI framework beyond `ui-kit`.
 */

export interface RouteMatch {
  /** Leading slash, no trailing slash, no query — e.g. `/library/f1`. */
  readonly path: string;
  /** `['library', 'f1']`, already percent-decoded. */
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  /** The whole thing, for keys and comparisons. */
  readonly href: string;
}

export const DEFAULT_ROUTE = '/library';

export function parseHash(rawHash: string): RouteMatch {
  const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  const withoutLeadingSlash = hash.length === 0 || hash === '/' ? DEFAULT_ROUTE : hash;
  const queryAt = withoutLeadingSlash.indexOf('?');
  const rawPath = queryAt < 0 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, queryAt);
  const rawQuery = queryAt < 0 ? '' : withoutLeadingSlash.slice(queryAt + 1);

  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A hand-edited URL with a stray `%` must land on a route, not throw during render.
        return segment;
      }
    });

  return {
    path: path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path,
    segments,
    query: new URLSearchParams(rawQuery),
    href: `#${path}${rawQuery.length > 0 ? `?${rawQuery}` : ''}`,
  };
}

export function buildHref(path: string, query?: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const suffix = search.toString();
  return `#${path}${suffix.length > 0 ? `?${suffix}` : ''}`;
}

export function navigate(
  path: string,
  options: { query?: Record<string, string | number | undefined>; replace?: boolean } = {},
): void {
  const href = buildHref(path, options.query);
  if (options.replace === true) {
    window.history.replaceState(null, '', href);
    // `replaceState` does not fire `hashchange`, so the store has to be poked by hand.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = href.slice(1);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

// `useSyncExternalStore` needs a stable snapshot, and `parseHash` builds a fresh object every
// call — which would loop for ever. The raw hash string is the snapshot; parsing happens in
// the hook body, where a new object per render is harmless.
function snapshot(): string {
  return window.location.hash;
}

export function useRoute(): RouteMatch {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '');
  return parseHash(hash);
}

export function useNavigate(): typeof navigate {
  return useCallback(navigate, []);
}
