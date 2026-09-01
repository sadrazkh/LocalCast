import { readFile, readdir, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '@localcast/contract';
import { createUploadsModule } from '../../src/modules/uploads/index.js';
import { UploadService } from '../../src/modules/uploads/sessions.js';
import { sanitizeRelativePath } from '../../src/modules/uploads/paths.js';
import type { Harness, TestServer } from './support/context.js';
import { createHarness } from './support/context.js';

const CONTENT = Buffer.from(
  Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256),
);

let harness: Harness;
let server: TestServer;
let deviceId: string;
let folderId: string;
let folderRoot: string;
let readOnlyId: string;

beforeEach(async () => {
  harness = await createHarness();
  deviceId = harness.addDevice({ name: 'iPhone' }).id;

  const writable = harness.addFolder({ label: 'Phone drop', kind: 'photos', writable: true });
  folderId = writable.id;
  folderRoot = writable.root;
  readOnlyId = harness.addFolder({ label: 'Archive', writable: false }).id;

  harness.grant(deviceId, folderId, 'full');
  harness.grant(deviceId, readOnlyId, 'full');

  // The resolver only knows folders that exist on disk.
  await harness.putFile(folderId, '.keep', '');

  server = await harness.serve([
    createUploadsModule({ chunkSize: 1024, progressIntervalMs: 500 }),
  ]);
});

afterEach(async () => {
  await harness.cleanup();
});

interface Session {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  chunkSize: number;
  status: 'active' | 'complete' | 'aborted';
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.url}/api/v1${path}`, {
    ...init,
    headers: { 'x-test-device': deviceId, ...(init.headers ?? {}) },
  });
}

async function createSession(
  relativePath: string,
  totalBytes: number,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return api('/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folderId, relativePath, totalBytes, ...overrides }),
  });
}

async function startUpload(relativePath: string, total = CONTENT.length): Promise<Session> {
  const res = await createSession(relativePath, total);
  expect(res.status).toBe(201);
  return ((await res.json()) as { upload: Session }).upload;
}

function patch(id: string, offset: number, body: Buffer): Promise<Response> {
  return api(`/uploads/${id}`, {
    method: 'PATCH',
    headers: { 'upload-offset': String(offset), 'content-type': 'application/octet-stream' },
    body: new Uint8Array(body),
  });
}

async function tempParts(): Promise<string[]> {
  return (await readdir(harness.ctx.paths.tempDir)).filter((name) => name.startsWith('upload-'));
}

describe('creating a session', () => {
  it('returns the server-chosen chunk size and starts at zero', async () => {
    const session = await startUpload('holiday/IMG_0001.JPG');
    expect(session).toMatchObject({ receivedBytes: 0, totalBytes: CONTENT.length, chunkSize: 1024, status: 'active' });
    expect(await tempParts()).toHaveLength(1);
  });

  it('refuses a folder that is not writable', async () => {
    const res = await api('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: readOnlyId, relativePath: 'a.jpg', totalBytes: 10 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upload_not_allowed');
  });

  it('refuses a folder the device cannot see', async () => {
    const closed = harness.addFolder({ label: 'Private', writable: true });
    harness.grant(deviceId, closed.id, 'none');
    const res = await api('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: closed.id, relativePath: 'a.jpg', totalBytes: 10 }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a body the contract does not accept', async () => {
    const res = await api('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId, relativePath: '', totalBytes: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it('finishes a zero-byte file immediately, since there is nothing to PATCH', async () => {
    const session = await startUpload('empty.txt', 0);
    expect(session.status).toBe('complete');
    expect((await stat(join(folderRoot, 'empty.txt'))).size).toBe(0);
  });
});

describe('path safety', () => {
  it.each([
    '../outside.jpg',
    'a/../../outside.jpg',
    '..\\outside.jpg',
    '/etc/passwd',
    'C:/Windows/System32/evil.dll',
    'photo.jpg:hidden.exe',
    './../x.jpg',
  ])('rejects `%s` before a path is ever built', async (relativePath) => {
    const res = await createSession(relativePath, 10);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('path_escapes_root');
    // Nothing was created for it.
    expect(await tempParts()).toHaveLength(0);
  });

  it('rejects names Windows cannot represent', () => {
    expect(() => sanitizeRelativePath('CON.jpg')).toThrow(ApiException);
    expect(() => sanitizeRelativePath('what?.jpg')).toThrow(ApiException);
    expect(() => sanitizeRelativePath('trailing .jpg ')).toThrow(ApiException);
    expect(() => sanitizeRelativePath('')).toThrow(ApiException);
  });

  it('keeps an ordinary nested Persian path intact', () => {
    expect(sanitizeRelativePath('عکس‌ها/۱۴۰۳/تصویر.jpg')).toBe('عکس‌ها/۱۴۰۳/تصویر.jpg');
    expect(sanitizeRelativePath('a\\b\\c.jpg')).toBe('a/b/c.jpg');
    expect(sanitizeRelativePath('holiday//IMG.jpg')).toBe('holiday/IMG.jpg');
  });

  it('rejects a leading separator, including the UNC form', () => {
    // `//server/share` is a path to another machine, not a name inside the folder.
    expect(() => sanitizeRelativePath('//server/share/x.jpg')).toThrow(ApiException);
    expect(() => sanitizeRelativePath('/absolute.jpg')).toThrow(ApiException);
  });
});

