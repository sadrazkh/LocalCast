import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  value: T | null;
  error: unknown;
  loading: boolean;
  /** True when the value came from the offline cache past its TTL. */
  stale: boolean;
}

export interface AsyncResult<T> extends AsyncState<T> {
  reload: () => void;
}

export type AsyncLoader<T> = (signal: AbortSignal) => Promise<{ value: T; stale?: boolean } | T>;

function unwrap<T>(result: { value: T; stale?: boolean } | T): { value: T; stale: boolean } {
  if (typeof result === 'object' && result !== null && 'value' in result && 'stale' in result) {
    const shaped = result as { value: T; stale?: boolean };
    return { value: shaped.value, stale: shaped.stale === true };
  }
  return { value: result as T, stale: false };
}

/**
 * Load something once per key, with the previous request aborted when the key changes.
 *
 * The abort is the point. Tapping through four folders faster than the network answers
 * produces four in-flight listings, and without cancellation the one that happens to land
 * last wins — which is regularly the first folder you left. `client-core` threads the signal
 * all the way to `fetch`, so an abandoned request costs nothing on either end.
 */
export function useAsync<T>(loader: AsyncLoader<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({
    value: null,
    error: null,
    loading: true,
    stale: false,
  });
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    void (async () => {
      try {
        const result = unwrap(await loaderRef.current(controller.signal));
        if (!live) return;
        setState({ value: result.value, error: null, loading: false, stale: result.stale });
      } catch (error) {
        if (!live || controller.signal.aborted) return;
        setState({ value: null, error, loading: false, stale: false });
      }
    })();

    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, reload };
}
