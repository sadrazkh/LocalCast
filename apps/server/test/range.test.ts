import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addFolder,
  bearer,
  cleanupTempDirs,
  createSparseFixture,
  expectedBlock,
  pairDevice,
  setMode,
  startServer,
  tempDir,
  type PairedDevice,
  type SparseFixture,
  type TestServer,
} from './helpers.js';
import { parseRangeHeader, weakETag } from '../src/http/range.js';

const FIVE_GIB = 5 * 1024 * 1024 * 1024;
const BLOCK = 64 * 1024;

let ts: TestServer;
let device: PairedDevice;
let folderId: string;
let fileId: string;
let mtimeMs: number;

// Built at collection time, not in `beforeAll`: the `describe.skip` decision below is made
// while the file is being collected, long before any hook has run.
const media = tempDir('lc-range-');
const fixture: SparseFixture | null = createSparseFixture(media, FIVE_GIB, BLOCK);

beforeAll(async () => {
  if (!fixture) return;

  ts = await startServer();
  folderId = await addFolder(ts, { path: media, label: 'Huge' });
  device = await pairDevice(ts, [{ folderId, mode: 'full' }]);

  const entries = await ts.json<{ entries: Array<{ id: string; name: string; size: number }> }>(
    `/api/v1/folders/${folderId}/entries`,
    { headers: bearer(device.accessToken) },
  );
  const entry = entries.entries.find((e) => e.name === 'huge.bin');
  expect(entry, 'the 5 GiB fixture must be indexed').toBeDefined();
  expect(entry?.size).toBe(FIVE_GIB);
  fileId = entry?.id as string;
  mtimeMs = fs.statSync(fixture.file).mtimeMs;
}, 300_000);

afterAll(async () => {
  await ts?.dispose();
  cleanupTempDirs();
});

function url(): string {
  return `/api/v1/files/${fileId}/content`;
}

async function getRange(range: string): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const res = await ts.fetch(url(), {
    headers: { ...bearer(device.accessToken), range },
  });
  return {
    status: res.status,
    headers: res.headers,
    body: Buffer.from(await res.arrayBuffer()),
  };
}

const describeIfSparse = () => (fixture ? describe : describe.skip);

