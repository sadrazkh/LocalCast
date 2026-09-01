/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '@localcast/contract';
import type { UploadSession } from '@localcast/contract';
import { LocalCastError } from '@localcast/client-core';
import type { ApiClient } from '@localcast/client-core';
import { UploadManager } from '../uploads.js';
import type { UploadJob } from '../../shared/ipc.js';
import { FakeClock, MemoryLogger, until } from './fakes.js';

/**
 * Pushing a file into somebody else's writable folder.
 *
 * The protocol belongs to `client-core` — create a session, PATCH each chunk at an explicit
 * offset — so what is worth pinning here is the part this class owns: reading the file in
 * chunk-sized bites, resuming from the server's count rather than its own, and knowing when
 * to stop. That last one is the interesting case: the loop condition is written in terms of
 * a number the *server* supplies, so a server that stops moving is a server that can spin
 * this loop for ever.
 */

const SERVER = 'srv-1';
const FOLDER = 'fld-1';

let dir: string;
let clock: FakeClock;
let logger: MemoryLogger;

interface Recorded {
  offset: number;
  length: number;
}

interface FakeApiOptions {
  chunkSize?: number;
  /** Decides what the server reports after each chunk. Defaults to honest accounting. */
  onPatch?: (offset: number, length: number, total: number) => UploadSession | Error;
}

class FakeApi {
  readonly created: { relativePath: string; totalBytes: number }[] = [];
  readonly patched: Recorded[] = [];
  readonly #chunkSize: number;
  readonly #onPatch: FakeApiOptions['onPatch'];
  #total = 0;

  constructor(options: FakeApiOptions = {}) {
    this.#chunkSize = options.chunkSize ?? 8;
    this.#onPatch = options.onPatch;
  }

  async createUpload(request: { relativePath: string; totalBytes: number }): Promise<UploadSession> {
    this.created.push({ relativePath: request.relativePath, totalBytes: request.totalBytes });
    this.#total = request.totalBytes;
    return {
      id: 'up-1',
      receivedBytes: 0,
      totalBytes: request.totalBytes,
      chunkSize: this.#chunkSize,
      status: request.totalBytes === 0 ? 'complete' : 'active',
    };
  }

  async patchUpload(_id: string, offset: number, chunk: Uint8Array): Promise<UploadSession> {
    this.patched.push({ offset, length: chunk.byteLength });
    const answer = this.#onPatch?.(offset, chunk.byteLength, this.#total);
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    const received = offset + chunk.byteLength;
    return {
      id: 'up-1',
      receivedBytes: received,
      totalBytes: this.#total,
      chunkSize: this.#chunkSize,
      status: received >= this.#total ? 'complete' : 'active',
    };
  }

  asApiClient(): ApiClient {
    return this as unknown as ApiClient;
  }
}

function makeManager(api: FakeApi): UploadManager {
  return new UploadManager({
    targets: { api: () => api.asApiClient() },
    clock,
    logger,
  });
}

