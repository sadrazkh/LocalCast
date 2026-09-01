import { app, BrowserWindow, dialog, session } from 'electron';
import { hostname } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '@localcast/client-core';
import type { ClientAppInfo } from '../shared/ipc.js';
import { DownloadManager } from './downloads.js';
import { ClientHub } from './hub.js';
import { registerIpc } from './ipc.js';
import { attachMediaAuthorization } from './mediaAuth.js';
import { electronSecretCodec } from './secrets.js';
import { ServerRegistry } from './registry.js';
import { SessionVault, SecretStorageUnavailable } from './tokenStore.js';
import { MainHttpTransport } from './transport.js';
import { UploadManager } from './uploads.js';
import { createClientWindow } from './windows.js';

/**
 * Application lifecycle for the LocalCast **client**.
 *
 * Far less happens here than in the server app, and that is the point: there is no sidecar to
 * supervise, no database to migrate, no HTTP server to bind and no certificate to obtain.
 * This process assembles two small platform pieces — a DPAPI-backed `TokenStore` and a
 * main-process `HttpTransport` — hands them to `@localcast/client-core`, and opens a window.
 */

let mainWindow: BrowserWindow | null = null;
let hub: ClientHub | null = null;
let downloads: DownloadManager | null = null;
let uploads: UploadManager | null = null;

// Two instances would fight over the session vault and the download queue file, and the user
// would see a transfer they cannot find. Surface the window they already have instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void bootstrap();
}

function paths() {
  // A separate directory from the server app's: this is a different product on the same
  // machine, and mixing their state would make either one uninstallable without the other.
  const dataDir = join(app.getPath('appData'), 'LocalCast Client');
  return {
    dataDir,
    registryPath: join(dataDir, 'servers.json'),
    vaultPath: join(dataDir, 'sessions.json'),
    downloadsStatePath: join(dataDir, 'downloads.json'),
    downloadDir: join(app.getPath('downloads'), 'LocalCast'),
    preloadDir: join(app.getAppPath(), 'dist', 'preload'),
  };
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const p = paths();
  mkdirSync(p.dataDir, { recursive: true });
  mkdirSync(p.downloadDir, { recursive: true });

  const codec = electronSecretCodec();
  if (!codec.available()) {
    // Refusing to start is the right call. The alternative is writing a device token — which
    // grants read access to somebody else's files — to disk in the clear.
    dialog.showErrorBox('LocalCast', new SecretStorageUnavailable().message);
    app.quit();
    return;
  }

  const transport = new MainHttpTransport({ defaultTimeoutMs: 20_000 });
  const registry = new ServerRegistry(p.registryPath);
  const vault = new SessionVault(p.vaultPath, codec);
  const deviceName = hostname() || 'Windows';

  hub = new ClientHub({
    registry,
    vault,
    transport,
    clock: systemClock,
    deviceName,
  });

  downloads = new DownloadManager({
    transport,
    targets: {
      // Both of these go through the shared package: `ensureFresh` is its single-flight
      // refresh and `contentUrl` is its URL builder. Nothing about the protocol is restated.
      authorize: async (serverId) => {
        const client = hub!.client(serverId);
        const current = await client.session.ensureFresh();
        return current === null ? {} : client.session.authorize({}, current.accessToken);
      },
      contentUrl: (serverId, fileId) =>
        hub!.client(serverId).api.contentUrl(fileId, { download: true }),
    },
    downloadDir: p.downloadDir,
    statePath: p.downloadsStatePath,
    clock: systemClock,
  });
  await downloads.load();

  uploads = new UploadManager({
    targets: { api: (serverId) => hub!.client(serverId).api },
    clock: systemClock,
  });

  // The desktop's answer to the PWA's service worker: a bearer on the range requests a
  // native `<video>` issues for itself.
  attachMediaAuthorization(session.defaultSession.webRequest, hub);

  const info = (): ClientAppInfo => ({
    version: app.getVersion(),
    locale: 'fa',
    downloadDir: p.downloadDir,
    deviceName,
  });

  registerIpc({ hub, downloads, uploads, info });

  mainWindow = createClientWindow(p.preloadDir);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Reconnect everything that already holds a session, so the list is truthful by the time
  // the window has finished painting rather than after the user clicks each row.
  for (const server of hub.summaries()) {
    if (server.deviceId !== null) void hub.connect(server.id);
  }
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  // Aborting in flight leaves the `.lcpart` files intact, so every transfer resumes from its
  // real byte count on the next run instead of starting again.
  void downloads?.stopAll();
  void uploads?.stopAll();
  void hub?.stopAll();
});