describe('appending chunks', () => {
  it('assembles a file from several chunks and renames it into place', async () => {
    const session = await startUpload('holiday/IMG_0001.JPG');

    let offset = 0;
    while (offset < CONTENT.length) {
      const end = Math.min(offset + 1000, CONTENT.length);
      const res = await patch(session.id, offset, CONTENT.subarray(offset, end));
      expect(res.status).toBe(200);
      offset = end;
    }

    const written = await readFile(join(folderRoot, 'holiday', 'IMG_0001.JPG'));
    expect(written.equals(CONTENT)).toBe(true);
    // The temp file is gone, not copied.
    expect(await tempParts()).toHaveLength(0);
  });

  it('answers a mismatched offset with the offset the client should resume from', async () => {
    const session = await startUpload('a.jpg');
    await patch(session.id, 0, CONTENT.subarray(0, 1000));

    const res = await patch(session.id, 500, CONTENT.subarray(500, 1500));
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; detail: { receivedBytes: number; totalBytes: number } };
    };
    expect(body.error.code).toBe('upload_offset_mismatch');
    // This number is the whole point: it is what lets the client resume rather than restart.
    expect(body.error.detail.receivedBytes).toBe(1000);
    expect(body.error.detail.totalBytes).toBe(CONTENT.length);

    // And resuming from it works.
    expect((await patch(session.id, 1000, CONTENT.subarray(1000))).status).toBe(200);
    expect((await readFile(join(folderRoot, 'a.jpg'))).equals(CONTENT)).toBe(true);
  });

  it('resumes after a chunk that was cut off mid-flight', async () => {
    const session = await startUpload('interrupted.jpg');

    // A real interruption: the request declares 2000 bytes, sends 800, and the socket dies.
    await sendPartialChunk(session.id, 0, CONTENT.subarray(0, 2000), 800);

    const progress = ((await (await api(`/uploads/${session.id}`)).json()) as { upload: Session })
      .upload;
    expect(progress.receivedBytes).toBe(800);
    expect(progress.status).toBe('active');

    // The client asks where it stands and carries on from there.
    const res = await patch(session.id, progress.receivedBytes, CONTENT.subarray(800));
    expect(res.status).toBe(200);
    expect((await readFile(join(folderRoot, 'interrupted.jpg'))).equals(CONTENT)).toBe(true);
    // Generous: this test waits on a real socket abort being committed, and a cold CI runner
    // is much slower at that than a warm developer machine.
  }, 20_000);

  it('refuses a chunk that would exceed the declared size', async () => {
    const session = await startUpload('big.jpg', 100);
    const res = await patch(session.id, 0, Buffer.alloc(200));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upload_too_large');
  });

  it('requires an offset', async () => {
    const session = await startUpload('a.jpg');
    const res = await api(`/uploads/${session.id}`, { method: 'PATCH', body: 'x' });
    expect(res.status).toBe(400);
  });

  it('hides another device`s session behind a 404', async () => {
    const session = await startUpload('a.jpg');
    const other = harness.addDevice({ name: 'Laptop' });
    const res = await fetch(`${server.url}/api/v1/uploads/${session.id}`, {
      headers: { 'x-test-device': other.id },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'upload_session_unknown',
    );
  });
});

