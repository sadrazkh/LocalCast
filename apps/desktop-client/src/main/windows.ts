import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

/**
 * The single window this app has.
 *
 * The security posture matches the server app's exactly — `contextIsolation` on,
 * `nodeIntegration` off, `sandbox` on, a CommonJS preload exposing named methods — even
 * though this app holds no operator privilege at all. The renderer here can still ask the
 * main process to write files to the user's disk, and it displays file names, folder labels
 * and error prose that arrived over the network from a machine somebody else administers.
 * That is exactly the input a `nodeIntegration: true` renderer would turn into a problem.
 */

const isDev = !!process.env.VITE_DEV_SERVER_URL;

/** The Windows surfaces are drawn at 1000×640 on the design canvas. */
export function createClientWindow(preloadDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: '#0d0e12',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0e12', symbolColor: '#8a8f98', height: 38 },
    webPreferences: {
      preload: join(preloadDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  hardenNavigation(win);

  if (isDev) {
    void win.loadURL(`${process.env.VITE_DEV_SERVER_URL}`);
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }
  return win;
}

/**
 * Nothing in this app navigates away from its own bundle, and nothing opens a window of its
 * own. External links — the native-player handoff, a help page — go to the user's real
 * browser, where they can see the address bar.
 *
 * This matters more here than in the server app: the strings that become links in this
 * renderer come from a remote server's file index.
 */
export function hardenNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.VITE_DEV_SERVER_URL;
    const allowed = dev ? url.startsWith(dev) : url.startsWith('file://');
    if (allowed) return;
    event.preventDefault();
    if (isExternallyOpenable(url)) void shell.openExternal(url);
  });
}

/**
 * Which URLs may be handed to the operating system.
 *
 * `https` and `http` only. Not `file:` (that would open a local path a remote server named)
 * and emphatically nothing exotic — `shell.openExternal` will happily launch a handler for a
 * scheme nobody expected, and every string reaching here originated on another machine.
 */
export function isExternallyOpenable(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}
