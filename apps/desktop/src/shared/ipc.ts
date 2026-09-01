import type {
  DeviceSummary,
  EdgeStatus,
  EdgeTestResult,
  Folder,
  NetworkConfig,
  Printer,
} from '@localcast/contract';

/**
 * The contract between the Electron main process and the renderer.
 *
 * The renderer has no Node access and no direct network access to the operator API — it can
 * only call the methods named here, which the preload script exposes over `contextBridge`.
 * That is deliberate: the operator API grants privilege (approving devices, changing the
 * permission matrix), so its reachable surface is kept as small and as explicit as possible.
 */

export const IPC = {
  // network edge
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

  // library
  foldersList: 'folders:list',
  foldersAdd: 'folders:add',
  foldersRemove: 'folders:remove',
  foldersUpdate: 'folders:update',
  foldersPick: 'folders:pick',
  foldersReindex: 'folders:reindex',

  // devices
  devicesList: 'devices:list',
  deviceApprove: 'device:approve',
  deviceReject: 'device:reject',
  deviceRevoke: 'device:revoke',
  deviceRename: 'device:rename',
  devicePermissions: 'device:permissions',

  // pairing
  pairingMint: 'pairing:mint',
  pairingQrDataUrl: 'pairing:qr-data-url',

  // printers
  printersList: 'printers:list',
  printersRefresh: 'printers:refresh',
  printerSetEnabled: 'printer:set-enabled',

  // app
  activityList: 'activity:list',
  appInfo: 'app:info',
  wizardState: 'wizard:state',
  wizardComplete: 'wizard:complete',
  openExternal: 'app:open-external',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateProgress: 'update:progress',
} as const;

export interface AppInfo {
  version: string;
  /** Where the PWA can be reached, once the edge knows. Shown on the pairing screen. */
  host: string | null;
  serverPort: number;
  locale: 'fa' | 'en';
  /** False until the three-step wizard has been completed once. */
  setupComplete: boolean;
}

export interface PairingMintResult {
  code: string;
  /** The full QR payload, already JSON-encoded, ready to be turned into an image. */
  payload: string;
  expiresAt: number;
}

/**
 * `NetworkConfig` carries secrets. The renderer never receives them: `edgeGetConfig` returns
 * this shape instead, where a stored secret is reported only as present or absent. The
 * renderer shows a masked field and sends a new value only when the user types one.
 */
export type RedactedNetworkConfig = Omit<NetworkConfig, 'authKey' | 'dnsApiToken'> & {
  hasAuthKey: boolean;
  hasDnsApiToken: boolean;
};

export interface DesktopApi {
  /**
   * Prerequisites. Declared here rather than only in the renderer, because a screen that
   * feature-detects its own backend forever is a screen nobody ever finishes wiring.
   */
  preflight: import('./preflight.js').PreflightBridge;
  edge: {
    status(): Promise<EdgeStatus>;
    onEvent(handler: (status: EdgeStatus) => void): () => void;
    test(config: NetworkConfig): Promise<EdgeTestResult>;
    getConfig(): Promise<RedactedNetworkConfig>;
    /** Applying restarts the tsnet node in place; the database is untouched. */
    applyConfig(config: NetworkConfig): Promise<EdgeStatus>;
    resetConfig(): Promise<EdgeStatus>;
    login(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  folders: {
    list(): Promise<Folder[]>;
    pick(): Promise<string | null>;
    add(input: { path: string; label: string; kind: string; writable: boolean }): Promise<Folder>;
    update(id: string, patch: Partial<{ label: string; writable: boolean; autoIndex: boolean }>): Promise<Folder>;
    remove(id: string): Promise<void>;
    reindex(id?: string): Promise<void>;
  };
  devices: {
    list(): Promise<DeviceSummary[]>;
    approve(id: string): Promise<DeviceSummary>;
    reject(id: string): Promise<void>;
    revoke(id: string): Promise<void>;
    rename(id: string, name: string): Promise<DeviceSummary>;
    setPermissions(id: string, permissions: { folderId: string; mode: string }[]): Promise<DeviceSummary>;
  };
  pairing: {
    mint(defaults: { folderId: string; mode: string }[]): Promise<PairingMintResult>;
    qrDataUrl(payload: string): Promise<string>;
  };
  printers: {
    list(): Promise<Printer[]>;
    refresh(): Promise<Printer[]>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
  };
  updates: {
    /** Asks GitHub whether a newer release exists. Never throws; errors come back as state. */
    check(): Promise<import('../main/updates.js').UpdateState>;
    /**
     * Downloads the installer, verifies it against the release's SHA256SUMS and runs it.
     * A portable build cannot replace a running executable, so it opens the release page.
     */
    install(): Promise<void>;
    onProgress(handler: (p: { receivedBytes: number; totalBytes: number }) => void): () => void;
  };
  app: {
    info(): Promise<AppInfo>;
    activity(limit?: number): Promise<{ at: number; kind: string; deviceId: string | null; detail: unknown }[]>;
    completeWizard(): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
}

declare global {
  interface Window {
    localcast: DesktopApi;
  }
}
