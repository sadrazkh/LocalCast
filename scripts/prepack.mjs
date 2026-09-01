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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const vendorBin = join(ROOT, 'vendor', 'bin');
mkdirSync(vendorBin, { recursive: true });

const artefacts = [
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
