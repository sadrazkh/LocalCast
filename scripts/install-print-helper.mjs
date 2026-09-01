/**
 * Fetches SumatraPDF, shows you exactly what it got, and installs it only when you say so.
 *
 *   node scripts/install-print-helper.mjs                     # fetch, measure, install nothing
 *   node scripts/install-print-helper.mjs --confirm=<sha256>  # install those exact bytes
 *
 * ## Why this is two steps and not one
 *
 * SumatraPDF publishes **no checksum** for its releases. There is no `SHA256SUMS` to compare
 * against, which is the whole reason `vendor/README.md` forbids the build from downloading it
 * silently: a binary that arrives unattended, from a source that publishes nothing to check it
 * against, is a supply-chain problem wearing a convenience feature's clothes.
 *
 * So the first run only *stages*: it downloads to `vendor/.staging`, computes the digest,
 * asks Windows what the Authenticode signature says, and prints all of it next to the
 * publisher's own page. Nothing moves into `vendor/bin` until a second run repeats the digest
 * back, which is the explicit act this script exists to require.
 *
 * ## What it will refuse
 *
 * - a digest that does not match `--confirm`
 * - a digest that does not match `--expect`, when you were given one out of band
 * - a digest that does not match the one already recorded in `vendor/checksums.json` —
 *   so the second machine to install this **verifies** rather than trusts
 * - a binary Windows will not vouch for, unless `--allow-unsigned` says you know
 *
 * ## Other flags
 *
 *   --from=<path>       use a file you already have instead of downloading
 *   --url=<url>         override the download URL
 *   --version=<x.y.z>   pick a different release of the default URL
 *   --allow-unsigned    proceed although Authenticode did not say "Valid"
 *   --force             replace an existing vendor/bin/SumatraPDF.exe
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPECTED, ROOT, recordDigest, recordedDigest, sha256, verifyVendor } from './verify-vendor.mjs';

/** The one vendored file this script knows how to install. */
const TARGET = EXPECTED[0].path; // vendor/bin/SumatraPDF.exe
const TARGET_ABS = join(ROOT, TARGET);
const STAGING = join(ROOT, 'vendor', '.staging');

const DEFAULT_VERSION = '3.5.2';
const PUBLISHER_PAGE = 'https://www.sumatrapdfreader.org/download-free-pdf-viewer';
const downloadUrl = (version) =>
  `https://www.sumatrapdfreader.org/dl/rel/${version}/SumatraPDF-${version}-64.zip`;

const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

// ── argument parsing ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (const raw of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (!match) throw new Error(`unrecognised argument: ${raw}`);
    if (match[2] === undefined) args.flags.add(match[1]);
    else args.values[match[1]] = match[2];
  }
  return args;
}

const HEX64 = /^[0-9a-f]{64}$/i;

// ── the environment ─────────────────────────────────────────────────────────────────────

function powershell(script, env = {}) {
  const result = spawnSync('powershell.exe', [...POWERSHELL_FLAGS, script], {
    encoding: 'utf8',
    windowsHide: true,
    // Paths travel in the environment, never inside the script text — the same rule the
    // print module follows, for the same reason.
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`powershell failed (${result.status}): ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

/**
 * What Windows itself says about the binary.
 *
 * This is the only publisher-side evidence that exists for SumatraPDF. The digest proves the
 * file did not change on the way to disk; the signature is what ties it to a publisher.
 */
export function authenticode(file) {
  if (process.platform !== 'win32') {
    return { status: 'unchecked', signer: null, note: `not Windows (${process.platform})` };
  }
  try {
    const out = powershell(
      '$s = Get-AuthenticodeSignature -LiteralPath $env:LC_FILE; ' +
        '[pscustomobject]@{ Status = [string]$s.Status; ' +
        'Signer = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress',
      { LC_FILE: file },
    );
    const parsed = JSON.parse(out);
    return { status: parsed.Status || 'Unknown', signer: parsed.Signer || null, note: null };
  } catch (err) {
    // An unreadable answer is not a valid one, and must not be treated as one.
    return { status: 'unchecked', signer: null, note: err instanceof Error ? err.message : String(err) };
  }
}

// ── staging ─────────────────────────────────────────────────────────────────────────────

async function download(url, into) {
  const dest = join(into, basename(new URL(url).pathname) || 'download.bin');
  process.stdout.write(`  fetching       ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`the download failed: ${response.status} ${response.statusText} for ${url}`);
  }
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  return { file: dest, finalUrl: response.url };
}

