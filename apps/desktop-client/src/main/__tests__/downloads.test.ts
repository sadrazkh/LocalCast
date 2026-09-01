/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { ErrorCode } from '@localcast/contract';
import { CancelledError } from '@localcast/client-core';
import { DownloadManager, partPathFor } from '../downloads.js';
import type { DownloadJob } from '../../shared/ipc.js';
import { FakeClock, MemoryLogger, ScriptedRangeTransport, streamOf, until } from './fakes.js';

/**
 * The transfer queue, driven through a scripted transport and a real filesystem.
 *
 * A real `fs` rather than a mocked one on purpose: every assertion worth making here is about
 * what is actually on disk when the dust settles — whether a truncated file was renamed into
 * place, whether a `.lcpart` was left behind, whether a resume appended to the right bytes.
 * A fake filesystem would let all four of those pass while the shipped app got them wrong.
 *
 * The token is `access-secret` throughout, so any test can ask the one question that has no
 * good answer: did it end up somewhere it should not have?
 */

const SERVER = 'srv-1';
const FILE = 'file-1';
const CONTENT = 'the quick brown fox jumps over the lazy dog!!';
const TOKEN = 'access-secret';

interface Harness {
  dir: string;
  downloadDir: string;
  statePath: string;
  clock: FakeClock;
  logger: MemoryLogger;
}

let h: Harness;

function makeManager(transport: ScriptedRangeTransport, concurrency = 2): DownloadManager {
  return new DownloadManager({
    transport,
    targets: {
      authorize: async () => ({ authorization: `Bearer ${TOKEN}` }),
      contentUrl: (serverId, fileId) =>
        `https://alpha.tail1234.ts.net/api/v1/files/${fileId}/content?download=1&s=${serverId}`,
    },
    downloadDir: h.downloadDir,
    statePath: h.statePath,
    clock: h.clock,
    logger: h.logger,
    concurrency,
  });
}

function enqueue(manager: DownloadManager, fileName = 'film.mkv', totalBytes?: number) {
  return manager.enqueue({
    serverId: SERVER,
    fileId: FILE,
    fileName,
    kind: 'video',
    totalBytes: totalBytes ?? null,
  });
}

/** Wait until the job reaches a status that will not change on its own. */
async function settled(manager: DownloadManager, jobId: string): Promise<DownloadJob> {
  await until(() => {
    const status = manager.get(jobId)?.status;
    return status === 'done' || status === 'error' || status === 'cancelled';
  }, `download ${jobId} settling`);
  return manager.get(jobId)!;
}

const SEEDED_ID = 'dl-seeded-1';

/**
 * The state a resume actually starts from: a queue file holding a paused row, and a partial
 * file on disk holding the bytes of the run that was interrupted.
 *
 * Written out rather than produced by pausing a live transfer, because those are not the same
 * thing — a job paused in flight is still inside its own `#run`, and asking it to resume while
 * that is unwinding tests the scheduler rather than the Range handling this file is about.
 */
async function resumable(
  transport: ScriptedRangeTransport,
  alreadyOnDisk: string,
): Promise<{ manager: DownloadManager; destination: string }> {
  const destination = join(h.downloadDir, 'film.mkv');
  const seeded: DownloadJob = {
    id: SEEDED_ID,
    serverId: SERVER,
    fileId: FILE,
    fileName: 'film.mkv',
    kind: 'video',
    destination,
    // Deliberately stale: the record is a display value, the bytes on disk are the truth.
    receivedBytes: 0,
    totalBytes: null,
    status: 'paused',
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    finishedAt: null,
  };
  mkdirSync(dirname(h.statePath), { recursive: true });
  writeFileSync(h.statePath, JSON.stringify({ version: 1, jobs: [seeded] }), 'utf8');
  writeFileSync(partPathFor(destination), alreadyOnDisk, 'utf8');

  const manager = makeManager(transport);
  await manager.load();
  expect(manager.get(SEEDED_ID)?.receivedBytes).toBe(alreadyOnDisk.length);
  return { manager, destination };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-dl-'));
  h = {
    dir,
    downloadDir: join(dir, 'downloads'),
    statePath: join(dir, 'state', 'downloads.json'),
    clock: new FakeClock(),
    logger: new MemoryLogger(),
  };
  mkdirSync(h.downloadDir, { recursive: true });
});

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

