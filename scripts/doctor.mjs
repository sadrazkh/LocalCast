/**
 * `npm run doctor` — checks LocalCast's prerequisites from a terminal.
 *
 * The counterpart to the in-app prerequisites screen, for the moment before there is an app
 * to show it in. It imports nothing from `apps/desktop`: a tool whose job is to explain why
 * the app will not start must not need the app to start.
 *
 * Exits non-zero when something blocking is missing, so CI and `&&` chains notice.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedElectronVersion, nativeStatus } from './rebuild-native.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

/** state: 'ok' | 'blocking' | 'degrading'. `fix` is a command or a document to read. */
function report(state, name, detail, fix) {
  checks.push({ state, name, detail, fix });
}

function version(command) {
  const result = spawnSync(command, { encoding: 'utf8', shell: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

// ── Node ────────────────────────────────────────────────────────────────────────────────
// `engines.node` says 22, and the build depends on it: the Vite configs use
// `import.meta.dirname`, which does not exist before Node 20.11 and is the kind of failure
// that reads as a broken config file rather than an old runtime.
const nodeMajor = Number(process.versions.node.split('.')[0]);
report(
  nodeMajor >= 22 ? 'ok' : 'blocking',
  'Node',
  `${process.versions.node} (needs 22 or newer)`,
  'Install Node 22 LTS from https://nodejs.org/en/download',
);

const npmVersion = version('npm --version');
report(
  npmVersion ? 'ok' : 'blocking',
  'npm',
  npmVersion ?? 'not found',
  'Reinstall Node; npm ships with it',
);

// ── Dependencies and the native build ───────────────────────────────────────────────────
const electron = installedElectronVersion();
if (!electron) {
  report('blocking', 'dependencies', 'node_modules/electron is missing', 'npm install');
} else {
  for (const mod of nativeStatus()) {
    if (mod.file === null) {
      report('blocking', mod.name, 'no compiled binding', 'npm install');
    } else if (mod.wanted === null) {
      report('ok', mod.name, `built for ABI ${mod.abi}; Electron's ABI could not be resolved`);
    } else if (mod.abi === mod.wanted) {
      report('ok', mod.name, `built for Electron ${electron} (ABI ${mod.wanted})`);
    } else {
      report(
        'blocking',
        mod.name,
        `built for ABI ${mod.abi}, Electron ${electron} requires ${mod.wanted} — ` +
          'the app will die with "NODE_MODULE_VERSION" at its first database call',
        'npm run rebuild:native',
      );
    }
  }
}

// ── Go and the network edge ─────────────────────────────────────────────────────────────
// netedge is the whole of remote access. Without the binary, LocalCast is a file browser for
// the machine it is already running on.
const goVersion = version('go version');
const goSemver = goVersion ? /go(\d+)\.(\d+)/.exec(goVersion) : null;
const goOk = goSemver ? Number(goSemver[1]) > 1 || Number(goSemver[2]) >= 23 : false;
const edgeBuilt = existsSync(join(ROOT, 'native', 'netedge', 'netedge.exe'));

report(
  edgeBuilt ? 'ok' : 'blocking',
  'netedge',
  edgeBuilt
    ? 'native/netedge/netedge.exe'
    : 'native/netedge/netedge.exe is missing — no access from outside the local network',
  'npm run netedge:build',
);

// Go is only needed to produce that binary, so a built sidecar downgrades this to a note.
report(
  goOk ? 'ok' : edgeBuilt ? 'degrading' : 'blocking',
  'Go toolchain',
  goVersion ?? 'not found (needs 1.23 or newer, to build netedge)',
  'Install Go from https://go.dev/dl/',
);

// ── Printing ────────────────────────────────────────────────────────────────────────────
// Degrading by design: everything except printing works without it, and the app says so
// rather than pretending a job was queued.
const sumatra = ['SumatraPDF.exe', 'SumatraPDF-portable.exe', 'sumatrapdf.exe'].some((name) =>
  existsSync(join(ROOT, 'vendor', 'bin', name)),
);
report(
  sumatra ? 'ok' : 'degrading',
  'print helper',
  sumatra
    ? 'vendor/bin/SumatraPDF.exe'
    : 'vendor/bin/SumatraPDF.exe is missing — printing will fail',
  'See vendor/README.md, then: node scripts/verify-vendor.mjs --record',
);

if (sumatra && !existsSync(join(ROOT, 'vendor', 'checksums.json'))) {
  report(
    'degrading',
    'print helper digest',
    'vendor/checksums.json does not exist, so nothing verifies which binary this is',
    'node scripts/verify-vendor.mjs --record',
  );
}

// ── Report ──────────────────────────────────────────────────────────────────────────────
const label = { ok: 'ok      ', blocking: 'MISSING ', degrading: 'absent  ' };
console.log('\nLocalCast prerequisites\n');
for (const check of checks) {
  console.log(`  ${label[check.state]}${check.name.padEnd(16)}${check.detail}`);
  if (check.state !== 'ok' && check.fix) console.log(`  ${' '.repeat(8)}fix: ${check.fix}`);
}

const blocking = checks.filter((c) => c.state === 'blocking').length;
const degrading = checks.filter((c) => c.state === 'degrading').length;
console.log(
  `\n${blocking} blocking, ${degrading} degrading. ` +
    'What each of these is and why LocalCast needs it: docs/prerequisites.md\n',
);
process.exit(blocking > 0 ? 1 : 0);