function findExe(dir) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.exe$/i.test(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** The portable build ships as a zip with the single executable inside it. */
function extractExe(zipFile, into) {
  const outDir = join(into, 'unpacked');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  if (process.platform === 'win32') {
    powershell('Expand-Archive -LiteralPath $env:LC_ZIP -DestinationPath $env:LC_OUT -Force', {
      LC_ZIP: zipFile,
      LC_OUT: outDir,
    });
  } else {
    const result = spawnSync('unzip', ['-o', zipFile, '-d', outDir], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(
        'this archive needs an unzip tool, and none was found. Unpack it yourself and pass ' +
          '--from=<path to SumatraPDF.exe>.',
      );
    }
  }

  const exes = findExe(outDir);
  if (exes.length !== 1) {
    // Guessing which executable to install is exactly the decision this script must not make.
    throw new Error(
      `expected exactly one .exe inside ${basename(zipFile)}, found ${exes.length}` +
        (exes.length ? `: ${exes.map((e) => basename(e)).join(', ')}` : '') +
        '. Unpack it yourself and pass --from=<path>.',
    );
  }
  return exes[0];
}

// ── reporting ───────────────────────────────────────────────────────────────────────────

function report(lines) {
  for (const [label, value] of lines) {
    if (value === null || value === undefined) continue;
    process.stdout.write(`  ${String(label).padEnd(16)} ${value}\n`);
  }
}

// ── the install ─────────────────────────────────────────────────────────────────────────

export async function installPrintHelper(argv = []) {
  const args = parseArgs(argv);
  const confirm = args.values['confirm'];
  const expect = args.values['expect'];
  const version = args.values['version'] ?? DEFAULT_VERSION;
  const url = args.values['url'] ?? downloadUrl(version);

  for (const [name, value] of [['confirm', confirm], ['expect', expect]]) {
    if (value !== undefined && !HEX64.test(value)) {
      throw new Error(`--${name} must be a 64-character SHA-256 in hex, not "${value}".`);
    }
  }

  if (existsSync(TARGET_ABS) && !args.flags.has('force')) {
    throw new Error(
      `${TARGET} already exists. Run \`node scripts/verify-vendor.mjs\` to check it, or pass ` +
        '--force to replace it.',
    );
  }

  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  process.stdout.write('\nStaging the print helper\n\n');

  let artifact;
  let source;
  if (args.values['from']) {
    const from = resolve(args.values['from']);
    if (!existsSync(from)) throw new Error(`--from: no such file: ${from}`);
    artifact = join(STAGING, basename(from));
    copyFileSync(from, artifact);
    source = from;
    report([['from', from]]);
  } else {
    const downloaded = await download(url, STAGING);
    artifact = downloaded.file;
    source = downloaded.finalUrl;
  }

  const exe = /\.zip$/i.test(artifact) ? extractExe(artifact, STAGING) : artifact;
  const artifactDigest = sha256(artifact);
  const exeDigest = sha256(exe);
  const signature = authenticode(exe);
  const previouslyRecorded = recordedDigest(TARGET);

  process.stdout.write('\n');
  report([
    ['source', source],
    ['artifact', `${basename(artifact)}  ${statSync(artifact).size} bytes`],
    ['artifact sha256', artifactDigest],
    ['executable', `${basename(exe)}  ${statSync(exe).size} bytes`],
    ['sha256', exeDigest],
    ['signature', `${signature.status}${signature.note ? ` (${signature.note})` : ''}`],
    ['signer', signature.signer],
    ['publisher', PUBLISHER_PAGE],
    ['recorded', previouslyRecorded ?? 'nothing recorded yet — this would be the first'],
  ]);

  process.stdout.write(
    '\n  SumatraPDF publishes no checksum file, so there is no list to compare the digest\n' +
      `  above against. Open ${PUBLISHER_PAGE}\n` +
      '  and check that this is the release and the build you meant to install; the\n' +
      "  Authenticode signature above is Windows' own answer about who produced it.\n",
  );

  // ── the gates ──────────────────────────────────────────────────────────────────────────

  const refuse = (message) => {
    rmSync(STAGING, { recursive: true, force: true });
    throw new Error(message);
  };

  if (previouslyRecorded && previouslyRecorded !== exeDigest) {
    // This is the case the manifest exists for: a digest was measured once, and this file is
    // not it. It is a refusal rather than a prompt, because the only honest reasons to
    // proceed involve editing vendor/checksums.json on purpose.
    refuse(
      `REFUSED: this is not the binary recorded in vendor/checksums.json.\n` +
        `  recorded  ${previouslyRecorded}\n  staged    ${exeDigest}\n` +
        '  Either you are installing a different release — in which case remove that entry\n' +
        '  deliberately — or something has changed underneath you.',
    );
  }

  if (expect && expect.toLowerCase() !== exeDigest) {
    refuse(
      `REFUSED: --expect does not match what was downloaded.\n` +
        `  expected  ${expect.toLowerCase()}\n  actual    ${exeDigest}\n` +
        '  Nothing was installed.',
    );
  }

  if (signature.status !== 'Valid' && !args.flags.has('allow-unsigned')) {
    refuse(
      `REFUSED: Authenticode says "${signature.status}", not "Valid".\n` +
        '  A print helper runs with your privileges every time somebody prints. If you have\n' +
        '  checked this file another way, re-run with --allow-unsigned.',
    );
  }

  if (!confirm) {
    process.stdout.write(
      '\n  Nothing was installed. To install exactly these bytes:\n\n' +
        `    node scripts/install-print-helper.mjs ${
          args.values['from'] ? `--from=${args.values['from']} ` : ''
        }--confirm=${exeDigest}\n\n`,
    );
    return { installed: false, digest: exeDigest, signature };
  }

  if (confirm.toLowerCase() !== exeDigest) {
    refuse(
      `REFUSED: --confirm does not match the staged file.\n` +
        `  confirmed ${confirm.toLowerCase()}\n  staged    ${exeDigest}\n` +
        '  Nothing was installed.',
    );
  }

  mkdirSync(join(ROOT, 'vendor', 'bin'), { recursive: true });
  rmSync(TARGET_ABS, { force: true });
  // Copy-then-remove rather than rename: staging and vendor/bin can sit on different volumes
  // once someone points TMP elsewhere, and a cross-device rename fails with EXDEV.
  copyFileSync(exe, TARGET_ABS);
  rmSync(STAGING, { recursive: true, force: true });

  const recorded = recordDigest(TARGET, TARGET_ABS);
  process.stdout.write(`\n  installed      ${TARGET}\n  recorded       ${recorded}\n\n`);

  // The install is only finished when the ordinary verifier agrees, so a run always ends
  // with the same check CI will make.
  const { failed } = verifyVendor({});
  if (failed) throw new Error('the installed file does not verify — see above');

  return { installed: true, digest: recorded, signature };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Staging without installing is a successful run of what was asked for, not a failure.
    // Only a refusal exits non-zero, so `&&` chains and CI mean what they look like.
    await installPrintHelper(process.argv.slice(2));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exit(1);
  }
}
