/**
 * Copies the non-TypeScript files `tsc` leaves behind into `dist/`.
 *
 * Right now that is the migrations. The server can also find them in the source tree, which
 * is why this went unnoticed in development — but a packaged Electron build ships `dist/`
 * and nothing else, so without this the very first boot on a user's machine fails to create
 * the database at all.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [['src/db/migrations', 'dist/db/migrations']];

let copied = 0;
for (const [from, to] of assets) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.error(`missing asset directory: ${from}`);
    process.exit(1);
  }
  cpSync(src, join(root, to), { recursive: true });
  const files = readdirSync(join(root, to));
  copied += files.length;
  console.log(`${from} -> ${to} (${files.length} files)`);
}

// A silent zero here would mean a build that looks fine and dies on a user's first launch.
if (copied === 0) {
  console.error('no assets were copied; the packaged build would have no migrations');
  process.exit(1);
}
