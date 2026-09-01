/**
 * `npm run dev` — Vite and Electron together.
 *
 * Two Vite servers, because the repository has two renderers:
 *
 * - **apps/desktop on :5174** is the Electron renderer (wizard, panel, tray popover). Its URL
 *   goes into `VITE_DEV_SERVER_URL`, which is what `src/main/windows.ts` reads to decide
 *   between `loadURL` and `loadFile`. This one must be the desktop server, not the PWA: the
 *   window is opened at `#/panel`, a route only this bundle has.
 * - **apps/pwa on :5173** is the phone client. The same `VITE_DEV_SERVER_URL` makes the main
 *   process leave `webRoot` empty, so in development the Node server does *not* serve the
 *   built PWA and Vite serves it instead — which is the only way to get hot reload on the
 *   surface most of the product lives on.
 *
 * A script rather than a one-line npm chain, because ordering and cleanup both matter:
 * Electron must not open a window before :5174 answers (it would load a connection error and
 * sit there), and when any one of the three dies the other two have to die with it, or the
 * next run finds :5174 held by an orphan and `strictPort` refuses to start.
 *
 * Note: the PWA dev server proxies /api and /dav to `LOCALCAST_DEV_API`, defaulting to
 * :8420. The desktop app binds an ephemeral port, so set that variable to the port the app
 * logs if you want the PWA dev server talking to a running desktop instance.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNativeModules } from './rebuild-native.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const RENDERER_URL = 'http://localhost:5174';

const children = [];
let shuttingDown = false;

/** npm is a .cmd on Windows, which Node refuses to spawn without a shell since 20.x. */
function run(command, cwd) {
  const result = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * Vite's entry, by path rather than by `require.resolve`: its package exports map does not
 * expose `bin/vite.js`, and going through the .cmd shim would put a shell between us and the
 * process we later have to kill.
 */
function viteBin() {
  for (const dir of [ROOT, join(ROOT, 'apps', 'desktop')]) {
    const candidate = join(dir, 'node_modules', 'vite', 'bin', 'vite.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('vite is not installed. Run `npm install` first.');
}

/** Starts a Vite server as a direct child of this process, so killing it actually kills it. */
function vite(appDir, label) {
  const child = spawn(process.execPath, [viteBin()], {
    cwd: join(ROOT, appDir),
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`\n[dev] the ${label} dev server exited (${code}). Shutting the rest down.`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

ensureNativeModules();

// The renderer is served by Vite, but the main and preload scripts are plain tsc output that
// Electron loads from disk — without this step `npm run dev` runs whatever was last built,
// which is the sort of thing that costs an hour before anyone suspects the build.
run('npm run build:main -w @localcast/desktop', ROOT);

// A fresh clone has no compiled workspace packages, and the main process imports
// @localcast/server from its dist. Build everything once rather than failing at boot.
if (!existsSync(join(ROOT, 'apps', 'server', 'dist', 'index.js'))) {
  console.log('[dev] workspace packages are not built yet — running npm run build once.');
  run('npm run build', ROOT);
}

vite('apps/desktop', 'desktop renderer');
vite('apps/pwa', 'PWA');

if (!(await waitFor(RENDERER_URL))) {
  console.error(`[dev] ${RENDERER_URL} never answered. Not starting Electron.`);
  shutdown(1);
}

const electron = spawn(require('electron'), ['.'], {
  cwd: join(ROOT, 'apps', 'desktop'),
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: RENDERER_URL },
});
children.push(electron);
electron.on('exit', (code) => shutdown(code ?? 0));
