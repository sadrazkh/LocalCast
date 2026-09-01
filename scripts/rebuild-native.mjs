/**
 * Rebuilds LocalCast's native modules against Electron's ABI.
 *
 * `npm install` compiles `better-sqlite3` against the ABI of the Node binary that ran the
 * install. Electron embeds a different one, so the module npm just produced is the wrong
 * shape for the runtime that has to load it, and the app dies at its first database call:
 *
 *   Error: The module '\\?\...\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
 *   was compiled against a different Node.js version using
 *   NODE_MODULE_VERSION 127. This version of Node.js requires
 *   NODE_MODULE_VERSION 130.
 *
 * This file exists so the fix stops being folklore. It runs from `postinstall`, from
 * `npm start` and from `npm run dev`, it is a no-op when the binding is already correct, and
 * it reads the Electron version from the installed package rather than repeating a number
 * that is wrong the day Electron is upgraded.
 *
 *   node scripts/rebuild-native.mjs            # rebuild only if the ABI does not match
 *   node scripts/rebuild-native.mjs --force    # rebuild regardless
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * The modules that carry a compiled binding. Listed rather than discovered: rebuilding
 * everything takes minutes, and this is on the path of every `npm start`.
 */
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

/** Where node-gyp leaves the compiled binding, or null when the module was never built. */
export function bindingPath(moduleName) {
  const dir = join(ROOT, 'node_modules', moduleName, 'build', 'Release');
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((name) => name.endsWith('.node'));
  return file ? join(dir, file) : null;
}

/**
 * The ABI a compiled binding was built for.
 *
 * A `.node` file carries no header we can read, so the binding is asked directly: loading it
 * here either succeeds — in which case it was built for *this* Node, whose ABI we already
 * know — or throws an error naming the version it wants. The inversion is the whole point.
 * Under plain Node, the binding that loads cleanly is the broken one, because Electron is
 * the runtime that actually has to load it.
 */
export function bindingAbi(file) {
  try {
    process.dlopen({ exports: {} }, file);
    return Number(process.versions.modules);
  } catch (err) {
    const match = /NODE_MODULE_VERSION (\d+)/.exec(err instanceof Error ? err.message : '');
    return match ? Number(match[1]) : null;
  }
}

/**
 * Electron's ABI for a given version, via `node-abi` (already present as a dependency of
 * electron-builder). Null when it cannot be resolved — that is a reason to report less, not
 * a reason to fail.
 */
export function electronAbi(version) {
  try {
    return Number(require('node-abi').getAbi(version, 'electron'));
  } catch {
    return null;
  }
}

/** One row per native module: what it was built for, and what it needs to be built for. */
export function nativeStatus() {
  const electron = installedElectronVersion();
  const wanted = electron ? electronAbi(electron) : null;
  return NATIVE_MODULES.map((name) => {
    const file = bindingPath(name);
    return { name, file, abi: file ? bindingAbi(file) : null, wanted, electron };
  });
}

/** The `@electron/rebuild` CLI entry, read from its manifest so no path is hard-coded. */
function rebuildCli() {
  // The shim npm generated, not the package's entry file. @electron/rebuild 3.7 ships a CLI
  // that does not survive being handed straight to `node` — invoking it that way exits -1
  // with no diagnostic, while the shim runs it exactly as `npx` would.
  const shim = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild');
  return existsSync(shim) ? shim : null;
}

/**
 * Brings the native modules in line with the installed Electron.
 *
 * Returns 'skipped' (nothing to do here), 'ok' (already correct) or 'rebuilt'. Throws with an
 * actionable message when the rebuild itself fails.
 */
