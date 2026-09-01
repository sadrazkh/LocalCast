import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Optimistic local update, so a toggle does not wait for a round trip to look pressed. */
  set: (next: T) => void;
}

/** Message from anything that crossed the IPC bridge; Electron rethrows a plain `Error`. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return stripIpcPrefix(error.message);
  if (typeof error === 'string') return stripIpcPrefix(error);
  return String(error);
}

/**
 * `ipcRenderer.invoke` prefixes a rejected handler's message with its own frame, e.g.
 * `Error invoking remote method 'edge:apply-config': Error: <the real reason>`. The operator
 * must read the reason, not the plumbing.
 */
function stripIpcPrefix(message: string): string {
  const match = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s.exec(message);
  return (match?.[1] ?? message).trim();
}

/**
 * Loads once on mount and on demand. Deliberately not a polling hook: the only thing in this
 * app that changes without the operator doing something is the edge status, and that arrives
 * as a push on `edge.onEvent`.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[] = []): AsyncResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await load();
      if (!alive.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(messageOf(err));
    } finally {
      if (alive.current) setLoading(false);
    }
    // `load` is expected to be a stable closure over `deps`; taking it as a dependency
    // would re-fetch on every render of the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, set: setData };
}
