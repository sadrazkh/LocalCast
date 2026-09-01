import { Readable } from 'node:stream';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateStream, RangeTarget } from '../../src/modules/webdav/range.js';
import {
  ifRangeMatches,
  parseRangeHeader,
  serveRange,
  weakEtag,
} from '../../src/modules/webdav/range.js';

const SIZE = 100;
const CONTENT = Buffer.from(
  Array.from({ length: SIZE }, (_, i) => i % 251),
);
const MTIME = 1_700_000_000_123;

describe('parseRangeHeader', () => {
  it('ignores a missing or non-bytes unit', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('items=0-10', SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=', SIZE)).toEqual({ kind: 'none' });
  });

  it('reads the three legal forms', () => {
    expect(parseRangeHeader('bytes=0-9', SIZE)).toEqual({ kind: 'range', start: 0, end: 9 });
    expect(parseRangeHeader('bytes=50-', SIZE)).toEqual({ kind: 'range', start: 50, end: 99 });
    expect(parseRangeHeader('bytes=-10', SIZE)).toEqual({ kind: 'range', start: 90, end: 99 });
  });

  it('clamps an end past the last byte rather than failing', () => {
    expect(parseRangeHeader('bytes=90-999', SIZE)).toEqual({ kind: 'range', start: 90, end: 99 });
    // A suffix longer than the file is the whole file, not an error.
    expect(parseRangeHeader('bytes=-999', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('answers the boundaries the spec calls out', () => {
    expect(parseRangeHeader('bytes=0-0', SIZE)).toEqual({ kind: 'range', start: 0, end: 0 });
    expect(parseRangeHeader(`bytes=${SIZE - 1}-`, SIZE)).toEqual({
      kind: 'range',
      start: SIZE - 1,
      end: SIZE - 1,
    });
    expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader(`bytes=${SIZE + 1}-`, SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('treats an empty file and a zero-length suffix as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('answers a multi-range request with the whole file', () => {
    // Safari never sends this for video, and multipart/byteranges is cost without benefit.
    expect(parseRangeHeader('bytes=0-9,20-29', SIZE)).toEqual({ kind: 'full' });
  });

  it('ignores a syntactically invalid range instead of rejecting it', () => {
    expect(parseRangeHeader('bytes=9-2', SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=abc-def', SIZE)).toEqual({ kind: 'none' });
  });
});

describe('weakEtag / ifRangeMatches', () => {
  it('is derived from size and mtime, never from the bytes', () => {
    expect(weakEtag(SIZE, MTIME)).toBe(`W/"${SIZE}-${MTIME}"`);
  });

  it('matches the same validator and refuses a stale one', () => {
    const etag = weakEtag(SIZE, MTIME);
    expect(ifRangeMatches(undefined, etag, MTIME)).toBe(true);
    expect(ifRangeMatches(etag, etag, MTIME)).toBe(true);
    expect(ifRangeMatches('W/"99-1"', etag, MTIME)).toBe(false);
    expect(ifRangeMatches(new Date(MTIME).toUTCString(), etag, MTIME)).toBe(true);
    expect(ifRangeMatches(new Date(MTIME - 60_000).toUTCString(), etag, MTIME)).toBe(false);
  });
});

// ── over a real socket ───────────────────────────────────────────────────────

interface Fixture {
  url: string;
  close(): Promise<void>;
  /** Streams handed out by the last request, so a test can assert they were destroyed. */
  streams: Readable[];
}

async function serve(
  target: Partial<RangeTarget> = {},
  createStream?: CreateStream,
): Promise<Fixture> {
  const streams: Readable[] = [];
  const factory: CreateStream =
    createStream ??
    ((_path, opts) => {
      const stream = Readable.from([CONTENT.subarray(opts.start, opts.end + 1)]);
      streams.push(stream);
      return stream;
    });

  const app = express();
  app.use((req, res) => {
    void serveRange(
      req,
      res,
      {
        absPath: 'C:/fake/movie.mp4',
        size: SIZE,
        mtimeMs: MTIME,
        contentType: 'video/mp4',
        disposition: 'inline',
        fileName: 'movie.mp4',
        ...target,
      },
      { createStream: factory },
    );
  });

  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    streams,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

let fixture: Fixture;

afterEach(async () => {
  await fixture?.close();
});

describe('serveRange over HTTP', () => {
  beforeEach(async () => {
    fixture = await serve();
  });

  it('serves the whole file with Accept-Ranges when no range is asked for', async () => {
    const res = await fetch(fixture.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(SIZE));
    expect(res.headers.get('etag')).toBe(`W/"${SIZE}-${MTIME}"`);
    expect(res.headers.get('last-modified')).toBe(new Date(MTIME).toUTCString());
    expect(Buffer.from(await res.arrayBuffer()).equals(CONTENT)).toBe(true);
  });

  it('serves 206 with a byte-exact Content-Range', async () => {
    const res = await fetch(fixture.url, { headers: { range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${SIZE}`);
    expect(res.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await res.arrayBuffer()).equals(CONTENT.subarray(10, 20))).toBe(true);
  });

  it('serves the last byte of the file', async () => {
    const res = await fetch(fixture.url, { headers: { range: `bytes=${SIZE - 1}-` } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 99-99/${SIZE}`);
    expect((await res.arrayBuffer()).byteLength).toBe(1);
  });

  it('answers 416 past the end with the size, so the client can correct itself', async () => {
    const res = await fetch(fixture.url, { headers: { range: `bytes=${SIZE}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`);
    expect(await res.json()).toEqual({
      error: { code: 'range_not_satisfiable', message: expect.any(String) },
    });
  });

  it('answers a multi-range request with 200 and the whole body', async () => {
    const res = await fetch(fixture.url, { headers: { range: 'bytes=0-9,50-59' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE);
  });

  it('falls back to the whole file when If-Range no longer matches', async () => {
    const res = await fetch(fixture.url, {
      headers: { range: 'bytes=10-19', 'if-range': 'W/"1-1"' },
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE);
  });

  it('honours If-Range when the validator still matches', async () => {
    const res = await fetch(fixture.url, {
      headers: { range: 'bytes=10-19', 'if-range': `W/"${SIZE}-${MTIME}"` },
    });
    expect(res.status).toBe(206);
  });

  it('answers HEAD with the headers and no body, and opens no stream at all', async () => {
    const res = await fetch(fixture.url, { method: 'HEAD', headers: { range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('');
    expect(fixture.streams).toHaveLength(0);
  });

  it('marks media as untransformable so nothing gzips a video', async () => {
    const res = await fetch(fixture.url);
    expect(res.headers.get('cache-control')).toContain('no-transform');
  });

  it('encodes a Persian file name into Content-Disposition', async () => {
    await fixture.close();
    fixture = await serve({ fileName: 'فیلم.mp4', disposition: 'attachment' });
    const res = await fetch(fixture.url);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('فیلم.mp4')}`);
    await res.arrayBuffer();
  });
});

describe('stream lifecycle', () => {
  it('destroys the read stream when the client walks away mid-response', async () => {
    // The defect this file exists to prevent. Scrubbing a 4K file abandons dozens of
    // requests a second; a stream that is not destroyed holds its descriptor until the
    // process runs out and stops serving anything.
    const destroyed: boolean[] = [];
    let opened: Readable | null = null;

    fixture = await serve({ size: 10 * 1024 * 1024 }, () => {
      // Never ends on its own: the only way this stream closes is if someone destroys it.
      const stream = new Readable({ read() {} });
      stream.push(Buffer.alloc(1024));
      opened = stream;
      stream.on('close', () => destroyed.push(stream.destroyed));
      return stream;
    });

    const controller = new AbortController();
    const pending = fetch(fixture.url, { signal: controller.signal }).then(
      (res) => res.arrayBuffer(),
      () => undefined,
    );
    // Let the response start before abandoning it.
    await new Promise((done) => setTimeout(done, 60));
    controller.abort();
    await pending.catch(() => undefined);

    await vi.waitFor(() => {
      expect(destroyed).toEqual([true]);
    });
    expect(opened).not.toBeNull();
  });

  it('resolves rather than hanging when the read stream fails', async () => {
    fixture = await serve({}, () => {
      const stream = new Readable({ read() {} });
      setTimeout(() => stream.destroy(new Error('disk went away')), 10);
      return stream;
    });

    await expect(fetch(fixture.url).then((res) => res.arrayBuffer())).rejects.toThrow();
  });
});
