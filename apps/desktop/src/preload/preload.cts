import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the renderer and the main process.
 *
 * Written as `.cts` on purpose: the windows are created with `sandbox: true`, and a sandboxed
 * preload script must be CommonJS.
 *
 * Nothing here forwards an arbitrary channel name. Every method is an explicit entry, because
 * the operator API behind these calls is what grants a device access to the user's files — a
 * generic `invoke(channel, ...args)` bridge would hand that power to any script that ends up
 * running in the renderer.
 */

// Kept in sync with src/shared/ipc.ts. The literals are duplicated rather than imported
// because a sandboxed preload cannot pull in an ESM module from the workspace.
const IPC = {
  edgeStatus: 'edge:status',
  edgeSubscribe: 'edge:subscribe',
  edgeEvent: 'edge:event',
  edgeTest: 'edge:test',
  edgeApplyConfig: 'edge:apply-config',
  edgeGetConfig: 'edge:get-config',
  edgeResetConfig: 'edge:reset-config',
  edgeLogin: 'edge:login',
  edgeStart: 'edge:start',
  edgeStop: 'edge:stop',
  foldersList: 'folders:list',
  foldersAdd: 'folders:add',
  foldersRemove: 'folders:remove',
  foldersUpdate: 'folders:update',
  foldersPick: 'folders:pick',
  foldersReindex: 'folders:reindex',
  devicesList: 'devices:list',
  deviceApprove: 'device:approve',
  deviceReject: 'device:reject',
  deviceRevoke: 'device:revoke',
  deviceRename: 'device:rename',
  devicePermissions: 'device:permissions',
  pairingMint: 'pairing:mint',
  pairingQrDataUrl: 'pairing:qr-data-url',
  printersList: 'printers:list',
  printersRefresh: 'printers:refresh',
  printerSetEnabled: 'printer:set-enabled',
  activityList: 'activity:list',
  appInfo: 'app:info',
  wizardComplete: 'wizard:complete',
  openExternal: 'app:open-external',
} as const;

const api = {
  edge: {
    status: () => ipcRenderer.invoke(IPC.edgeStatus),
    onEvent: (handler: (status: unknown) => void) => {
      const listener = (_e: unknown, status: unknown) => handler(status);
      ipcRenderer.on(IPC.edgeEvent, listener);
      void ipcRenderer.invoke(IPC.edgeSubscribe);
      return () => ipcRenderer.removeListener(IPC.edgeEvent, listener);
    },
    test: (config: unknown) => ipcRenderer.invoke(IPC.edgeTest, config),
    getConfig: () => ipcRenderer.invoke(IPC.edgeGetConfig),
    applyConfig: (config: unknown) => ipcRenderer.invoke(IPC.edgeApplyConfig, config),
    resetConfig: () => ipcRenderer.invoke(IPC.edgeResetConfig),
    login: () => ipcRenderer.invoke(IPC.edgeLogin),
    start: () => ipcRenderer.invoke(IPC.edgeStart),
    stop: () => ipcRenderer.invoke(IPC.edgeStop),
  },
  folders: {
    list: () => ipcRenderer.invoke(IPC.foldersList),
    pick: () => ipcRenderer.invoke(IPC.foldersPick),
    add: (input: unknown) => ipcRenderer.invoke(IPC.foldersAdd, input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke(IPC.foldersUpdate, id, patch),
    remove: (id: string) => ipcRenderer.invoke(IPC.foldersRemove, id),
    reindex: (id?: string) => ipcRenderer.invoke(IPC.foldersReindex, id),
  },
  devices: {
    list: () => ipcRenderer.invoke(IPC.devicesList),
    approve: (id: string) => ipcRenderer.invoke(IPC.deviceApprove, id),
    reject: (id: string) => ipcRenderer.invoke(IPC.deviceReject, id),
    revoke: (id: string) => ipcRenderer.invoke(IPC.deviceRevoke, id),
    rename: (id: string, name: string) => ipcRenderer.invoke(IPC.deviceRename, id, name),
    setPermissions: (id: string, permissions: unknown) =>
      ipcRenderer.invoke(IPC.devicePermissions, id, permissions),
  },
  pairing: {
    mint: (defaults: unknown) => ipcRenderer.invoke(IPC.pairingMint, defaults),
    qrDataUrl: (payload: string) => ipcRenderer.invoke(IPC.pairingQrDataUrl, payload),
  },
  printers: {
    list: () => ipcRenderer.invoke(IPC.printersList),
    refresh: () => ipcRenderer.invoke(IPC.printersRefresh),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.printerSetEnabled, id, enabled),
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    activity: (limit?: number) => ipcRenderer.invoke(IPC.activityList, limit),
    completeWizard: () => ipcRenderer.invoke(IPC.wizardComplete),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  },
};

contextBridge.exposeInMainWorld('localcast', api);
