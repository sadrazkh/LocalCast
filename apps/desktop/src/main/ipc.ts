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
  edge: NetEdge;
  operator: () => OperatorClient;
  appConfig: AppConfigStore;
  version: string;
  serverPort: () => number;
  restartEdge: (config: NetworkConfig) => Promise<EdgeStatus>;
}

function redact(config: NetworkConfig & { authKey?: string; dnsApiToken?: string }): RedactedNetworkConfig {
  const { authKey, dnsApiToken, ...rest } = config;
  return { ...rest, hasAuthKey: !!authKey, hasDnsApiToken: !!dnsApiToken };
}

export function registerIpc(deps: IpcDeps): void {
  const { edge, operator, appConfig } = deps;

  // ── network edge ───────────────────────────────────────────────────────────
  ipcMain.handle(IPC.edgeStatus, () => edge.status);

  // Every window that asks starts receiving pushes. Broadcasting to all of them keeps the
  // tray popover, the panel and the wizard showing the same state without a polling loop.
  ipcMain.handle(IPC.edgeSubscribe, () => undefined);
  edge.on('status', (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.edgeEvent, status);
    }
  });

  ipcMain.handle(IPC.edgeTest, async (_e, raw: unknown) => {
    // Validate here rather than trusting the renderer: this is the call that decides whether
    // an impossible configuration gets saved.
    const config = networkConfigSchema.parse(raw);
    return edge.test(config);
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
    const test = await edge.test(config);
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
    const url = await edge.requestLogin();
    // Opened in the real browser on purpose: the user should be able to see the address bar
    // of the page they are typing their account password into.
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.edgeStart, () => edge.start());
  ipcMain.handle(IPC.edgeStop, () => edge.stop());

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
      host: edge.status.host,
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
