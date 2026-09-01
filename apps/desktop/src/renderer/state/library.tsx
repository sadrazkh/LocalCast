import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DeviceSummary } from '@localcast/contract';
import { listActivity, listDevices, listFolders } from '../lib/api.js';
import type { ActivityEntry, AdminFolder } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';

/**
 * Folders, devices and the activity feed, loaded once for the whole panel.
 *
 * The permission matrix is a device × folder grid, the nav rail shows both counts, and the
 * pairing screen needs the folder list to offer default access. Fetching those three lists
 * per screen would mean three copies that disagree the moment a device is approved on one of
 * them. They are loaded here and reloaded explicitly after a mutation — never on a timer.
 */

export interface LibraryValue {
  folders: AdminFolder[];
  devices: DeviceSummary[];
  activity: ActivityEntry[];
  loading: boolean;
  error: string | null;
  reloadFolders: () => Promise<void>;
  reloadDevices: () => Promise<void>;
  reloadActivity: () => Promise<void>;
  reloadAll: () => Promise<void>;
}

const empty: LibraryValue = {
  folders: [],
  devices: [],
  activity: [],
  loading: true,
  error: null,
  reloadFolders: () => Promise.resolve(),
  reloadDevices: () => Promise.resolve(),
  reloadActivity: () => Promise.resolve(),
  reloadAll: () => Promise.resolve(),
};

const LibraryContext = createContext<LibraryValue>(empty);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const folders = useAsync(listFolders, []);
  const devices = useAsync(listDevices, []);
  const activity = useAsync(() => listActivity(120), []);

  const reloadAll = useCallback(async () => {
    await Promise.all([folders.reload(), devices.reload(), activity.reload()]);
  }, [folders.reload, devices.reload, activity.reload]);

  const value = useMemo<LibraryValue>(
    () => ({
      folders: folders.data ?? [],
      devices: devices.data ?? [],
      activity: activity.data ?? [],
      loading: folders.loading || devices.loading,
      // The first failure is the useful one; a screen showing three copies of "the operator
      // API is not answering" tells the operator nothing extra.
      error: folders.error ?? devices.error ?? activity.error,
      reloadFolders: folders.reload,
      reloadDevices: devices.reload,
      reloadActivity: activity.reload,
      reloadAll,
    }),
    [folders, devices, activity, reloadAll],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  return useContext(LibraryContext);
}