describe('DownloadManager — a plain transfer', () => {
  it('streams to a .lcpart file, renames it into place and leaves no partial behind', async () => {
    const transport = new ScriptedRangeTransport({
      status: 200,
      headers: { 'content-length': String(CONTENT.length) },
      body: CONTENT,
    });
    const manager = makeManager(transport);
    const job = enqueue(manager);

    const done = await settled(manager, job.id);
    expect(done.status).toBe('done');
    expect(done.receivedBytes).toBe(CONTENT.length);
    expect(done.totalBytes).toBe(CONTENT.length);
    expect(readFileSync(done.destination, 'utf8')).toBe(CONTENT);
    expect(existsSync(partPathFor(done.destination))).toBe(false);
    // A first request asks for the whole thing; a Range header here would be a lie.
    expect(transport.ranges()).toEqual([null]);
  });

  it('never writes the bearer into the queue file it persists', async () => {
    const transport = new ScriptedRangeTransport({
      status: 200,
      headers: { 'content-length': String(CONTENT.length) },
      body: CONTENT,
    });
    const manager = makeManager(transport);
    const job = enqueue(manager);
    await settled(manager, job.id);
    await manager.stopAll();

    const persisted = readFileSync(h.statePath, 'utf8');
    expect(persisted).toContain(job.id);
    // The state file is not secret-bearing, and the URL it would have to hold to leak one is
    // not stored either. Nothing about a credential belongs in a file support asks users for.
    expect(persisted).not.toContain(TOKEN);
    expect(persisted.toLowerCase()).not.toContain('authorization');
    expect(h.logger.text()).not.toContain(TOKEN);
  });

  it('refuses to rename a truncated file into place when the stream ends early', async () => {
    const transport = new ScriptedRangeTransport({
      status: 200,
      // The header promises far more than the body delivers: a connection that dropped.
      headers: { 'content-length': '9000' },
      body: CONTENT,
    });
    const manager = makeManager(transport);
    const job = enqueue(manager);

    const failed = await settled(manager, job.id);
    expect(failed.status).toBe('error');
    expect(failed.errorCode).toBe(ErrorCode.INTERNAL);
    // The half-copied film must not be sitting in the downloads folder looking finished.
    expect(existsSync(failed.destination)).toBe(false);
    // …but the bytes that did arrive are kept, because that is what a resume is for.
    expect(readFileSync(partPathFor(failed.destination), 'utf8')).toBe(CONTENT);
    expect(failed.receivedBytes).toBe(CONTENT.length);
  });

  it('turns a proxy error page into a typed error rather than a SyntaxError', async () => {
    const transport = new ScriptedRangeTransport({
      status: 403,
      headers: { 'content-type': 'text/html' },
      body: '<html><body><h1>403 Forbidden</h1></body></html>',
    });
    const manager = makeManager(transport);
    const job = enqueue(manager);

    const failed = await settled(manager, job.id);
    expect(failed.status).toBe('error');
    // A contract code, taken from the status because the body carried none. The row branches
    // on that; the prose beside it is never parsed. What must not happen is the `SyntaxError`
    // a bare `JSON.parse` of an HTML page produces, which carries no code at all.
    expect(failed.errorCode).toBe(ErrorCode.FORBIDDEN);
    expect(failed.errorMessage).not.toContain('Unexpected token');
  });

});

