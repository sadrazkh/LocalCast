// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadSpec } from '../../../shared/preflight.js';
import type { PreflightContext } from '../context.js';
import { installFromSpec } from '../downloads.js';

/**
 * The two rules the digest policy turns on: a file that fails its digest is deleted rather
 * than installed, and a file whose digest nobody recorded is not installed at all until a
 * human has looked at it.
 */

const PAYLOAD = Buffer.from('pretend this is SumatraPDF.exe');
const REAL_DIGEST = createHash('sha256').update(PAYLOAD).digest('hex');

/** A `fetch` that hands back one chunk, shaped like the real one enough for the streaming path. */
function respondWith(bytes: Buffer): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? String(bytes.length) : null,
    },
    body: (async function* () {
      yield new Uint8Array(bytes);
    })(),
  })) as unknown as typeof fetch;
}

function specWith(sha256?: string): DownloadSpec {
  const spec: DownloadSpec = {
    id: 'print-helper',
    url: 'https://example.invalid/helper.exe',
    sourceUrl: 'https://example.invalid/checksums',
    version: '1.0.0',
    destination: 'Helper.exe',
    licence: 'GPLv3',
  };
  return sha256 ? { ...spec, sha256 } : spec;
}

describe('installFromSpec', () => {
  let vendorDir: string;
  let ctx: PreflightContext;

  beforeEach(async () => {
    vendorDir = await mkdtemp(join(tmpdir(), 'localcast-preflight-'));
    ctx = { appRoot: vendorDir, resourcesPath: vendorDir, repoRoot: vendorDir, vendorDir, nativeBinding: '' };
  });

  afterEach(async () => {
    await rm(vendorDir, { recursive: true, force: true });
  });

  it('deletes the file and reports digest-mismatch when the recorded digest does not match', async () => {
    const outcome = await installFromSpec(specWith('0'.repeat(64)), ctx, {
      fetchImpl: respondWith(PAYLOAD),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected the install to be refused');
    expect(outcome.reason).toBe('digest-mismatch');
    expect(outcome.computedSha256).toBe(REAL_DIGEST);

    // Neither the partial file nor the destination may survive a failed digest.
    await expect(stat(join(vendorDir, 'Helper.exe.part'))).rejects.toThrow();
    await expect(stat(join(vendorDir, 'Helper.exe'))).rejects.toThrow();
  });

  it('installs when the recorded digest matches', async () => {
    const outcome = await installFromSpec(specWith(REAL_DIGEST), ctx, {
      fetchImpl: respondWith(PAYLOAD),
    });

    expect(outcome).toMatchObject({ ok: true, installedTo: join(vendorDir, 'Helper.exe') });
    await expect(stat(join(vendorDir, 'Helper.exe'))).resolves.toBeTruthy();
  });

  it('reports digest-unrecorded and installs nothing when no digest was recorded', async () => {
    const outcome = await installFromSpec(specWith(), ctx, { fetchImpl: respondWith(PAYLOAD) });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected the install to wait for confirmation');
    expect(outcome.reason).toBe('digest-unrecorded');
    expect(outcome.computedSha256).toBe(REAL_DIGEST);

    // Nothing installed, but the verified bytes are kept so confirming does not re-download.
    await expect(stat(join(vendorDir, 'Helper.exe'))).rejects.toThrow();
    await expect(stat(join(vendorDir, 'Helper.exe.part'))).resolves.toBeTruthy();
  });
});
