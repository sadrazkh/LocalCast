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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { electronBindingPath, installedElectronVersion, nativeStatus } from './rebuild-native.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

/**
 * state: 'ok' | 'blocking' | 'degrading' | 'limited'. `fix` is a command or a document to read.
 *
 * `limited` is `degrading` with a different word in front of it: the feature works, but not
 * completely. "absent  image printing" would be a lie on a machine where six of the eight
 * image types print perfectly well.
 */
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
  // What matters is the Electron-ABI copy beside the tree, not the one in node_modules.
  // node_modules is deliberately left on Node's ABI so the test suite runs; the app loads its
  // own copy through better-sqlite3's nativeBinding option. Judging node_modules would
  // condemn a working install and send the user to run a rebuild that undoes nothing.
  for (const mod of nativeStatus()) {
    if (mod.file === null) {
      report('blocking', mod.name, 'no compiled binding', 'npm install');
      continue;
    }
    if (mod.wanted === null) {
      report('ok', mod.name, `built for ABI ${mod.abi}; Electron's ABI could not be resolved`);
      continue;
    }
    const sideCopy = electronBindingPath(mod.wanted);
    if (existsSync(sideCopy)) {
      report('ok', mod.name, `Electron ${electron} binding present (ABI ${mod.wanted}); node_modules on ABI ${mod.abi} for tests`);
    } else {
      report(
        'blocking',
        mod.name,
        `no Electron ${electron} binding (ABI ${mod.wanted}) — the app will die with ` +
          '"NODE_MODULE_VERSION" at its first database call',
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
// Degrading by design: everything except printing works without the helper, and the app says
// so rather than pretending a job was queued.
//
// "printing may not work" is not worth printing. What a user can act on is *which* things
// print and *why* the rest do not, because the two reasons have two different fixes: the
// helper is missing, or Windows has no application registered to print that type. So this
// section asks the registry the same question `modules/print/spooler.ts` asks per job.
const INSTALL_HELPER = 'node scripts/install-print-helper.mjs';

const sumatra = ['SumatraPDF.exe', 'SumatraPDF-portable.exe', 'sumatrapdf.exe'].some((name) =>
  existsSync(join(ROOT, 'vendor', 'bin', name)),
);
report(
  sumatra ? 'ok' : 'degrading',
  'print helper',
  sumatra
    ? 'vendor/bin/SumatraPDF.exe'
    : 'vendor/bin/SumatraPDF.exe is missing — see the two lines below for what still prints',
  `${INSTALL_HELPER}   (it stages and shows you the digest; it installs nothing on its own)`,
);

if (sumatra && !existsSync(join(ROOT, 'vendor', 'checksums.json'))) {
  report(
    'degrading',
    'print helper digest',
    'vendor/checksums.json does not exist, so nothing verifies which binary this is',
    'node scripts/verify-vendor.mjs --record',
  );
}

/**
 * Which extensions the shell has a `PrintTo` verb for.
 *
 * The counterpart of `PRINT_TO_PROBE_SCRIPT` in `apps/server/src/modules/print/spooler.ts`,
 * asked once for every type instead of once per job. That module is the authority — it is
 * what actually refuses a job — and this is the preflight; if you change one, change both.
 * Returns null when the question could not be asked at all, which is not the same answer as
 * "no handler".
 */
function printToHandlers(extensions) {
  if (process.platform !== 'win32') return null;
  const script = [
    '$out=@();',
    "foreach($ext in ($env:LC_EXTS -split ',')){",
    '$ids=@();',
    "$uc=(Get-ItemProperty -LiteralPath ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\'+$ext+'\\UserChoice') -Name ProgId -ErrorAction SilentlyContinue).ProgId;",
    'if($uc){$ids+=$uc};',
    "$assoc=(Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\'+$ext) -Name '(default)' -ErrorAction SilentlyContinue).'(default)';",
    'if($assoc){$ids+=$assoc};$hit=$null;',
    "foreach($id in $ids){ if(-not $hit -and (Test-Path -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\'+$id+'\\shell\\printto'))){$hit=$id} };",
    "if(-not $hit -and (Test-Path -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\SystemFileAssociations\\'+$ext+'\\shell\\printto'))){$hit='SystemFileAssociations'+$ext};",
    '$out+=[pscustomobject]@{Ext=$ext;ProgId=[string]$hit;PrintTo=[bool]$hit}};',
    '$out|ConvertTo-Json -Compress',
  ].join('');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      // The extension list travels in the environment, never spliced into the script.
      env: { ...process.env, LC_EXTS: extensions.join(',') },
    },
  );
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse((result.stdout || '').trim() || 'null');
    if (parsed === null) return null;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return new Map(rows.map((row) => [row.Ext, { printTo: row.PrintTo === true, progId: row.ProgId || null }]));
  } catch {
    return null;
  }
}