describe('DownloadManager — resuming', () => {
  const HEAD = CONTENT.slice(0, 20);
  const TAIL = CONTENT.slice(20);

  it('asks for bytes=<size>- from what is on disk and appends the answer', async () => {
    const transport = new ScriptedRangeTransport({
      status: 206,
      headers: {
        'content-range': `bytes 20-${CONTENT.length - 1}/${CONTENT.length}`,
        'content-length': String(TAIL.length),
      },
      body: TAIL,
    });
    const { manager, destination } = await resumable(transport, HEAD);

    manager.resume(SEEDED_ID);
    const done = await settled(manager, SEEDED_ID);

    // The offset comes from the file, not from the record — which said zero.
    expect(transport.ranges()).toEqual(['bytes=20-']);
    expect(done.status).toBe('done');
    expect(readFileSync(destination, 'utf8')).toBe(CONTENT);
    expect(existsSync(partPathFor(destination))).toBe(false);
  });

  it('reports the size of the file, not the size of the slice, from a 206', async () => {
    const transport = new ScriptedRangeTransport({
      status: 206,
      headers: {
        // `Content-Length` on a 206 describes the slice. A row that took it for the total
        // would show a film as finished less than half way through.
        'content-length': String(TAIL.length),
        'content-range': `bytes 20-${CONTENT.length - 1}/${CONTENT.length}`,
      },
      body: TAIL,
    });
    const { manager } = await resumable(transport, HEAD);
    manager.resume(SEEDED_ID);

    const done = await settled(manager, SEEDED_ID);
    expect(done.totalBytes).toBe(CONTENT.length);
    expect(done.receivedBytes).toBe(CONTENT.length);
  });

  it('falls back to Content-Length plus the offset when a 206 sends no Content-Range', async () => {
    const transport = new ScriptedRangeTransport({
      status: 206,
      headers: { 'content-length': String(TAIL.length) },
      body: TAIL,
    });
    const { manager, destination } = await resumable(transport, HEAD);
    manager.resume(SEEDED_ID);

    const done = await settled(manager, SEEDED_ID);
    expect(done.totalBytes).toBe(CONTENT.length);
    expect(readFileSync(destination, 'utf8')).toBe(CONTENT);
  });

  it('throws away the partial copy when a Range request is answered with the whole file', async () => {
    const transport = new ScriptedRangeTransport({
      status: 200,
      headers: { 'content-length': String(CONTENT.length) },
      body: CONTENT,
    });
    const { manager, destination } = await resumable(transport, HEAD);
    manager.resume(SEEDED_ID);

    const done = await settled(manager, SEEDED_ID);
    // Not the head followed by the whole file: the partial was not a prefix of what arrived.
    expect(readFileSync(destination, 'utf8')).toBe(CONTENT);
    expect(done.receivedBytes).toBe(CONTENT.length);
  });

  it('refuses a 206 that starts somewhere other than the byte it asked for', async () => {
    const transport = new ScriptedRangeTransport({
      status: 206,
      headers: {
        // Asked for `bytes=20-`, told "here is from byte 30". Appending this blindly makes a
        // file of exactly the right length with ten bytes missing from its middle.
        'content-range': `bytes 30-${CONTENT.length - 1}/${CONTENT.length}`,
        'content-length': String(CONTENT.length - 30),
      },
      body: CONTENT.slice(30),
    });
    const { manager, destination } = await resumable(transport, HEAD);
    manager.resume(SEEDED_ID);

    const failed = await settled(manager, SEEDED_ID);
    expect(failed.status).toBe('error');
    expect(failed.errorCode).toBe(ErrorCode.RANGE_NOT_SATISFIABLE);
    expect(existsSync(destination)).toBe(false);
    // The misaligned partial is gone: keeping it would resume from the same wrong place.
    expect(existsSync(partPathFor(destination))).toBe(false);
  });

  it('starts over when a 206 answers a ranged request from byte zero', async () => {
    const transport = new ScriptedRangeTransport({
      status: 206,
      headers: {
        'content-range': `bytes 0-${CONTENT.length - 1}/${CONTENT.length}`,
        'content-length': String(CONTENT.length),
      },
      body: CONTENT,
    });
    const { manager, destination } = await resumable(transport, HEAD);
    manager.resume(SEEDED_ID);

    const done = await settled(manager, SEEDED_ID);
    expect(done.status).toBe('done');
    expect(readFileSync(destination, 'utf8')).toBe(CONTENT);
  });
});

