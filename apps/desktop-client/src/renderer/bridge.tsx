import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  DesktopClientApi,
  DownloadJob,
  ServerSummary,
  UploadJob,
} from '../shared/ipc.js';

/**
 * The renderer's single dependency on the outside world.
 *
 * Every network call, every token, every byte written to disk happens in the main process;
 * this side has `window.localcastClient` and nothing else. Putting it behind a context rather
 * than reading the global at each call site buys two things: a component can be rendered in a
 * test with a fake bridge and no Electron at all, and there is one place to look when asking
 * what this renderer is actually allowed to do.
 */

const BridgeContext = createContext<DesktopClientApi | null>(null);

export interface BridgeProviderProps {
  /** Omitted in the real app, supplied by tests. */
  value?: DesktopClientApi;
  children: ReactNode;
}

export function BridgeProvider({ value, children }: BridgeProviderProps) {
  const api = value ?? (typeof window === 'undefined' ? null : window.localcastClient ?? null);
  return <BridgeContext.Provider value={api}>{children}</BridgeContext.Provider>;
}

export function useBridge(): DesktopClientApi {
  const api = useContext(BridgeContext);
  if (api === null) {
    // Loud rather than a screen of empty lists: if the preload did not run, nothing in this
    // window can work and pretending otherwise wastes the user's time.
    throw new Error('the LocalCast bridge is not available in this window');
  }
  return api;
}

/**
 * The server list, kept live.
 *
 * The main process pushes a whole new array on every change rather than a patch. The list is
 * a handful of rows; diffing it would be more code than re-rendering it, and a patch stream
 * is the usual way a UI ends up disagreeing with the thing it describes.
 */
export function useServers(): { servers: ServerSummary[]; loading: boolean } {
  const api = useBridge();
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    void api.servers.list().then((list) => {
      if (live) {
        setServers(list);
        setLoading(false);
      }
    });
    const off = api.servers.onChange((next) => {
      if (live) setServers(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [api]);

  return { servers, loading };
}

export function useDownloads(): DownloadJob[] {
  const api = useBridge();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);

  useEffect(() => {
    let live = true;
    void api.downloads.list().then((list) => {
      if (live) setJobs(list);
    });
    const off = api.downloads.onChange((next) => {
      if (live) setJobs(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [api]);

  return jobs;
}

export function useUploads(): UploadJob[] {
  const api = useBridge();
  const [jobs, setJobs] = useState<UploadJob[]>([]);

  useEffect(() => {
    let live = true;
    void api.uploads.list().then((list) => {
      if (live) setJobs(list);
    });
    const off = api.uploads.onChange((next) => {
      if (live) setJobs(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [api]);

  return jobs;
}
