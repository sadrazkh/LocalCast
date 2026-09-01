import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import QRCode from 'qrcode';
import { networkConfigSchema, type EdgeStatus, type NetworkConfig } from '@localcast/contract';
import { IPC, type AppInfo, type PairingMintResult, type RedactedNetworkConfig } from '../shared/ipc.js';
import type { NetEdge } from './netedge.js';
import type { OperatorClient } from './operatorClient.js';
import type { AppConfigStore } from './appConfig.js';

/**
 * Registers every IPC handler. Each one is an explicit entry rather than a generic bridge,
 * because these calls reach the operator API — the surface that grants a device access to
 * the user's files.
 */

export interface IpcDeps {
  /**
   * Getters, not instances.
   *
   * Handlers are registered before the server and the sidecar exist, because the
   * prerequisites screen opens first and a window whose calls answer "No handler registered"
   * is exactly the silent failure this whole subsystem was added to prevent. Reaching a
   * handler too early now gets a typed, catchable error the UI can render.
   */
  edge: () => NetEdge | null;
  operator: () => OperatorClient;
  appConfig: AppConfigStore;
  version: string;
  serverPort: () => number;
  restartEdge: (config: NetworkConfig) => Promise<EdgeStatus>;
}

/**
 * Strips secrets before anything reaches the renderer.
 *
 * The presence flags fall back to what the server reported. The server correctly never
 * returns the ciphertext — it holds DPAPI blobs it has no key for — so deriving presence
 * only from a field that is always absent would tell every user "no key stored" even with a
 * Headscale key on file, and invite them to retype one they already have.
 */
function redact(
  config: NetworkConfig & {
    authKey?: string;
    dnsApiToken?: string;
    hasAuthKey?: boolean;
    hasDnsApiToken?: boolean;
  },
): RedactedNetworkConfig {
  const { authKey, dnsApiToken, hasAuthKey, hasDnsApiToken, ...rest } = config;
  return {
    ...rest,
    hasAuthKey: !!authKey || hasAuthKey === true,
    hasDnsApiToken: !!dnsApiToken || hasDnsApiToken === true,
  };
}

/** The status the UI shows before the sidecar exists — during the prerequisites gate. */
const EDGE_NOT_STARTED: EdgeStatus = {
  state: 'stopped',
  host: null,
  funnelUrl: null,
  loginUrl: null,
  errorCode: null,
  errorMessage: null,
  certExpiresAt: null,
  peers: 0,
  updatedAt: 0,
};