// The fixture is what makes this test worth anything; without it the suite would silently
// prove nothing, so it skips loudly rather than quietly downgrading to a small file.
describe.skipIf(process.platform !== 'win32')('Range streaming over a >4 GiB sparse file', () => {
  it('has a sparse fixture, or explains why the rest is skipped', () => {
    if (!fixture) {
      console.warn(
        'SKIPPED: could not create an NTFS sparse file (fsutil unavailable or non-NTFS volume); ' +
          'the >4 GiB range assertions did not run.',
      );
    }
    expect(true).toBe(true);
  });

  describeIfSparse()('byte-exact reads', () => {
    it('returns the exact pattern at every seeded offset, including across 4 GiB', async () => {
      for (const offset of (fixture as SparseFixture).offsets) {
        const expected = expectedBlock(offset, BLOCK);
        const res = await getRange(`bytes=${offset}-${offset + BLOCK - 1}`);
        expect(res.status, `offset ${offset}`).toBe(206);
        expect(res.headers.get('content-range')).toBe(
          `bytes ${offset}-${offset + BLOCK - 1}/${FIVE_GIB}`,
        );
        expect(res.body.length, `offset ${offset} length`).toBe(BLOCK);
        expect(
          res.body.equals(expected),
          `bytes differ at offset ${offset}`,
        ).toBe(true);
      }
    }, 300_000);

    it('reads correctly around the edges of each seeded block', async () => {
      const seeded = new Set((fixture as SparseFixture).offsets);
      for (const offset of (fixture as SparseFixture).offsets) {
        const expected = expectedBlock(offset, BLOCK);

        // First byte of the block.
        const first = await getRange(`bytes=${offset}-${offset}`);
        expect(first.status).toBe(206);
        expect(first.body[0], `first byte at ${offset}`).toBe(expected[0]);

        // Last byte of the block.
        const lastOffset = offset + BLOCK - 1;
        const last = await getRange(`bytes=${lastOffset}-${lastOffset}`);
        expect(last.status).toBe(206);
        expect(last.body[0], `last byte at ${lastOffset}`).toBe(expected[BLOCK - 1]);

        // A window straddling the block boundary. What follows is either the next seeded
        // block or an unallocated hole, and both have to come back byte-exact.
        if (offset + BLOCK + 16 <= FIVE_GIB) {
          const next = offset + BLOCK;
          const after = seeded.has(next)
            ? expectedBlock(next, BLOCK).subarray(0, 16)
            : Buffer.alloc(16);
          const straddle = await getRange(`bytes=${lastOffset - 15}-${lastOffset + 16}`);
          expect(straddle.status).toBe(206);
          expect(straddle.body.length).toBe(32);
          expect(
            straddle.body.subarray(0, 16).equals(expected.subarray(BLOCK - 16)),
            `bytes before the boundary at ${lastOffset}`,
          ).toBe(true);
          expect(
            straddle.body.subarray(16).equals(after),
            `bytes after the boundary at ${lastOffset}`,
          ).toBe(true);
        }
      }
    }, 300_000);

    it('reads a sparse hole as zeroes past the 4 GiB mark', async () => {
      const holeStart = 4 * 1024 * 1024 * 1024 + 8 * 1024 * 1024;
      const res = await getRange(`bytes=${holeStart}-${holeStart + 4095}`);
      expect(res.status).toBe(206);
      expect(res.body.length).toBe(4096);
      expect(res.body.equals(Buffer.alloc(4096))).toBe(true);
    });
  });

  describeIfSparse()('boundary cases', () => {
    it('bytes=0-0 returns the first byte', async () => {
      const res = await getRange('bytes=0-0');
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 0-0/${FIVE_GIB}`);
      expect(res.body.length).toBe(1);
      expect(res.body[0]).toBe(expectedBlock(0, BLOCK)[0]);
    });

    it('bytes=size-1 returns the final byte', async () => {
      const start = FIVE_GIB - 1;
      const res = await getRange(`bytes=${start}-`);
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${start}/${FIVE_GIB}`);
      expect(res.body.length).toBe(1);
      const lastBlock = expectedBlock(FIVE_GIB - BLOCK, BLOCK);
      expect(res.body[0]).toBe(lastBlock[BLOCK - 1]);
    });

    it('bytes=size is unsatisfiable', async () => {
      const res = await getRange(`bytes=${FIVE_GIB}-`);
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${FIVE_GIB}`);
    });

    it('bytes=size+1 is unsatisfiable', async () => {
      const res = await getRange(`bytes=${FIVE_GIB + 1}-`);
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${FIVE_GIB}`);
    });

    it('bytes=-1 returns the final byte', async () => {
      const res = await getRange('bytes=-1');
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(
        `bytes ${FIVE_GIB - 1}-${FIVE_GIB - 1}/${FIVE_GIB}`,
      );
      expect(res.body.length).toBe(1);
    });

    it('bytes=-n larger than the file clamps to the whole file', async () => {
      // Asserted on headers only; the body is five gigabytes.
      const res = await ts.fetch(url(), {
        method: 'HEAD',
        headers: { ...bearer(device.accessToken), range: `bytes=-${FIVE_GIB + 1024}` },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 0-${FIVE_GIB - 1}/${FIVE_GIB}`);
      expect(res.headers.get('content-length')).toBe(String(FIVE_GIB));
    });

    it('bytes=0- is a 206 covering the whole file', async () => {
      const res = await ts.fetch(url(), {
        method: 'HEAD',
        headers: { ...bearer(device.accessToken), range: 'bytes=0-' },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 0-${FIVE_GIB - 1}/${FIVE_GIB}`);
    });

    it('a reversed range is unsatisfiable', async () => {
      const res = await getRange('bytes=5000-100');
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${FIVE_GIB}`);
    });

    it('a garbage range unit is ignored rather than answered with 416', async () => {
      const res = await ts.fetch(url(), {
        method: 'HEAD',
        headers: { ...bearer(device.accessToken), range: 'kilobytes=0-10' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(FIVE_GIB));
    });

    it('an end beyond EOF is clamped, not refused', async () => {
      const start = FIVE_GIB - 4;
      const res = await getRange(`bytes=${start}-${FIVE_GIB + 10_000}`);
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${FIVE_GIB - 1}/${FIVE_GIB}`);
      expect(res.body.length).toBe(4);
    });
  });

  describeIfSparse()('protocol headers', () => {
    it('advertises range support and a weak metadata ETag on every response', async () => {
      const res = await ts.fetch(url(), {
        method: 'HEAD',
        headers: bearer(device.accessToken),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('etag')).toBe(weakETag(FIVE_GIB, mtimeMs));
      expect(res.headers.get('etag')).toMatch(/^W\//);
      expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('answers a multi-range request with 200 and the whole body, never multipart', async () => {
      const res = await ts.fetch(url(), {
        method: 'HEAD',
        headers: { ...bearer(device.accessToken), range: 'bytes=0-99,200-299' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(FIVE_GIB));
      expect(res.headers.get('content-type')).not.toMatch(/multipart/);
    });

    it('honours If-Range when the validator matches', async () => {
      const etag = weakETag(FIVE_GIB, mtimeMs);
      const res = await ts.fetch(url(), {
        method: 'HEAD',
        headers: { ...bearer(device.accessToken), range: 'bytes=0-99', 'if-range': etag },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 0-99/${FIVE_GIB}`);
    });

    it('drops the range when If-Range does not match', async () => {
      const res = await ts.fetch(url(), {
        method: 'HEAD',
        headers: {
          ...bearer(device.accessToken),
          range: 'bytes=0-99',
          'if-range': 'W/"1-1"',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(FIVE_GIB));
    });

    it('supports HEAD with a range and sends no body', async () => {
      const res = await ts.fetch(url(), {
        method: 'HEAD',
        headers: { ...bearer(device.accessToken), range: 'bytes=100-199' },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-length')).toBe('100');
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    });
  });

  describeIfSparse()('stream mode refuses a copy but not a seek', () => {
    it('refuses a body-bearing request with no range, and an explicit download', async () => {
      await setMode(ts, device.deviceId, folderId, 'stream');
      try {
        const full = await ts.fetch(url(), { headers: bearer(device.accessToken) });
        expect(full.status).toBe(403);
        expect(((await full.json()) as { error: { code: string } }).error.code).toBe(
          'download_not_allowed',
        );

        const attachment = await ts.fetch(`${url()}?download=1`, {
          headers: { ...bearer(device.accessToken), range: 'bytes=0-9' },
        });
        expect(attachment.status).toBe(403);

        const multi = await ts.fetch(url(), {
          headers: { ...bearer(device.accessToken), range: 'bytes=0-9,20-29' },
        });
        expect(multi.status, 'a multi-range request is a full-body request').toBe(403);

        const seek = await getRange('bytes=0-9');
        expect(seek.status).toBe(206);

        const head = await ts.fetch(url(), {
          method: 'HEAD',
          headers: bearer(device.accessToken),
        });
        expect(head.status, 'HEAD carries no bytes and every player issues one').toBe(200);
      } finally {
        await setMode(ts, device.deviceId, folderId, 'full');
      }
    });
  });
});

describe('range header parsing', () => {
  const size = 5 * 1024 * 1024 * 1024;

  it.each([
    ['bytes=0-99', { kind: 'single', range: { start: 0, end: 99 } }],
    ['bytes=100-', { kind: 'single', range: { start: 100, end: size - 1 } }],
    ['bytes=-100', { kind: 'single', range: { start: size - 100, end: size - 1 } }],
    [`bytes=${size - 1}-`, { kind: 'single', range: { start: size - 1, end: size - 1 } }],
    [`bytes=${size}-`, { kind: 'unsatisfiable' }],
    ['bytes=-0', { kind: 'unsatisfiable' }],
    ['bytes=500-100', { kind: 'unsatisfiable' }],
    ['bytes=0-9,20-29', { kind: 'multiple' }],
    ['bytes=abc', { kind: 'ignore' }],
    ['bytes=-', { kind: 'ignore' }],
    ['items=0-10', { kind: 'ignore' }],
  ])('parses %s', (header, expected) => {
    expect(parseRangeHeader(header, size)).toEqual(expected);
  });

  it('treats any range over a zero-length file as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('has no header case at all when Range is absent', () => {
    expect(parseRangeHeader(undefined, size)).toEqual({ kind: 'none' });
  });

  it('keeps full precision past 2^32', () => {
    const parsed = parseRangeHeader('bytes=4294967296-4294967395', size);
    expect(parsed).toEqual({ kind: 'single', range: { start: 4294967296, end: 4294967395 } });
  });
});

describe('weak ETag', () => {
  it('is metadata-only, so it never reads the file', () => {
    expect(weakETag(1234, 5678.9)).toBe('W/"1234-5678"');
  });

  it('changes when either the size or the mtime changes', () => {
    expect(weakETag(1, 1)).not.toBe(weakETag(2, 1));
    expect(weakETag(1, 1)).not.toBe(weakETag(1, 2));
  });
});
