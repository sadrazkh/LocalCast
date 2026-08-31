import { BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';

/**
 * Window construction. Three surfaces, all loading the same renderer bundle at different
 * routes: the setup wizard, the main panel, and the tray popover.
 *
 * Every window is created with `nodeIntegration` off and `contextIsolation` on. The renderer
 * reaches the operator API only through the narrow bridge in `preload`, because that API can
 * grant a device access to the user's files.
 */

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function baseWebPreferences(preloadDir: string) {
  return {
    preload: join(preloadDir, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    // The renderer only ever loads our own bundle; nothing here should be following links
    // out into the web.
    navigateOnDragDrop: false,
  } as const;
}

function load(win: BrowserWindow, route: string): void {
  if (isDev) {
    void win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${route}`);
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), { hash: route });
  }
}

/** Canvas sizes come straight from the design: the Windows surfaces are drawn at 1000×640. */
export function createMainWindow(preloadDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: '#0d0e12',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0e12', symbolColor: '#8a8f98', height: 38 },
    webPreferences: baseWebPreferences(preloadDir),
  });

  win.once('ready-to-show', () => win.show());
  hardenNavigation(win);
  load(win, '/panel');
  return win;
}

export function createWizardWindow(preloadDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    show: false,
    backgroundColor: '#0d0e12',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0e12', symbolColor: '#8a8f98', height: 38 },
    webPreferences: baseWebPreferences(preloadDir),
  });
  win.once('ready-to-show', () => win.show());
  hardenNavigation(win);
  load(win, '/wizard');
  return win;
}

/**
 * The tray popover from screen 04. It is frameless, always-on-top and hides on blur, which
 * is what makes it feel like part of the shell rather than a window the user has to manage.
 */
export function createTrayWindow(preloadDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 340,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#0d0e12',
    webPreferences: baseWebPreferences(preloadDir),
  });

  win.on('blur', () => {
    // Keep it open while devtools are attached, otherwise it is impossible to inspect.
    if (!win.webContents.isDevToolsOpened()) win.hide();
  });

  hardenNavigation(win);
  load(win, '/tray');
  return win;
}

/** Positions the popover under the tray icon, clamped to the work area. */
export function positionTrayWindow(win: BrowserWindow, trayBounds: Electron.Rectangle): void {
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const { workArea } = display;
  const [width, height] = win.getSize() as [number, number];

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - width - 8));

  // Taskbars live at the top on some setups, so the popover flips rather than being drawn
  // off-screen above the tray.
  const below = trayBounds.y < workArea.y + workArea.height / 2;
  const y = below ? trayBounds.y + trayBounds.height + 8 : trayBounds.y - height - 8;

  win.setPosition(x, Math.max(workArea.y + 8, y), false);
}

/**
 * Nothing in this app should ever navigate away from its own bundle or open a window of its
 * own. External links go to the user's real browser, which is also how the tsnet login flow
 * is meant to work: the sign-in page must be in a browser the user can see the address bar
 * of, not in a chromeless Electron window.
 */
function hardenNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.VITE_DEV_SERVER_URL;
    const allowed = dev ? url.startsWith(dev) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
}
