import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC } from '../shared/ipc.js';
import type {
  AddServerInput,
  ClientAppInfo,
  EntriesPage,
  PairInput,
  PairResult,
} from '../shared/ipc.js';
import { LocalCastError } from '@localcast/client-core';
import type { ClientHub } from './hub.js';
import type { DownloadManager } from './downloads.js';
import type { UploadManager } from './uploads.js';
import { isExternallyOpenable } from './windows.js';

/**
 * Every IPC handler, written out one by one.
 *
 * There is no generic forwarder here for the same reason the server app has none: a
 * `invoke(channel, ...args)` bridge hands every registered channel to whatever ends up
 * running in the renderer, and several of these channels write files to the user's disk.
 *
 * Note what is *not* registered: nothing that adds a shared folder, approves a device or
 * edits a permission matrix. This app is a client; those endpoints are loopback-only on the
 * machine that owns the files, and this process has no way to reach them.
 */

export interface IpcDeps {
  hub: ClientHub;
  downloads: DownloadManager;
  uploads: UploadManager;
  info: () => ClientAppInfo;
}

export function registerIpc(deps: IpcDeps): void {
  const { hub, downloads, uploads } = deps;

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  hub.onChange((servers) => broadcast(IPC.serversEvent, servers));
  downloads.onChange((jobs) => broadcast(IPC.downloadsEvent, jobs));
  uploads.onChange((jobs) => broadcast(IPC.uploadsEvent, jobs));

  // ── servers (screen 05) ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.serversSubscribe, () => undefined);
  ipcMain.handle(IPC.serversList, () => hub.summaries());
  ipcMain.handle(IPC.serversAdd, (_e, input: AddServerInput) => hub.add(input.host, input.label));
  ipcMain.handle(IPC.serversRemove, (_e, serverId: string) => hub.remove(serverId));
  ipcMain.handle(IPC.serversConnect, (_e, serverId: string) => hub.connect(serverId));
  ipcMain.handle(IPC.serversForget, (_e, serverId: string) => hub.forget(serverId));

  ipcMain.handle(IPC.serversPair, async (_e, input: PairInput): Promise<PairResult> => {
    try {
      const server = await hub.pair(input.serverId, input.code);
      return { ok: true, server, errorCode: null, errorMessage: null };
    } catch (error) {
      // Pairing fails for reasons the user can act on — a mistyped code, an operator who
      // said no, a code that has expired — so the failure is returned as data with its
      // stable code rather than thrown across the bridge as an opaque `Error`.
      const code = error instanceof LocalCastError ? error.code : 'internal';
      return {
        ok: false,
        server: hub.summary(input.serverId),
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ── library (screen 06) ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.libraryFolders, (_e, serverId: string) => hub.client(serverId).api.folders());

  ipcMain.handle(
    IPC.libraryEntries,
    async (
      _e,
      serverId: string,
      folderId: string,
      options: { path?: string; cursor?: string; limit?: number } = {},
    ): Promise<EntriesPage> => hub.client(serverId).api.entries(folderId, options),
  );

  ipcMain.handle(
    IPC.librarySearch,
    (
      _e,
      serverId: string,
      query: string,
      options: { folderId?: string; cursor?: string; limit?: number } = {},
    ) => hub.client(serverId).api.search(query, options),
  );

  ipcMain.handle(IPC.libraryFileMeta, (_e, serverId: string, fileId: string) =>
    hub.client(serverId).api.fileMeta(fileId),
  );

  ipcMain.handle(IPC.libraryMediaUrl, (_e, serverId: string, fileId: string) =>
    // No `download` flag: this URL is for inline playback, and `stream` mode refuses the
    // download form outright.
    hub.client(serverId).api.contentUrl(fileId),
  );

  ipcMain.handle(
    IPC.libraryDavUrl,
    async (_e, serverId: string, folderId: string, path: string) => {
      const client = hub.client(serverId);
      const session = await client.session.load();
      if (session === null) throw new Error('this machine is not paired with that server');
      // The DAV password is embedded because VLC and Infuse are handed a URL and nothing
      // else. It is built at the moment it is asked for and never stored anywhere else.
      return client.api.davUrl(folderId, path, {
        credentials: { deviceId: session.deviceId, davPassword: session.davPassword },
      });
    },
  );

  // ── downloads ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.downloadsSubscribe, () => undefined);
  ipcMain.handle(IPC.downloadsList, () => downloads.list());

  ipcMain.handle(
    IPC.downloadsStart,
    async (_e, input: { serverId: string; fileId: string }) => {
      // Metadata first: the queue row shows a real name and size from the first frame rather
      // than filling in after the transfer has already started.
      const entry = await hub.client(input.serverId).api.fileMeta(input.fileId);
      return downloads.enqueue({
        serverId: input.serverId,
        fileId: input.fileId,
        fileName: entry.name,
        kind: entry.kind,
        totalBytes: entry.size,
      });
    },
  );

  ipcMain.handle(IPC.downloadsPause, (_e, jobId: string) => downloads.pause(jobId));
  ipcMain.handle(IPC.downloadsResume, (_e, jobId: string) => downloads.resume(jobId));
  ipcMain.handle(IPC.downloadsCancel, (_e, jobId: string) => downloads.cancel(jobId));
  ipcMain.handle(IPC.downloadsReveal, (_e, jobId: string) => {
    const job = downloads.get(jobId);
    if (job === null || job.status !== 'done') return;
    shell.showItemInFolder(job.destination);
  });

  // ── uploads ─────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.uploadsSubscribe, () => undefined);
  ipcMain.handle(IPC.uploadsList, () => uploads.list());

  ipcMain.handle(IPC.uploadsPick, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(
    IPC.uploadsStart,
    (_e, input: { serverId: string; folderId: string; sourcePaths: string[] }) =>
      uploads.start(input),
  );

  ipcMain.handle(IPC.uploadsCancel, (_e, jobId: string) => uploads.cancel(jobId));

  // ── app ─────────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.appInfo, () => deps.info());
  ipcMain.handle(IPC.appOpenExternal, async (_e, url: string) => {
    // Re-checked here and not only at the call site: the renderer is the least trusted part
    // of this process, and the URL it passes may have come from a remote file index.
    if (!isExternallyOpenable(url)) return;
    await shell.openExternal(url);
  });
}