describe('DownloadManager — an unsatisfiable range', () => {
  it('treats a 416 whose total matches the bytes on disk as a finished transfer', async () => {
    const transport = new ScriptedRangeTransport({
      status: 416,
      headers: { 'content-range': `bytes */${CONTENT.length}` },
      body: null,
    });
    // Every byte arrived last time; only the rename was lost.
    const { manager, destination } = await resumable(transport, CONTENT);
    manager.resume(SEEDED_ID);

    const done = await settled(manager, SEEDED_ID);
    expect(done.status).toBe('done');
    expect(done.totalBytes).toBe(CONTENT.length);
    expect(readFileSync(destination, 'utf8')).toBe(CONTENT);
    expect(existsSync(partPathFor(destination))).toBe(false);
  });

  it('discards a partial the server no longer agrees with, and says why in a code', async () => {
    const transport = new ScriptedRangeTransport({
      status: 416,
      // The file on the server is smaller than the copy here: it was replaced.
      headers: { 'content-range': 'bytes */12' },
      body: null,
    });
    const { manager, destination } = await resumable(transport, CONTENT);
    manager.resume(SEEDED_ID);

    const failed = await settled(manager, SEEDED_ID);
    expect(failed.status).toBe('error');
    expect(failed.errorCode).toBe(ErrorCode.RANGE_NOT_SATISFIABLE);
    expect(existsSync(partPathFor(destination))).toBe(false);
    expect(existsSync(destination)).toBe(false);
    expect(failed.receivedBytes).toBe(0);
  });
});

describe('DownloadManager — pause, resume and cancel', () => {
  it('keeps the bytes already written when the user pauses mid-transfer', async () => {
    const first = 'first-half-';
    const transport = new ScriptedRangeTransport({
      status: 200,
      headers: { 'content-length': '9000' },
      stream: (signal) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(first));
            signal?.addEventListener('abort', () => {
              controller.error(new CancelledError('GET /files/:id/content'));
            });
          },
        }),
    });
    const manager = makeManager(transport);
    const job = enqueue(manager);

    await until(() => (manager.get(job.id)?.receivedBytes ?? 0) >= first.length, 'first chunk');
    manager.pause(job.id);
    await until(() => manager.get(job.id)?.status === 'paused', 'the pause landing');

    const paused = manager.get(job.id)!;
    expect(paused.status).toBe('paused');
    expect(paused.errorCode).toBeNull();
    expect(paused.receivedBytes).toBe(first.length);
    expect(readFileSync(partPathFor(paused.destination), 'utf8')).toBe(first);
  });

  it('removes the partial file and zeroes the row when the user cancels mid-transfer', async () => {
    const transport = new ScriptedRangeTransport({
      status: 200,
      headers: { 'content-length': '9000' },
      stream: (signal) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('half-a-file'));
            signal?.addEventListener('abort', () => {
              controller.error(new CancelledError('GET /files/:id/content'));
            });
          },
        }),
    });
    const manager = makeManager(transport);
    const job = enqueue(manager);

    await until(() => (manager.get(job.id)?.receivedBytes ?? 0) > 0, 'first chunk');
    manager.cancel(job.id);

    const cancelled = await settled(manager, job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.receivedBytes).toBe(0);
    expect(existsSync(partPathFor(cancelled.destination))).toBe(false);
    expect(existsSync(cancelled.destination)).toBe(false);
  });

  it('refuses to run a finished job again over the file it already produced', async () => {
    const transport = new ScriptedRangeTransport({
      status: 200,
      headers: { 'content-length': String(CONTENT.length) },
      body: CONTENT,
    });
    const manager = makeManager(transport);
    const job = enqueue(manager);
    const done = await settled(manager, job.id);
    expect(done.status).toBe('done');

    // The renderer can ask for this — `downloads:resume` takes any id it likes. A second run
    // would fetch the whole file again and rename over the copy the user already has.
    const again = manager.resume(job.id);
    expect(again.status).toBe('done');
    expect(again.receivedBytes).toBe(CONTENT.length);
    expect(transport.opened).toHaveLength(1);
  });
});

