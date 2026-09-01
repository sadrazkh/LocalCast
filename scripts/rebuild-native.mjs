/**
 * Puts a `better-sqlite3` binding where each runtime can load it.
 *
 * A compiled binding is tied to one ABI, and this repository has two hosts: Node runs the
 * test suite, Electron runs the app. `npm install` builds for Node, so without this the app
 * dies at its first database call:
 *
 *   Error: The module '...\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
 *   was compiled against a different Node.js version using
 *   NODE_MODULE_VERSION 127. This version of Node.js requires
 *   NODE_MODULE_VERSION 130.
 *
 * Rather than making the two take turns, the Electron binding is parked in
 * `vendor/native/electron-<abi>/` and loaded from there through better-sqlite3's
 * `nativeBinding` option, leaving `node_modules` on Node's ABI for the tests.
 *
 *   node scripts/rebuild-native.mjs            # only if the Electron binding is missing
 *   node scripts/rebuild-native.mjs --force    # fetch it again regardless
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** The modules that carry a compiled binding. Listed rather than discovered. */
export const NATIVE_MODULES = ['better-sqlite3'];

/** The installed Electron version, or null — a server-only checkout has no Electron at all. */
export function installedElectronVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
    );
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** The compiled binding in node_modules, or null when the module was never built. */
export function bindingPath(moduleName) {
  const dir = join(ROOT, 'node_modules', moduleName, 'build', 'Release');
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((name) => name.endsWith('.node'));
  return file ? join(dir, file) : null;
}

/**
 * The ABI a binding was built for.
 *
 * A `.node` file carries no readable header, so the binding is asked directly: loading it
 * either succeeds — in which case it was built for the probing runtime — or throws an error
 * naming the version it wants.
 *
 * The probe runs in a **child process**, deliberately. `process.dlopen` here would answer the
 * question and then hold the file open for the life of this process; on Windows that is an
 * exclusive lock, and the very next step fails with EPERM trying to replace the file it just
 * inspected. A check that breaks the thing it is checking is worse than no check.
 */
export function bindingAbi(file) {
  const probe = spawnSync(process.execPath, ['-e', ABI_PROBE, file], { encoding: 'utf8' });
  const value = (probe.stdout ?? '').trim();
  return value ? Number(value) : null;
}

const ABI_PROBE = [
  'try {',
  '  process.dlopen({ exports: {} }, process.argv[1]);',
  '  console.log(process.versions.modules);',
  '} catch (e) {',
  '  const m = /NODE_MODULE_VERSION (\\d+)/.exec(e.message);',
  '  console.log(m ? m[1] : "");',
  '}',
].join('\n');

/**
 * Electron's ABI for a given version, via `node-abi` (already present as a dependency of
 * electron-builder). Null when it cannot be resolved — a reason to report less, not to fail.
 */
export function electronAbi(version) {
  try {
    return Number(require('node-abi').getAbi(version, 'electron'));
  } catch {
    return null;
  }
}

/** One row per native module: what it was built for, and what Electron needs. */
export function nativeStatus() {
  const electron = installedElectronVersion();
  const wanted = electron ? electronAbi(electron) : null;
  return NATIVE_MODULES.map((name) => {
    const file = bindingPath(name);
    return { name, file, abi: file ? bindingAbi(file) : null, wanted, electron };
  });
}

/** Where the app looks for its binding; mirrored by `paths()` in apps/desktop/src/main/index.ts. */
export function electronBindingPath(abi) {
  return join(ROOT, 'vendor', 'native', `electron-${abi}`, 'better_sqlite3.node');
}

/** The tail of a command's output, for an error message that fits on a screen. */
function lastLines(text, count) {
  return text.trim().split(/\r?\n/).slice(-count).join(' ');
}

/**
 * Downloads the published prebuilt binding for one runtime.
 *
 * `prebuild-install` ships with better-sqlite3 and fetches the binary the project already
 * publishes for that runtime and ABI. It replaced `@electron/rebuild` here, and each reason
 * cost a CI run to learn:
 *
 *   - compiling needs a C++ toolchain that a runner may not have, and takes minutes;
 *   - the rebuild API silently rebuilds *nothing* and reports success when pointed at a
 *     workspace root whose own package.json does not depend on the module;
 *   - and the whole dance has to happen twice, once per runtime, for a file that can simply
 *     be downloaded.
 */