// The image types `assertPrintable` accepts, minus PDF.
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp'];
const handlers = printToHandlers(['.pdf', ...IMAGE_EXTENSIONS]);

if (process.platform !== 'win32') {
  report('ok', 'print preflight', `skipped: printing is Windows-only and this is ${process.platform}`);
} else if (handlers === null) {
  report(
    'degrading',
    'print preflight',
    'the registry could not be read, so which types will print is unknown',
    'Run this from a normal PowerShell-capable shell; printing itself may still work',
  );
} else if (sumatra) {
  // With the helper there is nothing to work out: it renders and prints every type LocalCast
  // accepts, and it is the only path that can carry copies, duplex and a page range.
  report('ok', 'image printing', 'through the bundled helper — all accepted image types');
  report('ok', 'PDF printing', 'through the bundled helper, including copies, duplex and page ranges');
} else {
  const can = IMAGE_EXTENSIONS.filter((ext) => handlers.get(ext)?.printTo);
  const cannot = IMAGE_EXTENSIONS.filter((ext) => !handlers.get(ext)?.printTo);
  // Degrading, never blocking: LocalCast is a file server that also prints, and refusing to
  // start over a missing print path would be the wrong trade — the app already tells the user
  // per job. `npm run doctor` runs in CI, where a runner has no image handlers at all.
  report(
    can.length > 0 ? 'limited' : 'degrading',
    'image printing',
    can.length === 0
      ? 'no image type has a Windows PrintTo handler on this machine — no image will print'
      : `${can.join(' ')} print through Windows itself` +
        (cannot.length ? `; ${cannot.join(' ')} will be refused — no PrintTo handler` : ''),
    `${INSTALL_HELPER}   (the helper prints every type, and is the only way to ask for copies, duplex or a page range)`,
  );

  const pdf = handlers.get('.pdf');
  report(
    pdf?.printTo ? 'limited' : 'degrading',
    'PDF printing',
    pdf?.printTo
      ? `through ${pdf.progId}, which registered a Windows PrintTo handler — one copy, ` +
        'single-sided, whole document only'
      : 'PDFs will NOT print. No reader on this machine registers a PrintTo handler, which is ' +
        'the case on a clean Windows: Edge can open a PDF but not print one from the shell',
    pdf?.printTo
      ? `${INSTALL_HELPER}   (needed for copies, duplex or a page range)`
      : `${INSTALL_HELPER}   (PDF printing needs a reader; this installs the bundled one)`,
  );
}

// ── Report ──────────────────────────────────────────────────────────────────────────────
const label = { ok: 'ok      ', blocking: 'MISSING ', degrading: 'absent  ', limited: 'limited ' };
console.log('\nLocalCast prerequisites\n');
for (const check of checks) {
  console.log(`  ${label[check.state]}${check.name.padEnd(16)}${check.detail}`);
  if (check.state !== 'ok' && check.fix) console.log(`  ${' '.repeat(8)}fix: ${check.fix}`);
}

const blocking = checks.filter((c) => c.state === 'blocking').length;
const degrading = checks.filter((c) => c.state === 'degrading' || c.state === 'limited').length;
console.log(
  `\n${blocking} blocking, ${degrading} degrading. ` +
    'What each of these is and why LocalCast needs it: docs/prerequisites.md\n',
);
process.exit(blocking > 0 ? 1 : 0);
