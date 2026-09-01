/**
 * Packages one of the Electron apps.
 *
 *   node scripts/package-app.mjs apps/desktop
 *
 * Exists because of one workspace detail with a very unhelpful error message.
 * `electron` is hoisted to the repository's root `node_modules`, but electron-builder looks
 * for it beside the app it is packaging, does not find it, and gives up with:
 *
 *   Cannot compute electron version from installed node modules - none of the possible
 *   electron modules are installed and version ("^33.2.1") is not fixed in project.
 *
 * The obvious fix is to pin an exact version in the config, which is wrong the day Electron
 * is upgraded. So the version is read from the package that is actually installed and handed
 * over on the command line.
 *
 * It also runs the pre-packaging checks first, because electron-builder answers a missing
 * `extraResources` source with a warning and then produces an installer with the piece
 * silently absent.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const appDir = resolve(ROOT, process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: node scripts/package-app.mjs <app directory, e.g. apps/desktop>');
  process.exit(1);
}

/**
 * `shell` is opt-in, not the default. Node lives under `C:\Program Files`, and running it
 * through cmd splits that path at the space — the failure reads `'C:\Program' is not
 * recognized`, which points at nothing useful. Only the `.cmd` shims need a shell.
 */
function run(command, args, { shell = false, ...options } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [join(ROOT, 'scripts', 'prepack.mjs')], { cwd: ROOT });

const electronVersion = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;

console.log(`packaging ${process.argv[2]} against Electron ${electronVersion}`);

run(
  join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'),
  ['--win', 'nsis', '--config.electronVersion', electronVersion],
  { cwd: appDir, shell: process.platform === 'win32' },
);
