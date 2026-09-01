import { app, BrowserWindow, dialog } from 'electron';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EdgeStatus, NetworkConfig } from '@localcast/contract';
import { AppConfigStore, configPathFor } from './appConfig.js';
import { registerIpc } from './ipc.js';
import { NetEdge, NetEdgeBinaryMissing } from './netedge.js';
import { OperatorClient } from './operatorClient.js';
import { ensureSigningKey, mintEdgeSecret, SecretStorageUnavailable } from './secrets.js';
import { ServerNotBuilt, startServer, type ServerHandle } from './serverHost.js';
import { AppTray } from './tray.js';
import { createMainWindow, createTrayWindow, createWizardWindow } from './windows.js';

/**
 * Application lifecycle.
 *
 * Order matters here: the server has to be listening before `netedge` is told where to proxy,
 * and `netedge` has to be up before the tray can show anything truthful. Each step reports
 * its own failure rather than leaving the app in a state where the tray says "connecting"
 * and nothing is actually running.
 */

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let serverHandle: ServerHandle | null = null;
let edge: NetEdge | null = null;
let tray: AppTray | null = null;
let mainWindow: BrowserWindow | null = null;
let trayWindow: BrowserWindow | null = null;
let wizardWindow: BrowserWindow | null = null;
let quitting = false;

// A second instance would fight the first over the database and the tsnet state directory,
// so the second one simply surfaces the window the user already has.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      openPanel();
    }
  });
  // Nothing in bootstrap is allowed to fail silently. Without this catch a startup error
  // surfaces as an UnhandledPromiseRejectionWarning on a console nobody is reading, and the
  // user sees an app that started and then did nothing at all.
  void bootstrap().catch((err: unknown) => {
    void reportFatal(err);
  });
}

/**
 * Last-resort failure reporting.
 *
 * Startup problems are almost always environmental — a native module built for the wrong
 * ABI, a missing sidecar, a data directory that cannot be written — so the message names the
 * thing that failed and what to do about it, and the window stays closed rather than opening
 * onto a UI wired to nothing.
 */
async function reportFatal(err: unknown): Promise<void> {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('[main] startup failed:', detail);

  try {
    await app.whenReady();
    dialog.showErrorBox(
      'LocalCast could not start',
      `${err instanceof Error ? err.message : String(err)}\n\n${detail}`,
    );
  } catch {
    // If even the dialog cannot be shown there is nothing left to try.
  }
  app.exit(1);
}

