/**
 * Runs immediately before `electron-builder`, from `npm run package -w @localcast/desktop`.
 *
 * It exists for one reason: **neither `native/netedge/netedge.exe` nor `vendor/bin` is
 * committed**, and electron-builder's response to an `extraResources` source that does not
 * exist is a single `file source doesn't exist` warning in a log full of other lines. The
 * build then succeeds and produces an installer with no remote access, or no printing, and
 * nothing says so until a user hits it.
 *
 * So: create the directory the copy step needs (an empty `vendor/bin` copies nothing and
 * upsets no one), and say plainly what this installer is going to be missing. It does not
 * fail the build — packaging without the print helper is a legitimate thing to do — it just
 * refuses to let it happen quietly.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const vendorBin = join(ROOT, 'vendor', 'bin');
mkdirSync(vendorBin, { recursive: true });

/**
 * Flatten the Electron binding to a stable name.
 *
 * rebuild-native.mjs writes it to vendor/native/electron-<abi>/, because more than one may
 * exist while Electron is being upgraded. electron-builder's from/to preserves the directory
 * structure under `from`, so packaging that directory directly would land the file at
 * resources/native/electron-130/better_sqlite3.node while main/index.ts joins
 * resources/native/better_sqlite3.node. Copying the current one up a level keeps the ABI in
 * the build output's name where it belongs and out of the runtime path.
 */
const nativeDir = join(ROOT, 'vendor', 'native');
mkdirSync(nativeDir, { recursive: true });
const flattened = join(nativeDir, 'better_sqlite3.node');
const abiDirs = existsSync(nativeDir)
  ? readdirSync(nativeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('electron-'))
      .map((e) => join(nativeDir, e.name, 'better_sqlite3.node'))
      .filter((f) => existsSync(f))
  : [];
if (abiDirs.length > 0) {
  // Newest wins if an old ABI is still lying around from a previous Electron.
  abiDirs.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  copyFileSync(abiDirs[abiDirs.length - 1], flattened);
}

const artefacts = [
  {
    path: flattened,
    missing:
      'No better_sqlite3 built for Electron. This installer will start and then die at its\n' +
      '  first database call with a NODE_MODULE_VERSION error.\n' +
      '  Build it with: npm run rebuild:native',
  },
  {
    path: join(ROOT, 'native', 'netedge', 'netedge.exe'),
    missing:
      'netedge.exe is not built. This installer will have NO access from outside the local\n' +
      '  network — no tailnet, no TLS, no remote client at all.\n' +
      '  Build it with: npm run netedge:build   (needs Go 1.23+)',
  },
  {
    path: join(vendorBin, 'SumatraPDF.exe'),
    missing:
      'SumatraPDF.exe is not in vendor/bin. This installer will not be able to print;\n' +
      '  print jobs fail with a message saying the helper is missing.\n' +
      '  See vendor/README.md.',
  },
  {
    path: join(ROOT, 'apps', 'pwa', 'dist', 'index.html'),
    missing:
      'The PWA is not built, so the server would have nothing to serve to phones.\n' +
      '  Build it with: npm run build',
  },
];

const absent = artefacts.filter((a) => !existsSync(a.path));
if (absent.length > 0) {
  console.warn('\n────────────────────────────────────────────────────────────────');
  console.warn('PACKAGING WITH MISSING PARTS');
  for (const a of absent) console.warn(`\n  ${a.missing}`);
  console.warn('\n  npm run doctor explains all of this.');
  console.warn('────────────────────────────────────────────────────────────────\n');
} else {
  console.log('prepack: netedge, the print helper and the built PWA are all present.');
}
