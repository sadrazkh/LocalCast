// `import ... = require(...)` rather than an ESM import: this is a `.cts` file compiled to
// CommonJS, which a sandboxed preload script must be, and `verbatimModuleSyntax` will not
// rewrite ESM syntax into a require for us.
import electron = require('electron');
const { contextBridge, ipcRenderer } = electron;

/**
 * The only bridge between the renderer and the main process.
 *
 * `.cts` on purpose: the window is created with `sandbox: true`, and a sandboxed preload must
 * be CommonJS — it cannot import an ESM module from the workspace, which is also why the
 * channel names below are written out rather than imported from `src/shared/ipc.ts`. The two
 * lists are kept in step by hand; a typo produces a rejected invoke at the first call, not a
 * silent no-op.
 *
 * Every method is an explicit entry. There is no `invoke(channel, ...args)` here, because
 * several of these channels write files to the user's disk and one of them opens a URL in the
 * operating system's browser. A generic forwarder would hand all of that to any script that
 * ends up running in this renderer — and the strings this renderer renders come from a file
 * index on a machine somebody else administers.
 */

const IPC = {
  serversList: 'servers:list',
  serversAdd: 'servers:add',
  serversRemove: 'servers:remove',
  serversConnect: 'servers:connect',
  serversForget: 'servers:forget',
  serversPair: 'servers:pair',
  serversSubscribe: 'servers:subscribe',
  serversEvent: 'servers:event',

  libraryFolders: 'library:folders',
  libraryEntries: 'library:entries',
  librarySearch: 'library:search',
  libraryFileMeta: 'library:file-meta',
  libraryMediaUrl: 'library:media-url',
  libraryDavUrl: 'library:dav-url',

  downloadsList: 'downloads:list',
  downloadsStart: 'downloads:start',
  downloadsPause: 'downloads:pause',
  downloadsResume: 'downloads:resume',
  downloadsCancel: 'downloads:cancel',
  downloadsReveal: 'downloads:reveal',
  downloadsSubscribe: 'downloads:subscribe',
  downloadsEvent: 'downloads:event',

  uploadsPick: 'uploads:pick',
  uploadsStart: 'uploads:start',
  uploadsList: 'uploads:list',
  uploadsCancel: 'uploads:cancel',
  uploadsSubscribe: 'uploads:subscribe',
  uploadsEvent: 'uploads:event',

  appInfo: 'app:info',
  appOpenExternal: 'app:open-external',
} as const;

/** Subscribe to a push channel and start receiving it. Returns the unsubscribe. */
function subscribe(
  eventChannel: string,
  subscribeChannel: string,
  handler: (payload: unknown) => void,
): () => void {
  const listener = (_event: unknown, payload: unknown) => handler(payload);
  ipcRenderer.on(eventChannel, listener);
  void ipcRenderer.invoke(subscribeChannel);
  return () => ipcRenderer.removeListener(eventChannel, listener);
}

const api = {
  servers: {
    list: () => ipcRenderer.invoke(IPC.serversList),
    add: (input: unknown) => ipcRenderer.invoke(IPC.serversAdd, input),
    remove: (serverId: string) => ipcRenderer.invoke(IPC.serversRemove, serverId),
    connect: (serverId: string) => ipcRenderer.invoke(IPC.serversConnect, serverId),
    forget: (serverId: string) => ipcRenderer.invoke(IPC.serversForget, serverId),
    pair: (input: unknown) => ipcRenderer.invoke(IPC.serversPair, input),
    onChange: (handler: (servers: unknown) => void) =>
      subscribe(IPC.serversEvent, IPC.serversSubscribe, handler),
  },
  library: {
    folders: (serverId: string) => ipcRenderer.invoke(IPC.libraryFolders, serverId),
    entries: (serverId: string, folderId: string, options?: unknown) =>
      ipcRenderer.invoke(IPC.libraryEntries, serverId, folderId, options ?? {}),
    search: (serverId: string, query: string, options?: unknown) =>
      ipcRenderer.invoke(IPC.librarySearch, serverId, query, options ?? {}),
    fileMeta: (serverId: string, fileId: string) =>
      ipcRenderer.invoke(IPC.libraryFileMeta, serverId, fileId),
    mediaUrl: (serverId: string, fileId: string) =>
      ipcRenderer.invoke(IPC.libraryMediaUrl, serverId, fileId),
    davUrl: (serverId: string, folderId: string, path: string) =>
      ipcRenderer.invoke(IPC.libraryDavUrl, serverId, folderId, path),
  },
  downloads: {
    list: () => ipcRenderer.invoke(IPC.downloadsList),
    start: (input: unknown) => ipcRenderer.invoke(IPC.downloadsStart, input),
    pause: (jobId: string) => ipcRenderer.invoke(IPC.downloadsPause, jobId),
    resume: (jobId: string) => ipcRenderer.invoke(IPC.downloadsResume, jobId),
    cancel: (jobId: string) => ipcRenderer.invoke(IPC.downloadsCancel, jobId),
    reveal: (jobId: string) => ipcRenderer.invoke(IPC.downloadsReveal, jobId),
    onChange: (handler: (jobs: unknown) => void) =>
      subscribe(IPC.downloadsEvent, IPC.downloadsSubscribe, handler),
  },
  uploads: {
    pick: () => ipcRenderer.invoke(IPC.uploadsPick),
    start: (input: unknown) => ipcRenderer.invoke(IPC.uploadsStart, input),
    list: () => ipcRenderer.invoke(IPC.uploadsList),
    cancel: (jobId: string) => ipcRenderer.invoke(IPC.uploadsCancel, jobId),
    onChange: (handler: (jobs: unknown) => void) =>
      subscribe(IPC.uploadsEvent, IPC.uploadsSubscribe, handler),
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url),
  },
};

contextBridge.exposeInMainWorld('localcastClient', api);