function paths() {
  const dataDir = join(app.getPath('appData'), 'LocalCast');
  const appRoot = app.getAppPath();
  // In development `app.getAppPath()` is apps/desktop, so the repo root is two levels up.
  // `process.resourcesPath` must not be used here: unpackaged, it points inside Electron's
  // own installation, which is how webRoot ended up at electron/dist/resources/web.
  const repoRoot = join(appRoot, '..', '..');

  return {
    dataDir,
    tempDir: join(dataDir, 'tmp'),
    vendorDir: app.isPackaged ? join(process.resourcesPath, 'vendor') : join(repoRoot, 'vendor', 'bin'),
    assetsDir: app.isPackaged ? join(process.resourcesPath, 'assets') : join(appRoot, 'assets'),
    // Vite serves the PWA itself while its dev server is up; otherwise the built bundle is
    // served from this origin so a phone needs no second address.
    webRoot: isDev
      ? ''
      : app.isPackaged
        ? join(process.resourcesPath, 'web')
        : join(repoRoot, 'apps', 'pwa', 'dist'),
    preloadDir: join(appRoot, 'dist', 'preload'),
    repoRoot,
  };
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const p = paths();
  mkdirSync(p.dataDir, { recursive: true });
  // Spool copies and half-finished uploads from a previous run are worthless and can be
  // large; clearing them at boot keeps a crashed session from eating the disk.
  rmSync(p.tempDir, { recursive: true, force: true });
  mkdirSync(p.tempDir, { recursive: true });

  const appConfig = new AppConfigStore(configPathFor(p.dataDir));
  const edgeSecret = mintEdgeSecret();

  // The signing key must outlive the process: regenerating it would invalidate every device
  // token, which is exactly what must not happen when the user restarts the app or switches
  // between the default coordination server and their own Headscale.
  const keyringPath = join(p.dataDir, 'keys.json');
  let signingKey: Buffer;
  try {
    signingKey = ensureSigningKey(
      () => {
        try {
          return (JSON.parse(readFileSync(keyringPath, 'utf8')) as { signingKey?: string }).signingKey ?? null;
        } catch {
          return null;
        }
      },
      (enc) => {
        const tmp = `${keyringPath}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ signingKey: enc }, null, 2)}\n`, 'utf8');
        renameSync(tmp, keyringPath);
      },
    );
  } catch (err) {
    if (err instanceof SecretStorageUnavailable) {
      // Refusing to start is the right call: the alternative is silently writing the key
      // that protects every device token to disk in the clear.
      dialog.showErrorBox('LocalCast', err.message);
      app.quit();
      return;
    }
    throw err;
  }

  try {
    serverHandle = await startServer({
      dataDir: p.dataDir,
      tempDir: p.tempDir,
      vendorDir: p.vendorDir,
      edgeSecret,
      jwtSecret: signingKey,
      webRoot: p.webRoot,
      version: app.getVersion(),
    });
  } catch (err) {
    if (err instanceof ServerNotBuilt) {
      dialog.showErrorBox('LocalCast', err.message);
      app.quit();
      return;
    }
    throw err;
  }

  const operator = new OperatorClient(serverHandle.port, edgeSecret);

  let binaryPath: string | undefined;
  try {
    binaryPath = NetEdge.resolveBinary(app.getAppPath(), process.resourcesPath);
  } catch (err) {
    // The sidecar is a separate Go build. Without it there is no remote access, but the panel
    // must still open so the user can see what is wrong and manage folders and devices.
    if (!(err instanceof NetEdgeBinaryMissing)) throw err;
    binaryPath = undefined;
  }

  edge = new NetEdge({
    stateDir: join(p.dataDir, 'tsnet'),
    configPath: join(p.dataDir, 'netedge.json'),
    upstream: `127.0.0.1:${serverHandle.port}`,
    sharedSecret: edgeSecret,
    ...(binaryPath ? { binaryPath } : {}),
  });

  edge.on('log', (level, message) => {
    const line = `[netedge] ${message}`;
    if (level === 'error') console.error(line);
    else console.log(line);
  });

  trayWindow = createTrayWindow(p.preloadDir);
  tray = new AppTray(p.assetsDir, trayWindow, {
    onOpenPanel: () => openPanel(),
    onAddDevice: () => openPanel('/panel/pairing'),
    onFolders: () => openPanel('/panel/folders'),
    onSettings: () => openPanel('/panel/settings'),
    onQuit: () => {
      quitting = true;
      app.quit();
    },
  }, appConfig.get().locale);

  edge.on('status', (status: EdgeStatus) => {
    tray?.update(status);
    // Hand the MagicDNS name to the server as soon as the node has one, so the next QR code
    // carries the address devices can actually reach. It changes again on a mode switch,
    // which is why this follows the status stream rather than being read once at boot.
    if (status.host) serverHandle?.setPublicHost(status.host);
  });
  tray.update(edge.status);

  registerIpc({
    edge,
    operator: () => operator,
    appConfig,
    version: app.getVersion(),
    serverPort: () => serverHandle?.port ?? 0,
    restartEdge: async (config: NetworkConfig): Promise<EdgeStatus> => {
      if (!edge) throw new Error('network edge is not running');
      return edge.applyConfig(config);
    },
  });

  if (binaryPath) {
    // Failure to come up is a state the UI already knows how to show, so it is surfaced
    // through the status stream rather than thrown into a dialog the user cannot act on.
    void edge.start().catch((err: unknown) => {
      console.error('[netedge] failed to start:', err);
    });
  }

  if (!appConfig.get().setupComplete) {
    wizardWindow = createWizardWindow(p.preloadDir);
    wizardWindow.on('closed', () => {
      wizardWindow = null;
      if (appConfig.get().setupComplete) openPanel();
    });
  } else if (!appConfig.get().startMinimised) {
    openPanel();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openPanel();
  });
}

function openPanel(route = '/panel'): void {
  const p = paths();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('navigate', route);
    return;
  }
  mainWindow = createMainWindow(p.preloadDir);
  mainWindow.on('close', (event) => {
    // Closing the panel leaves the server running; the tray is the app's real home. Quitting
    // is an explicit choice from the tray menu, because closing a window should not silently
    // cut off every device that is streaming from it.
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// The server keeps running with every window closed. That is the point of a tray app.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (event) => {
  if (!edge && !serverHandle) return;
  event.preventDefault();
  void (async () => {
    tray?.destroy();
    tray = null;
    await edge?.stop().catch(() => undefined);
    edge = null;
    await serverHandle?.dispose().catch(() => undefined);
    serverHandle = null;
    app.quit();
  })();
});

// A crash that takes the process down without stopping the sidecar would leave an orphaned
// tsnet node holding the hostname, and the next start would come up under a different name.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
  void edge?.stop().finally(() => process.exit(1));
});
