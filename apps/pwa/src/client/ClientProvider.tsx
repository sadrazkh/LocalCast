import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  FetchTransport,
  createClient,
  systemClock,
} from '@localcast/client-core';
import type {
  CacheStore,
  ConnectionState,
  HttpTransport,
  LocalCastClient,
  Logger,
  StoredSession,
  TokenStore,
} from '@localcast/client-core';
import { IdbCacheStore, MemoryCacheStore } from '../storage/cacheStore.js';
import { IdbTokenStore, MemoryTokenStore } from '../storage/tokenStore.js';

/**
 * One `LocalCastClient` for the life of the app, handed to React through a context.
 *
 * Everything interesting — token refresh, the connection dot's hysteresis, SSE reconnection,
 * the offline policy — already lives in `client-core` and is tested there. This file's whole
 * job is to construct it with the platform's implementations of the four ports and to keep
 * React's rendering in step with the parts of it that change.
 */

export interface ClientContextValue {
  client: LocalCastClient;
  /** `null` until the store has been read once; then the session or `null` if unpaired. */
  session: StoredSession | null;
  /** False while the very first store read is in flight, so the app can avoid flashing pairing. */
  ready: boolean;
  baseUrl: string;
}

const ClientContext = createContext<ClientContextValue | null>(null);

export interface ClientProviderProps {
  children: ReactNode;
  /** Overrides for tests; production passes none of these. */
  transport?: HttpTransport;
  tokenStore?: TokenStore;
  cacheStore?: CacheStore;
  baseUrl?: string;
  logger?: Logger;
  /** Off in tests: an SSE stream that reconnects for ever keeps the run alive. */
  autoStart?: boolean;
}

/**
 * The origin the app was served from.
 *
 * It has to be the origin and not a configured host, because the service worker only sees —
 * and can therefore only authorise — same-origin requests. The PWA is served by the same Node
 * server that serves `/api/v1` and `/dav`, so this is also simply true.
 */
function defaultBaseUrl(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** IndexedDB throws outright in a Safari private window; the app still has to pair there. */
function makeTokenStore(): TokenStore {
  try {
    return typeof indexedDB === 'undefined' ? new MemoryTokenStore() : new IdbTokenStore();
  } catch {
    return new MemoryTokenStore();
  }
}

function makeCacheStore(): CacheStore {
  try {
    return typeof indexedDB === 'undefined' ? new MemoryCacheStore() : new IdbCacheStore();
  } catch {
    return new MemoryCacheStore();
  }
}

export function ClientProvider({
  children,
  transport,
  tokenStore,
  cacheStore,
  baseUrl,
  logger,
  autoStart = true,
}: ClientProviderProps) {
  const resolvedBaseUrl = baseUrl ?? defaultBaseUrl();

  const client = useMemo(
    () =>
      createClient({
        transport: transport ?? new FetchTransport({ defaultTimeoutMs: 15_000 }),
        tokenStore: tokenStore ?? makeTokenStore(),
        cacheStore: cacheStore ?? makeCacheStore(),
        clock: systemClock,
        baseUrl: resolvedBaseUrl,
        ...(logger === undefined ? {} : { logger }),
      }),
    // Deliberately constructed once. A client rebuilt on a prop change would drop the SSE
    // stream and the in-memory session, and every consumer would re-authenticate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [session, setSession] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void client.session.load().then((loaded) => {
      if (cancelled) return;
      setSession(loaded);
      setReady(true);
    });
    const off = client.session.events.on('session-changed', ({ session: next }) => {
      setSession(next);
      // The service worker holds a short memo of the access token so a burst of range
      // requests is one IndexedDB read. Telling it the token moved is cheaper than it
      // discovering so through a 401 mid-scrub.
      notifyServiceWorker();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [client]);

  useEffect(() => {
    if (!autoStart) return;
    if (session === null) return;
    client.start();
    return () => {
      void client.stop();
    };
  }, [client, autoStart, session]);

  const value = useMemo<ClientContextValue>(
    () => ({ client, session, ready, baseUrl: resolvedBaseUrl }),
    [client, session, ready, resolvedBaseUrl],
  );

  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

function notifyServiceWorker(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'localcast:session-changed' });
  } catch {
    // No worker, or a browser that refuses to talk to one. The worker re-reads the store
    // within a couple of seconds anyway; this message is an optimisation, not a mechanism.
  }
}

export function useClientContext(): ClientContextValue {
  const value = useContext(ClientContext);
  if (value === null) {
    throw new Error('useClientContext must be used inside <ClientProvider>');
  }
  return value;
}

export function useClient(): LocalCastClient {
  return useClientContext().client;
}

export function useApi() {
  return useClientContext().client.api;
}

export function useSession(): StoredSession | null {
  return useClientContext().session;
}

/**
 * The connection dot's state, as React state.
 *
 * `ConnectionMonitor` is an emitter with a synchronous getter, which is exactly the shape
 * `useSyncExternalStore` wants — no effect, no duplicated copy of the state, and no window in
 * which the rendered dot disagrees with the monitor.
 */
export function useConnectionState(): ConnectionState {
  const { client } = useClientContext();
  return useSyncExternalStore(
    (onChange) => client.connection.subscribe(() => onChange()),
    () => client.connection.state,
    () => 'connecting' as ConnectionState,
  );
}
