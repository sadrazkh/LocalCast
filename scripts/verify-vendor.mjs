/**
 * Records and verifies the digests of the vendored binaries.
 *
 * `--record` computes the SHA-256 of the files that are actually present and writes them to
 * `vendor/checksums.json`. It never writes a digest it did not compute: a checksum that was
 * typed rather than measured passes every test and proves nothing.
 *
 *   node scripts/verify-vendor.mjs            # verify, non-zero exit on mismatch
 *   node scripts/verify-vendor.mjs --record   # record what is on disk right now
 *
 * The pieces are exported as well as run, because `install-print-helper.mjs` and
 * `doctor.mjs` need the same manifest and the same digest — a second implementation of
 * either is a second thing to drift.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = join(ROOT, 'vendor', 'checksums.json');

/** Files LocalCast expects, and whether the build can proceed without them. */
export const EXPECTED = [{ path: 'vendor/bin/SumatraPDF.exe', required: false, purpose: 'printing' }];

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function readManifest() {
  return existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
}

export function writeManifest(manifest) {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The digest previously recorded for a vendored path, or null if none ever was. */
export function recordedDigest(relPath) {
  return readManifest()[relPath]?.sha256 ?? null;
}

/**
 * Writes a digest computed from a file that exists. There is deliberately no way to write one
 * from a string: the whole value of this manifest is that every entry was measured.
 */
export function recordDigest(relPath, absFile) {
  const manifest = readManifest();
  const digest = sha256(absFile);
  manifest[relPath] = { sha256: digest, recordedBytes: statSync(absFile).size };
  writeManifest(manifest);
  return digest;
}

export function verifyVendor({ record = false, log = console.log, logError = console.error } = {}) {
  const manifest = readManifest();
  let failed = false;

  for (const entry of EXPECTED) {
    const abs = join(ROOT, entry.path);

    if (!existsSync(abs)) {
      const level = entry.required ? 'MISSING' : 'absent';
      log(`${level}  ${entry.path}  (${entry.purpose} will be unavailable)`);
      if (entry.required) failed = true;
      continue;
    }

    const actual = sha256(abs);

    if (record) {
      manifest[entry.path] = { sha256: actual, recordedBytes: statSync(abs).size };
      log(`recorded  ${entry.path}  ${actual}`);
      continue;
    }

    const expected = manifest[entry.path]?.sha256;
    if (!expected) {
      log(`unrecorded  ${entry.path}  ${actual}  — run with --record once you have checked it`);
      continue;
    }
    if (expected !== actual) {
      logError(`MISMATCH  ${entry.path}\n  expected ${expected}\n  actual   ${actual}`);
      failed = true;
      continue;
    }
    log(`ok  ${entry.path}  ${actual}`);
  }

  if (record) {
    writeManifest(manifest);
    log(`\nwrote ${MANIFEST}`);
    log('Check these against the digests the upstream project publishes before trusting them.');
  }

  return { failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failed } = verifyVendor({ record: process.argv.includes('--record') });
  process.exit(failed ? 1 : 0);
}