export function registerIpc(deps: IpcDeps): void {
  const { edge, operator, appConfig } = deps;

  /** Throws a message the UI can show, rather than letting a null reach a property access. */
  function requireEdge(): NetEdge {
    const instance = edge();
    if (!instance) throw new Error('The network component has not started yet.');
    return instance;
  }

  // ── network edge ───────────────────────────────────────────────────────────
  // Reads answer with a stopped status rather than throwing: the tray and the wizard poll
  // this on mount, and during the prerequisites gate "not running" is the honest answer.
  ipcMain.handle(IPC.edgeStatus, () => edge()?.status ?? EDGE_NOT_STARTED);

  // Every window that asks starts receiving pushes. Broadcasting to all of them keeps the
  // tray popover, the panel and the wizard showing the same state without a polling loop.
  ipcMain.handle(IPC.edgeSubscribe, () => undefined);

  ipcMain.handle(IPC.edgeTest, async (_e, raw: unknown) => {
    // Validate here rather than trusting the renderer: this is the call that decides whether
    // an impossible configuration gets saved.
    const config = networkConfigSchema.parse(raw);
    return requireEdge().test(config);
  });

  ipcMain.handle(IPC.edgeGetConfig, async () => {
    const stored = await operator().get<NetworkConfig>('/network-config');
    return redact(stored);
  });

  ipcMain.handle(IPC.edgeApplyConfig, async (_e, raw: unknown) => {
    const config = networkConfigSchema.parse(raw);

    // Refuse to save something the sidecar has already said cannot work. Without this, a
    // self-hosted control server asked to issue its own certificate would be stored and then
    // spin on "connecting…" forever.
    const test = await requireEdge().test(config);
    if (!test.ok) {
      const reason = test.messages.find((m) => m.level === 'error')?.text ?? 'configuration is not viable';
      throw new Error(reason);
    }

    await operator().post('/network-config', config);
    return deps.restartEdge(config);
  });

  ipcMain.handle(IPC.edgeResetConfig, async () => {
    const defaults: NetworkConfig = networkConfigSchema.parse({
      mode: 'default',
      expose: 'tailnet',
      certStrategy: 'control-plane',
      hostname: appConfig.get().hostname,
    });
    await operator().post('/network-config', defaults);
    return deps.restartEdge(defaults);
  });

  ipcMain.handle(IPC.edgeLogin, async () => {
    const url = await requireEdge().requestLogin();
    // Opened in the real browser on purpose: the user should be able to see the address bar
    // of the page they are typing their account password into.
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.edgeStart, () => requireEdge().start());
  ipcMain.handle(IPC.edgeStop, () => requireEdge().stop());

  // ── folders ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.foldersList, () => operator().get('/folders'));

  ipcMain.handle(IPC.foldersPick, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.foldersAdd, (_e, input: unknown) => operator().post('/folders', input));
  ipcMain.handle(IPC.foldersUpdate, (_e, id: string, patch: unknown) =>
    operator().patch(`/folders/${encodeURIComponent(id)}`, patch),
  );
  ipcMain.handle(IPC.foldersRemove, (_e, id: string) =>
    operator().delete(`/folders/${encodeURIComponent(id)}`),
  );
  ipcMain.handle(IPC.foldersReindex, (_e, id?: string) =>
    operator().post(id ? `/folders/${encodeURIComponent(id)}/reindex` : '/folders/reindex'),
  );

  // ── devices ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.devicesList, () => operator().get('/devices'));
  ipcMain.handle(IPC.deviceApprove, (_e, id: string) =>
    operator().post(`/devices/${encodeURIComponent(id)}/approve`),
  );
  ipcMain.handle(IPC.deviceReject, (_e, id: string) =>
    operator().post(`/devices/${encodeURIComponent(id)}/reject`),
  );
  ipcMain.handle(IPC.deviceRevoke, (_e, id: string) =>
    operator().post(`/devices/${encodeURIComponent(id)}/revoke`),
  );
  ipcMain.handle(IPC.deviceRename, (_e, id: string, name: string) =>
    operator().patch(`/devices/${encodeURIComponent(id)}`, { name }),
  );
  ipcMain.handle(IPC.devicePermissions, (_e, id: string, permissions: unknown) =>
    operator().post(`/devices/${encodeURIComponent(id)}/permissions`, { deviceId: id, permissions }),
  );

  // ── pairing ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.pairingMint, (_e, defaultPermissions: unknown) =>
    operator().post<PairingMintResult>('/pairing', { defaultPermissions }),
  );

  ipcMain.handle(IPC.pairingQrDataUrl, (_e, payload: string) =>
    // Rendered in the main process so the QR is produced from exactly the string the server
    // minted, with no chance of the renderer reformatting it.
    QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
      color: { dark: '#f2f3f5', light: '#0d0e12' },
    }),
  );

  // ── printers ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.printersList, () => operator().get('/printers'));
  ipcMain.handle(IPC.printersRefresh, () => operator().post('/printers/refresh'));
  ipcMain.handle(IPC.printerSetEnabled, (_e, id: string, enabled: boolean) =>
    operator().patch(`/printers/${encodeURIComponent(id)}`, { enabled }),
  );

  // ── app ────────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    const cfg = appConfig.get();
    return {
      version: deps.version,
      host: edge()?.status.host ?? null,
      serverPort: deps.serverPort(),
      locale: cfg.locale,
      setupComplete: cfg.setupComplete,
    };
  });

  ipcMain.handle(IPC.activityList, (_e, limit?: number) =>
    operator().get(`/activity?limit=${Math.min(Math.max(limit ?? 100, 1), 500)}`),
  );

  ipcMain.handle(IPC.wizardComplete, () => {
    appConfig.update({ setupComplete: true });
  });

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    // Only ever open real web URLs. `file:` and custom schemes here would be a way to make
    // the app launch arbitrary things on the user's machine.
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`refusing to open ${parsed.protocol} URL`);
    }
    await shell.openExternal(url);
  });
}

/**
 * Fans the sidecar's status out to every window.
 *
 * Separate from `registerIpc` because the handlers are registered before the sidecar is
 * constructed — the prerequisites screen has to be able to talk to the main process while
 * nothing else is running yet. This is called once the instance exists.
 */
export function broadcastEdgeStatus(instance: NetEdge): () => void {
  const send = (status: EdgeStatus) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.edgeEvent, status);
    }
  };
  instance.on('status', send);
  return () => instance.off('status', send);
}