export function ensureNativeModules({ force = false, quiet = false } = {}) {
  const say = (line) => {
    if (!quiet) console.log(line);
  };

  const electron = installedElectronVersion();
  if (!electron) {
    say('rebuild:native  Electron is not installed — nothing to rebuild.');
    return 'skipped';
  }

  const status = nativeStatus();
  const missing = status.filter((m) => m.file === null);
  if (missing.length === status.length) {
    say(
      `rebuild:native  ${missing.map((m) => m.name).join(', ')} is not installed — run npm install.`,
    );
    return 'skipped';
  }

  const wanted = status[0].wanted;

  // The question is no longer "is node_modules on Electron's ABI" — it should not be, because
  // the test suite runs under Node. It is "does the side copy the app loads already exist".
  if (!force && wanted !== null && existsSync(electronBindingPath(wanted))) {
    say(`rebuild:native  Electron ${electron} binding already present (ABI ${wanted}) — nothing to do.`);
    return 'ok';
  }

  const cli = rebuildCli();
  if (!cli) {
    throw new Error(
      '@electron/rebuild is not installed. Run `npm install` first; if that does not fix it, ' +
        'the root devDependency is missing from package.json.',
    );
  }

  const names = NATIVE_MODULES.join(',');
  say(`rebuild:native  rebuilding ${names} against Electron ${electron}…`);

  // Same invocation as the one verified by hand, with the version read rather than typed.
  // `-f` because @electron/rebuild otherwise trusts its own cache marker, which survives the
  // exact situation this script exists for.
  const result = spawnSync(cli, ['-f', '-w', names, '-v', electron], {
    cwd: ROOT,
    stdio: quiet ? 'pipe' : 'inherit',
    // The Windows shim is a .cmd; Node refuses to spawn one without a shell.
    shell: process.platform === 'win32',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `@electron/rebuild exited with ${result.status}. Run it yourself to see why:\n` +
        `  npx @electron/rebuild -f -w ${names} -v ${electron}\n` +
        'On Windows a compile from source needs the Visual Studio Build Tools (Desktop ' +
        'development with C++). See docs/prerequisites.md.',
    );
  }

  // Trust the result no further than the check that started this: ask the binding again.
  const after = nativeStatus();
  const bad = after.filter((m) => m.wanted !== null && m.abi !== m.wanted);
  if (bad.length > 0) {
    throw new Error(
      `@electron/rebuild reported success but ${bad
        .map((m) => `${m.name} is still ABI ${m.abi}, not ${m.wanted}`)
        .join('; ')}.`,
    );
  }

  // Park the Electron binding beside the tree and put node_modules back on Node's ABI.
  //
  // A compiled binding is tied to one ABI and this repo has two hosts: Node runs the tests,
  // Electron runs the app. Leaving the Electron build in node_modules makes them take turns —
  // whichever ran last works, the other dies on NODE_MODULE_VERSION — so the app is pointed
  // at its own copy instead and both work at once.
  stashElectronBinding(after[0].abi);
  restoreNodeBinding();

  say(`rebuild:native  Electron ${electron} binding stored (ABI ${after[0].abi}); node_modules left on Node's.`);
  return 'rebuilt';
}

/** Where the app looks for its binding; mirrored by `paths()` in apps/desktop/src/main/index.ts. */
export function electronBindingPath(abi) {
  return join(ROOT, 'vendor', 'native', `electron-${abi}`, 'better_sqlite3.node');
}

function stashElectronBinding(abi) {
  const built = join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const dest = electronBindingPath(abi);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(built, dest);
}

/**
 * Rebuilds node_modules against the Node that is running this script, so `npm test` works
 * immediately afterwards. `npm rebuild` is enough: it is the plain node-gyp path.
 */
function restoreNodeBinding() {
  const result = spawnSync(npmCommand(), ['rebuild', ...NATIVE_MODULES], {
    cwd: ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    say(
      'rebuild:native  warning: could not restore the Node binding in node_modules. ' +
        'The app will run, but `npm test` will fail until you run `npm rebuild better-sqlite3`.',
    );
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensureNativeModules({ force: process.argv.includes('--force') });
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