function fetchPrebuild(moduleName, runtime, target) {
  const shim = join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install',
  );
  if (!existsSync(shim)) return { ok: false, message: 'prebuild-install is not installed' };

  const result = spawnSync(
    shim,
    ['--runtime', runtime, '--target', target, '--arch', process.arch, '--platform', process.platform],
    {
      cwd: join(ROOT, 'node_modules', moduleName),
      encoding: 'utf8',
      // The Windows shim is a .cmd; Node will not spawn one without a shell.
      shell: process.platform === 'win32',
    },
  );
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    message: `${runtime}@${target}: ${lastLines(result.stderr || result.stdout || '', 3)}`,
  };
}

function stashElectronBinding(abi) {
  const built = bindingPath(NATIVE_MODULES[0]);
  const dest = electronBindingPath(abi);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(built, dest);
}

/**
 * Ensures the Electron binding exists and node_modules is left on Node's ABI.
 *
 * Returns 'skipped' (nothing to do here), 'ok' (already present) or 'rebuilt'.
 */
export async function ensureNativeModules({ force = false, quiet = false } = {}) {
  const say = (line) => {
    if (!quiet) console.log(line);
  };

  const electron = installedElectronVersion();
  if (!electron) {
    say('rebuild:native  Electron is not installed — nothing to do.');
    return 'skipped';
  }

  const status = nativeStatus();
  if (status.every((m) => m.file === null)) {
    say(`rebuild:native  ${NATIVE_MODULES.join(', ')} is not installed — run npm install.`);
    return 'skipped';
  }

  const wanted = status[0].wanted;

  // The question is not "is node_modules on Electron's ABI" — it should not be, because the
  // tests run under Node. It is "does the copy the app loads already exist".
  if (!force && wanted !== null && existsSync(electronBindingPath(wanted))) {
    say(`rebuild:native  Electron ${electron} binding already present (ABI ${wanted}).`);
    return 'ok';
  }

  const names = NATIVE_MODULES.join(', ');
  say(`rebuild:native  fetching the Electron ${electron} binding for ${names}…`);

  for (const name of NATIVE_MODULES) {
    const forElectron = fetchPrebuild(name, 'electron', electron);
    if (!forElectron.ok) {
      throw new Error(
        [
          `could not obtain an Electron ${electron} binding for ${name}.`,
          `  ${forElectron.message}`,
          '  If no prebuild is published for this combination, compile one with:',
          `    npx electron-rebuild -f -w ${name} -v ${electron}`,
          '  which needs the Visual Studio Build Tools on Windows. See docs/prerequisites.md.',
        ].join('\n'),
      );
    }
  }

  // Confirm before copying. A downloaded file that is not what it claims to be is worse than
  // a failed download, because it fails much later and somewhere else.
  const afterElectron = nativeStatus();
  const wrong = afterElectron.filter((m) => m.wanted !== null && m.abi !== m.wanted);
  if (wrong.length > 0) {
    throw new Error(
      `prebuild-install finished but ${wrong
        .map((m) => `${m.name} is ABI ${m.abi}, not ${m.wanted}`)
        .join('; ')}.`,
    );
  }

  stashElectronBinding(afterElectron[0].abi);

  // Put Node's copy back: the test suite runs under Node while the app runs under Electron.
  // Downloaded rather than compiled, for the same reasons — and it means this step needs no
  // toolchain on a CI runner at all.
  for (const name of NATIVE_MODULES) {
    const forNode = fetchPrebuild(name, 'node', process.versions.node);
    if (!forNode.ok) {
      throw new Error(
        [
          "the Electron binding is in place, but node_modules could not be returned to Node's ABI.",
          `  ${forNode.message}`,
          `  The app will run; the tests will not until you run: npm rebuild ${NATIVE_MODULES.join(' ')}`,
        ].join('\n'),
      );
    }
  }

  say(
    `rebuild:native  Electron ${electron} binding stored (ABI ${afterElectron[0].abi}); ` +
      "node_modules returned to Node's.",
  );
  return 'rebuilt';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await ensureNativeModules({ force: process.argv.includes('--force') });
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