function sourceFile(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

async function settled(manager: UploadManager, jobId: string): Promise<UploadJob> {
  await until(() => {
    const status = manager.list().find((job) => job.id === jobId)?.status;
    return status === 'done' || status === 'error' || status === 'cancelled';
  }, `upload ${jobId} settling`);
  return manager.list().find((job) => job.id === jobId)!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lc-up-'));
  clock = new FakeClock();
  logger = new MemoryLogger();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('UploadManager', () => {
  it('sends the file in the chunks the server asked for, each at its own offset', async () => {
    const api = new FakeApi({ chunkSize: 8 });
    const manager = makeManager(api);
    const path = sourceFile('notes.txt', 'abcdefghijklmnopqrstu'); // 21 bytes

    const [job] = await manager.start({
      serverId: SERVER,
      folderId: FOLDER,
      sourcePaths: [path],
    });
    const done = await settled(manager, job!.id);

    expect(done.status).toBe('done');
    expect(done.sentBytes).toBe(21);
    // The offsets are explicit and contiguous, which is what lets the server reject a
    // replayed chunk instead of appending 4 MB of it twice.
    expect(api.patched).toEqual([
      { offset: 0, length: 8 },
      { offset: 8, length: 8 },
      { offset: 16, length: 5 },
    ]);
  });

  it('resumes from the server’s count when a chunk landed but its answer did not', async () => {
    // The first PATCH reports more received than was sent: the retry the client never saw.
    const api = new FakeApi({
      chunkSize: 8,
      onPatch: (offset, length, total) =>
        offset === 0
          ? { id: 'up-1', receivedBytes: 16, totalBytes: total, chunkSize: 8, status: 'active' }
          : {
              id: 'up-1',
              receivedBytes: offset + length,
              totalBytes: total,
              chunkSize: 8,
              status: offset + length >= total ? 'complete' : 'active',
            },
    });
    const manager = makeManager(api);
    const path = sourceFile('notes.txt', 'abcdefghijklmnopqrstu');

    const [job] = await manager.start({ serverId: SERVER, folderId: FOLDER, sourcePaths: [path] });
    const done = await settled(manager, job!.id);

    expect(done.status).toBe('done');
    // Byte 8 is never sent again: the server is the only party that knows what landed.
    expect(api.patched.map((patch) => patch.offset)).toEqual([0, 16]);
  });

  it('stops instead of looping when the server accepts a chunk without counting it', async () => {
    const api = new FakeApi({
      chunkSize: 8,
      // A 200 that leaves the offset exactly where it was. The loop condition reads that
      // number, so without a guard the same eight bytes go out for ever at link speed.
      onPatch: (_offset, _length, total) => ({
        id: 'up-1',
        receivedBytes: 0,
        totalBytes: total,
        chunkSize: 8,
        status: 'active',
      }),
    });
    const manager = makeManager(api);
    const path = sourceFile('notes.txt', 'abcdefghijklmnopqrstu');

    const [job] = await manager.start({ serverId: SERVER, folderId: FOLDER, sourcePaths: [path] });
    const failed = await settled(manager, job!.id);

    expect(failed.status).toBe('error');
    expect(failed.errorCode).toBe(ErrorCode.UPLOAD_OFFSET_MISMATCH);
    expect(api.patched).toHaveLength(1);
  });

  it('surfaces an offset mismatch from the server as its own code', async () => {
    const api = new FakeApi({
      chunkSize: 8,
      onPatch: () =>
        new LocalCastError(ErrorCode.UPLOAD_OFFSET_MISMATCH, 'expected offset 8', { status: 409 }),
    });
    const manager = makeManager(api);
    const path = sourceFile('notes.txt', 'abcdefghijklmnopqrstu');

    const [job] = await manager.start({ serverId: SERVER, folderId: FOLDER, sourcePaths: [path] });
    const failed = await settled(manager, job!.id);

    expect(failed.errorCode).toBe(ErrorCode.UPLOAD_OFFSET_MISMATCH);
    expect(logger.lines.some((line) => line.fields?.code === ErrorCode.UPLOAD_OFFSET_MISMATCH)).toBe(
      true,
    );
  });

  it('fails a file it cannot read without opening a session on the server', async () => {
    const api = new FakeApi();
    const manager = makeManager(api);

    const [job] = await manager.start({
      serverId: SERVER,
      folderId: FOLDER,
      sourcePaths: [join(dir, 'gone-before-we-looked.mkv')],
    });

    expect(job?.status).toBe('error');
    expect(job?.errorCode).toBe(ErrorCode.NOT_FOUND);
    // A row the user can see, and no stranded upload session on somebody else's machine
    // reported back as «the server did not accept the whole file».
    expect(api.created).toEqual([]);
    expect(manager.list()).toHaveLength(1);
  });

  it('still uploads a genuinely empty file', async () => {
    const api = new FakeApi();
    const manager = makeManager(api);
    const path = sourceFile('empty.txt', '');

    const [job] = await manager.start({ serverId: SERVER, folderId: FOLDER, sourcePaths: [path] });
    const done = await settled(manager, job!.id);

    // Zero bytes is a size, not a failure to read.
    expect(done.status).toBe('done');
    expect(api.created).toEqual([{ relativePath: 'empty.txt', totalBytes: 0 }]);
  });

  it('names the file by its base name, with no Windows path reaching the server', async () => {
    const api = new FakeApi();
    const manager = makeManager(api);
    const path = sourceFile('film.mkv', 'abc');

    await manager.start({ serverId: SERVER, folderId: FOLDER, sourcePaths: [path] });

    expect(api.created[0]?.relativePath).toBe('film.mkv');
    expect(api.created[0]?.relativePath).not.toContain('\\');
    expect(api.created[0]?.relativePath).not.toContain(':');
  });

  it('reports a cancellation as cancelled, not as an error', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = new FakeApi({ chunkSize: 4 });
    const patchUpload = api.patchUpload.bind(api);
    let calls = 0;
    api.patchUpload = async (id, offset, chunk) => {
      calls += 1;
      // Hold the transfer open from the second chunk on, so the cancel lands mid-file.
      if (calls >= 2) await gate;
      return patchUpload(id, offset, chunk);
    };

    const manager = makeManager(api);
    const path = sourceFile('notes.txt', 'abcdefghijklmnopqrstu');
    const [job] = await manager.start({ serverId: SERVER, folderId: FOLDER, sourcePaths: [path] });

    await until(() => calls >= 2, 'the second chunk');
    manager.cancel(job!.id);
    release();

    const cancelled = await settled(manager, job!.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.errorCode).toBeNull();
  });
});