describe('collisions', () => {
  it('suffixes rather than overwriting an existing file', async () => {
    await harness.putFile(folderId, 'IMG_0001.JPG', 'the original');

    const first = await startUpload('IMG_0001.JPG');
    await patch(first.id, 0, CONTENT);

    // The original is untouched…
    expect((await readFile(join(folderRoot, 'IMG_0001.JPG'))).toString()).toBe('the original');
    // …and the new one landed beside it.
    expect((await readFile(join(folderRoot, 'IMG_0001 (2).JPG'))).equals(CONTENT)).toBe(true);

    // A third one keeps counting.
    const second = await startUpload('IMG_0001.JPG');
    await patch(second.id, 0, CONTENT);
    expect((await readFile(join(folderRoot, 'IMG_0001 (3).JPG'))).equals(CONTENT)).toBe(true);
  });

  it('records the name it actually used, so the client is not told the wrong one', async () => {
    await harness.putFile(folderId, 'clash.pdf', 'x');
    const session = await startUpload('clash.pdf');
    await patch(session.id, 0, CONTENT);

    const row = harness.ctx.db.prepare(`SELECT rel_path FROM uploads WHERE id = ?`).get(session.id);
    expect(row).toEqual({ rel_path: 'clash (2).pdf' });
  });
});

describe('progress events', () => {
  it('ends every upload with a terminal event carrying the final byte count', async () => {
    const session = await startUpload('stream.bin', CONTENT.length);
    harness.events.length = 0;

    let offset = 0;
    while (offset < CONTENT.length) {
      const end = Math.min(offset + 1000, CONTENT.length);
      await patch(session.id, offset, CONTENT.subarray(offset, end));
      offset = end;
    }

    const uploads = harness.events.filter((event) => event.type === 'upload');
    expect(uploads[uploads.length - 1]).toMatchObject({
      status: 'complete',
      receivedBytes: CONTENT.length,
      totalBytes: CONTENT.length,
    });
  });

  it('throttles progress to one event per 500 ms inside a single long chunk', async () => {
    // Driven against the service rather than over HTTP, because the thing under test is what
    // happens between the pieces of one request body — which no HTTP client lets you time.
    let clock = 1_000_000;
    const service = new UploadService(harness.ctx, {
      chunkSize: 1024,
      progressIntervalMs: 500,
      now: () => clock,
    });

    const session = await service.create({
      deviceId,
      folderId,
      relativePath: 'long.bin',
      totalBytes: 100 * 64,
    });
    harness.events.length = 0;

    // 100 pieces spread over 900 ms of wall clock: two windows, so two progress events.
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < 100; i += 1) {
          clock += 9;
          yield Buffer.alloc(64, i % 256);
        }
      })(),
    );

    await service.append(session.id, deviceId, 0, body);

    const uploads = harness.events.filter((event) => event.type === 'upload');
    const progress = uploads.filter((event) => (event as { status: string }).status === 'active');
    expect(progress.length).toBeLessThanOrEqual(2);
    expect(uploads[uploads.length - 1]).toMatchObject({ status: 'complete', receivedBytes: 6400 });
  });
});

