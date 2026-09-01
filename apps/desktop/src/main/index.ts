import { app, BrowserWindow, dialog } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { EdgeStatus, NetworkConfig } from '@localcast/contract';
import { AppConfigStore, configPathFor } from './appConfig.js';
import { broadcastEdgeStatus, registerIpc } from './ipc.js';
import { NetEdge, NetEdgeBinaryMissing } from './netedge.js';
import { OperatorClient } from './operatorClient.js';
import type { PreflightContext } from './preflight/context.js';
import { registerPreflightIpc } from './preflight/ipc.js';
import { runPreflight } from './preflight/run.js';
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
let operatorClient: OperatorClient | null = null;
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

/**
 * Where a portable build keeps its data, or null for an ordinary install.
 *
 * Portable has to mean the *data* travels too. An executable that needs no installer but
 * still writes to `%APPDATA%` is only half of it: copy the folder to another machine and the
 * paired devices, the permission matrix and the tailnet identity are all left behind, which
 * is the opposite of what someone carrying this on a stick wants.
 *
 * Two ways in, both explicit — nothing here guesses from the install location:
 *   - `PORTABLE_EXECUTABLE_DIR`, which electron-builder's portable target sets to the
 *     directory the user actually launched from (the exe itself unpacks to temp);
 *   - `LOCALCAST_PORTABLE=1`, which the bundled launcher sets for the zip build.
 */
function portableRoot(): string | null {
  const fromBuilder = process.env['PORTABLE_EXECUTABLE_DIR'];
  if (fromBuilder) return join(fromBuilder, 'LocalCast-data');
  if (process.env['LOCALCAST_PORTABLE'] === '1') {
    return join(dirname(app.getPath('exe')), 'LocalCast-data');
  }
  return null;
}

/**
 * This machine's address on the local network, or null when it has none.
 *
 * Skips loopback and link-local, and prefers a private range — a VPN or a container bridge
 * can otherwise supply an address no phone in the house can reach.
 */
function lanAddress(): string | null {
  const candidates: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) continue;
      candidates.push(address.address);
    }
  }
  const isPrivate = (ip: string) =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isPrivate) ?? candidates[0] ?? null;
}

function paths() {
  const portable = portableRoot();
  const dataDir = portable ?? join(app.getPath('appData'), 'LocalCast');
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
    portable: portable !== null,
    // The Electron-ABI copy of better_sqlite3, kept out of node_modules so the Node-ABI copy
    // there stays intact for the test suite. `scripts/rebuild-native.mjs` produces it.
    nativeBinding: app.isPackaged
      ? join(process.resourcesPath, 'native', 'better_sqlite3.node')
      : join(repoRoot, 'vendor', 'native', `electron-${process.versions.modules}`, 'better_sqlite3.node'),
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

  // Prerequisites are checked before anything else is started. A sidecar that was never built
  // or a better-sqlite3 compiled for Node rather than Electron used to surface as a stack
  // trace on a console nobody reads; it is now the first screen, in plain language, with the
  // fix attached to it.
  const preflightCtx: PreflightContext = {
    appRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    repoRoot: p.repoRoot,
    vendorDir: p.vendorDir,
    // The same fallback the server gets, so the check tests what will actually be loaded.
    nativeBinding: existsSync(p.nativeBinding) ? p.nativeBinding : '',
  };

  // Non-null exactly while bootstrap is parked waiting for a blocking prerequisite to be
  // fixed. Cleared before it is called, so a window closing in the same tick as the fix
  // cannot be read as "the user gave up".
  let unblock: (() => void) | null = null;
  registerPreflightIpc(preflightCtx, {
    onReport: (report) => {
      if (!report.canProceed) return;
      const resume = unblock;
      unblock = null;
      resume?.();
    },
  });

  const appConfig = new AppConfigStore(configPathFor(p.dataDir));

  // Registered before the gate, not after. The prerequisites window is opened by the gate
  // below, and a window whose every call answers "No handler registered" is precisely the
  // silent failure this screen exists to replace. The getters return null until the server
  // and the sidecar are up, and the handlers answer with a typed error the UI can show.
  registerIpc({
    edge: () => edge,
    operator: () => {
      if (!operatorClient) throw new Error('The local server has not started yet.');
      return operatorClient;
    },
    appConfig,
    version: app.getVersion(),
    serverPort: () => serverHandle?.port ?? 0,
    restartEdge: async (config: NetworkConfig): Promise<EdgeStatus> => {
      if (!edge) throw new Error('network edge is not running');
      return edge.applyConfig(config);
    },
  });

  const preflight = await runPreflight(preflightCtx);
  if (!preflight.canProceed) {
    // Nothing below here can work, so nothing below here runs: no server, no sidecar, no tray.
    // The wizard opens on its prerequisites step — it reads the same report over
    // `preflight:run` — and bootstrap resumes only once a remedy has actually cleared the
    // blocking items. A degrading item (no print helper) never reaches this branch.
    await new Promise<void>((resume) => {
      unblock = resume;
      wizardWindow = createWizardWindow(p.preloadDir);
      wizardWindow.once('closed', () => {
        wizardWindow = null;
        // Closed while something blocking is still outstanding: there is no tray and nothing
        // running to come back to, so this means "give up", not "hide".
        if (unblock) {
          quitting = true;
          app.quit();
        }
      });
    });
  }

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
      // Falls back to node_modules when the side copy has not been built; the prerequisites
      // screen has already told the user which command produces it.
      nativeBinding: existsSync(p.nativeBinding) ? p.nativeBinding : '',
      lan: appConfig.get().shareOnLan,
    });
  } catch (err) {
    if (err instanceof ServerNotBuilt) {
      dialog.showErrorBox('LocalCast', err.message);
      app.quit();
      return;
    }
    throw err;
  }

  operatorClient = new OperatorClient(serverHandle.port, edgeSecret);

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

  broadcastEdgeStatus(edge);

  // The address a phone on the same Wi-Fi types or scans. Published before netedge has said
  // anything, because on a local network there is nothing to wait for: no sign-in, no
  // coordination server, no certificate.
  if (appConfig.get().shareOnLan) {
    const lan = lanAddress();
    if (lan) serverHandle.setPublicHost(`${lan}:${serverHandle.port}`);
  }

  // Only when the user has asked to be reachable from elsewhere. Starting it unasked is what
  // made the app look broken: it sat on a sign-in screen for a feature most people never use.
  if (binaryPath && appConfig.get().remoteAccess) {
    // Failure to come up is a state the UI already knows how to show, so it is surfaced
    // through the status stream rather than thrown into a dialog the user cannot act on.
    void edge.start().catch((err: unknown) => {
      console.error('[netedge] failed to start:', err);
    });
  }

  if (!appConfig.get().setupComplete) {
    // `??=`: the prerequisites step may already have opened it, and the wizard carries on from
    // there into its normal first-run steps rather than being replaced by a second window.
    wizardWindow ??= createWizardWindow(p.preloadDir);
    wizardWindow.on('closed', () => {
      wizardWindow = null;
      if (appConfig.get().setupComplete) openPanel();
    });
  } else if (wizardWindow) {
    // Setup was already done; that window existed only to show the prerequisites, and they
    // are satisfied now.
    wizardWindow.close();
    wizardWindow = null;
    if (!appConfig.get().startMinimised) openPanel();
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
