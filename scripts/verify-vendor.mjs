/**
 * Records and verifies the digests of the vendored binaries.
 *
 * `--record` computes the SHA-256 of the files that are actually present and writes them to
 * `vendor/checksums.json`. It never writes a digest it did not compute: a checksum that was
 * typed rather than measured passes every test and proves nothing.
 *
 *   node scripts/verify-vendor.mjs            # verify, non-zero exit on mismatch
 *   node scripts/verify-vendor.mjs --record   # record what is on disk right now
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'vendor', 'checksums.json');

/** Files LocalCast expects, and whether the build can proceed without them. */
const EXPECTED = [{ path: 'vendor/bin/SumatraPDF.exe', required: false, purpose: 'printing' }];

const record = process.argv.includes('--record');

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
let failed = false;

for (const entry of EXPECTED) {
  const abs = join(ROOT, entry.path);

  if (!existsSync(abs)) {
    const level = entry.required ? 'MISSING' : 'absent';
    console.log(`${level}  ${entry.path}  (${entry.purpose} will be unavailable)`);
    if (entry.required) failed = true;
    continue;
  }

  const actual = sha256(abs);

  if (record) {
    manifest[entry.path] = { sha256: actual, recordedBytes: readFileSync(abs).length };
    console.log(`recorded  ${entry.path}  ${actual}`);
    continue;
  }

  const expected = manifest[entry.path]?.sha256;
  if (!expected) {
    console.log(`unrecorded  ${entry.path}  ${actual}  — run with --record once you have checked it`);
    continue;
  }
  if (expected !== actual) {
    console.error(`MISMATCH  ${entry.path}\n  expected ${expected}\n  actual   ${actual}`);
    failed = true;
    continue;
  }
  console.log(`ok  ${entry.path}  ${actual}`);
}

if (record) {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwrote ${MANIFEST}`);
  console.log('Check these against the digests the upstream project publishes before trusting them.');
}

process.exit(failed ? 1 : 0);