describe('DownloadManager — where files land', () => {
  it('gives two transfers of the same name two destinations', async () => {
    const transport = new ScriptedRangeTransport(
      { status: 200, headers: { 'content-length': String(CONTENT.length) }, body: CONTENT },
      { status: 200, headers: { 'content-length': String(CONTENT.length) }, body: CONTENT },
    );
    const manager = makeManager(transport, 1);
    const first = enqueue(manager, 'film.mkv');
    const second = enqueue(manager, 'film.mkv');

    // Neither has written a byte yet, so `existsSync` alone cannot tell them apart. Sharing a
    // `.lcpart` would interleave two downloads into one file and rename it twice.
    expect(second.destination).not.toBe(first.destination);

    await settled(manager, first.id);
    await settled(manager, second.id);
    expect(readFileSync(first.destination, 'utf8')).toBe(CONTENT);
    expect(readFileSync(second.destination, 'utf8')).toBe(CONTENT);
  });

  it('keeps a name from a remote index inside the downloads folder', () => {
    const manager = makeManager(new ScriptedRangeTransport());
    const traversal = manager.enqueue({
      serverId: SERVER,
      fileId: 'a',
      fileName: '../../../Windows/System32/evil.dll',
      kind: 'other',
      totalBytes: null,
    });
    const dots = manager.enqueue({
      serverId: SERVER,
      fileId: 'b',
      fileName: '..',
      kind: 'other',
      totalBytes: null,
    });

    for (const job of [traversal, dots]) {
      expect(job.destination.startsWith(h.downloadDir + sep)).toBe(true);
      expect(job.destination).not.toContain('..');
    }
  });
});

describe('DownloadManager — the queue file', () => {
  it('brings a mid-flight job back as paused with the byte count the disk actually holds', async () => {
    const transport = new ScriptedRangeTransport();
    const first = makeManager(transport);
    const job = enqueue(first, 'film.mkv', 9000);
    first.pause(job.id);
    await first.stopAll();
    // More bytes than the last recorded tick admits: writes the OS flushed after the record.
    writeFileSync(partPathFor(job.destination), CONTENT, 'utf8');

    const second = makeManager(transport);
    await second.load();
    const restored = second.get(job.id)!;

    expect(restored.status).toBe('paused');
    expect(restored.receivedBytes).toBe(CONTENT.length);
  });

  it('does not report a finished download as having received nothing', async () => {
    const transport = new ScriptedRangeTransport({
      status: 200,
      headers: { 'content-length': String(CONTENT.length) },
      body: CONTENT,
    });
    const first = makeManager(transport);
    const job = enqueue(first, 'film.mkv');
    await settled(first, job.id);
    await first.stopAll();

    const second = makeManager(new ScriptedRangeTransport());
    await second.load();
    const restored = second.get(job.id)!;

    expect(restored.status).toBe('done');
    // There is no `.lcpart` left for a finished job. Re-`stat`ing one is how a completed
    // 1.4 GB film comes back from a restart reading «۰ بایت» beside a full progress bar.
    expect(restored.receivedBytes).toBe(CONTENT.length);
    expect(restored.totalBytes).toBe(CONTENT.length);
  });

  it('starts with an empty list rather than failing when the queue file is corrupt', async () => {
    mkdirSync(join(h.dir, 'state'), { recursive: true });
    writeFileSync(h.statePath, '{"jobs": [ this is not json', 'utf8');

    const manager = makeManager(new ScriptedRangeTransport());
    await expect(manager.load()).resolves.toBeUndefined();
    expect(manager.list()).toEqual([]);
    expect(h.logger.lines.some((line) => line.level === 'warn')).toBe(true);
  });
});