describe('aborting and sweeping', () => {
  it('deletes the temp file on DELETE', async () => {
    const session = await startUpload('gone.jpg');
    await patch(session.id, 0, CONTENT.subarray(0, 1000));
    expect(await tempParts()).toHaveLength(1);

    const res = await api(`/uploads/${session.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { upload: Session }).upload.status).toBe('aborted');
    expect(await tempParts()).toHaveLength(0);
    // Nothing was left in the destination folder.
    expect(await readdir(folderRoot)).not.toContain('gone.jpg');
  });

  it('refuses further chunks once aborted', async () => {
    const session = await startUpload('gone.jpg');
    await api(`/uploads/${session.id}`, { method: 'DELETE' });
    expect((await patch(session.id, 0, CONTENT)).status).toBe(404);
  });

  it('sweeps sessions abandoned more than a day ago on boot', async () => {
    const stale = await startUpload('forgotten.mp4', 1_000_000);
    await patch(stale.id, 0, CONTENT.subarray(0, 100));
    const fresh = await startUpload('current.mp4', 1_000_000);

    harness.ctx.db
      .prepare(`UPDATE uploads SET updated_at = ? WHERE id = ?`)
      .run(Date.now() - 25 * 60 * 60 * 1000, stale.id);

    // Booting the module again is what runs the sweep.
    await harness.serve([createUploadsModule()]);
    await new Promise((done) => setTimeout(done, 50));

    const rows = harness.ctx.db
      .prepare(`SELECT id, status FROM uploads ORDER BY created_at`)
      .all() as { id: string; status: string }[];
    expect(rows).toEqual([
      { id: stale.id, status: 'aborted' },
      { id: fresh.id, status: 'active' },
    ]);
    // Only the abandoned one's bytes were reclaimed.
    expect(await tempParts()).toHaveLength(1);
  });
});

/**
 * Sends `declared` under a Content-Length that promises more, then kills the socket — which
 * is what a phone leaving Wi-Fi mid-chunk looks like on the wire.
 */
/**
 * Stages a real interruption: declare a large chunk, send part of it, kill the socket.
 *
 * Two things here are easy to get wrong and were both wrong before.
 *
 * The **order**: the server commits a partial chunk when the request aborts, not while it is
 * still open, so the destroy has to come before any wait for the bytes to appear.
 *
 * The **error handler**: destroying a request makes it emit `error`. Resolving the promise
 * there ends this helper the instant the socket dies, before the server has committed
 * anything — which is exactly the 0-instead-of-800 this test kept reporting. The abort is the
 * thing being staged, not a failure, so it is swallowed and the polling below decides when
 * the work is actually done.
 *
 * The wait itself is a poll rather than a sleep. Two 60 ms sleeps passed on a warm developer
 * machine and failed on a cold CI runner; a poll asks the machine instead of guessing how
 * slow it is.
 */
async function sendPartialChunk(
  id: string,
  offset: number,
  declared: Buffer,
  sendBytes: number,
): Promise<void> {
  const url = new URL(server.url);

  await new Promise<void>((resolve, reject) => {
    const req = request({
      method: 'PATCH',
      path: `/api/v1/uploads/${id}`,
      host: url.hostname,
      port: url.port,
      headers: {
        'x-test-device': deviceId,
        'upload-offset': String(offset),
        'content-type': 'application/octet-stream',
        'content-length': String(declared.length),
      },
    });
    // The abort we are about to cause. Not a failure.
    req.on('error', () => {});
    req.write(new Uint8Array(declared.subarray(0, sendBytes)), (err) => {
      if (err) {
        reject(err);
        return;
      }
      // Destroy, not a half-close. Only an RST puts the server's `for await` into the error
      // path whose `finally` commits the partial bytes; ending the socket cleanly against an
      // unmet Content-Length leaves nothing recorded at all — verified by watching this poll
      // time out for the full eight seconds.
      //
      // The one timing assumption left: `write`'s callback means the bytes reached the
      // kernel, not the server, so destroying in the same tick can discard them. 250 ms is
      // several orders of magnitude more than a loopback hand-off needs. What used to be
      // timed — how long the server takes to commit, which is what varies between a warm
      // laptop and a cold CI runner — is polled below instead.
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 250);
    });
  });

  await waitForReceived(id, sendBytes);
}

/** Polls the session until the server reports at least `bytes` received. */
async function waitForReceived(id: string, bytes: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(`/uploads/${id}`);
    if (res.ok) {
      const { upload } = (await res.json()) as { upload: Session };
      if (upload.receivedBytes >= bytes) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`server never recorded ${bytes} bytes for upload ${id}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
