/**
 * Builds one app and everything it depends on, in dependency order.
 *
 *   node scripts/build-app.mjs apps/desktop
 *
 * `npm run build --workspaces` runs alphabetically, which builds client-core against a
 * contract that does not exist yet. The order here is the real one.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspaces each app needs built before it, in order. ui-kit publishes from source. */
const DEPENDENCIES = {
  'apps/desktop': ['@localcast/contract', '@localcast/client-core', '@localcast/server', '@localcast/pwa'],
  'apps/desktop-client': ['@localcast/contract', '@localcast/client-core'],
};

const app = process.argv[2];
const workspace = { 'apps/desktop': '@localcast/desktop', 'apps/desktop-client': '@localcast/desktop-client' }[app];
if (!workspace) {
  console.error(`usage: node scripts/build-app.mjs <${Object.keys(DEPENDENCIES).join(' | ')}>`);
  process.exit(1);
}

for (const target of [...DEPENDENCIES[app], workspace]) {
  console.log(`building ${target}`);
  const result = spawnSync('npm', ['run', 'build', '--workspace', target], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
