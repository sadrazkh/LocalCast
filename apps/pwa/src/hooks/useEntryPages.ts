import { useCallback, useEffect, useRef, useState } from 'react';
import { entriesResponseSchema } from '@localcast/contract';
import type { Entry, Folder } from '@localcast/contract';
import { useClient } from '../client/ClientProvider.js';

export interface EntryPages {
  folder: Folder | null;
  entries: Entry[];
  loading: boolean;
  loadingMore: boolean;
  /** True once the server has said there is no next cursor. */
  complete: boolean;
  /** The listing came from the offline cache past its TTL. */
  stale: boolean;
  error: unknown;
  loadMore: () => void;
  reload: () => void;
}

/**
 * A folder listing, one cursor page at a time.
 *
 * Pages accumulate rather than replace, because the cursor pagination in the contract is
 * forward-only: there is no way to re-fetch page 2 without walking pages 0 and 1 again, so
 * throwing away what has been loaded to answer a scroll would make scrolling quadratic.
 *
 * The first page goes through the offline cache and later pages do not. That asymmetry is
 * deliberate: `OfflineCache` is keyed by resource and key, and caching page 7 of a listing
 * whose earlier pages have since changed would produce a list with a hole in it. One page is
 * what makes the folder openable offline, which is what the offline library is for.
 */
export function useEntryPages(folderId: string | null, path: string): EntryPages {
  const client = useClient();
  const [folder, setFolder] = useState<Folder | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(folderId !== null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  // Guards a second `loadMore` firing from a scroll event while the first is still in flight;
  // both would ask for the same cursor and the page would appear twice.
  const inFlight = useRef(false);

  useEffect(() => {
    if (folderId === null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setEntries([]);
    setCursor(null);
    setComplete(false);
    setStale(false);

    void (async () => {
      try {
        const key = `${folderId}:${path}`;
        const fetcher = () => client.api.entries(folderId, { path, signal: controller.signal });
        const result =
          client.cache === null
            ? { value: await fetcher(), stale: false }
            : await client.cache.withCache('entries', key, entriesResponseSchema, fetcher);
        if (controller.signal.aborted) return;
        setFolder(result.value.folder);
        setEntries(result.value.entries);
        setCursor(result.value.nextCursor);
        setComplete(result.value.nextCursor === null);
        setStale(result.stale);
      } catch (cause: unknown) {
        if (controller.signal.aborted) return;
        setError(cause);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [client, folderId, path, nonce]);

  const loadMore = useCallback(() => {
    if (folderId === null || cursor === null || inFlight.current) return;
    inFlight.current = true;
    setLoadingMore(true);
    void client.api
      .entries(folderId, { path, cursor })
      .then((page) => {
        setEntries((current) => [...current, ...page.entries]);
        setCursor(page.nextCursor);
        setComplete(page.nextCursor === null);
      })
      .catch((cause: unknown) => setError(cause))
      .finally(() => {
        inFlight.current = false;
        setLoadingMore(false);
      });
  }, [client, folderId, path, cursor]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { folder, entries, loading, loadingMore, complete, stale, error, loadMore, reload };
}

/**
 * Fire `onVisible` when a sentinel element scrolls into view.
 *
 * Guarded rather than assumed: `IntersectionObserver` does not exist in jsdom, and a library
 * screen that throws during render in a test tells you nothing about the library. Where it is
 * missing the caller's explicit "load more" button is the whole mechanism — which is why that
 * button exists on the screen rather than only as a fallback.
 */
export function useInfiniteScroll(
  ref: React.RefObject<HTMLElement | null>,
  onVisible: () => void,
  enabled: boolean,
): void {
  const handler = useRef(onVisible);
  handler.current = onVisible;

  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (element === null) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) handler.current();
      },
      // Start the next page a screen early, so the list does not visibly stall at the bottom.
      { rootMargin: '400px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
}
