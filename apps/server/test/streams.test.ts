import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Indexer } from '../src/library/indexer.js';
import { silentLogger } from '../src/logger.js';
import { StreamMonitor } from '../src/streams.js';
import { addFolder, bearer, cleanupTempDirs, pairDevice, startServer, tempDir, type TestServer } from './helpers.js';

/**
 * "Heavy files stutter, light ones are fine."
 *
 * Three causes, three tests. Each range request the player sent used to cost a synchronous
 * SQLite write on the thread that moves every byte; an index pass was one transaction over the
 * whole folder on that same thread; and nothing measured what a stream was waiting on, so the
 * panel could not say whether the Wi-Fi or the drive was the slow side.
 */

const started: TestServer[] = [];

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

/** A sink whose "still full" state the test controls. */
function sink(): { writableNeedDrain: boolean; once: (event: string, fn: () => void) => void; close(): void } {
  const handlers: (() => void)[] = [];
  return {
    writableNeedDrain: false,
    once(event, fn) {
      if (event === 'close') handlers.push(fn);
    },
    close() {
      for (const fn of handlers) fn();
    },
  };
}

describe('the stream monitor', () => {
  it('calls the network the bottleneck when the socket is usually still full', () => {
    let now = 0;
    const monitor = new StreamMonitor(() => now);
    const source = new PassThrough();
    const out = sink();
    monitor.track(out, source, { deviceId: 'dev-1', name: 'film.mkv' });

    // The disk hands over chunks faster than the wire drains them: on almost every chunk the
    // previous one has not left yet.
    out.writableNeedDrain = true;
    for (let i = 0; i < 20; i += 1) {
      now += 100;
      source.write(Buffer.alloc(1024 * 1024));
    }
    source.resume();

    const [info] = monitor.list();
    expect(info?.bottleneck).toBe('network');
    expect(info?.networkWaitRatio).toBeGreaterThan(0.9);
    // 20 MiB over ~2 s of samples inside the 4 s window.
    expect(info?.mbps).toBeGreaterThan(50);
    expect(monitor.count()).toBe(1);

    out.close();
    expect(monitor.count()).toBe(0);
  });

  it('calls the source the bottleneck when the socket is usually empty', () => {
    let now = 0;
    const monitor = new StreamMonitor(() => now);
    const source = new PassThrough();
    const out = sink();
    monitor.track(out, source, { deviceId: null, name: 'slow-drive.mkv' });

    out.writableNeedDrain = false;
    for (let i = 0; i < 20; i += 1) {
      now += 500;
      source.write(Buffer.alloc(64 * 1024));
    }
    source.resume();

    const [info] = monitor.list();
    expect(info?.bottleneck).toBe('source');
    expect(info?.networkWaitRatio).toBe(0);
  });

  it('withholds a verdict until it has enough samples', () => {
    const monitor = new StreamMonitor(() => 0);
    const source = new PassThrough();
    monitor.track(sink(), source, { deviceId: null, name: 'x' });
    source.write(Buffer.alloc(10));
    source.resume();
    expect(monitor.list()[0]?.bottleneck).toBe('none');
  });
});

describe('one activity row per playback', () => {
  it('records a played file once, however many ranges the player asked for', async () => {
    const ts = await startServer();
    started.push(ts);
    const share = tempDir('lc-stream-share-');
    await fs.writeFile(path.join(share, 'film.mp4'), Buffer.alloc(512 * 1024, 7));
    const folderId = await addFolder(ts, { path: share, label: 'Films' });
    const device = await pairDevice(ts, [{ folderId, mode: 'full' }]);

    const listing = await ts.json<{ entries: { id: string; name: string }[] }>(
      `/api/v1/folders/${folderId}/entries`,
      { headers: bearer(device.accessToken) },
    );
    const file = listing.entries.find((entry) => entry.name === 'film.mp4');
    expect(file).toBeDefined();

    const rowsFor = async () =>
      (await ts.json<{ entries: { kind: string; deviceId: string | null }[] }>('/operator/activity?limit=500'))
        .entries.filter((row) => row.kind === 'file.stream' && row.deviceId === device.deviceId).length;

    const before = await rowsFor();
    for (let i = 0; i < 30; i += 1) {
      const res = await ts.fetch(`/api/v1/files/${file!.id}/content`, {
        headers: { ...bearer(device.accessToken), range: `bytes=${i * 4096}-${i * 4096 + 4095}` },
      });
      expect(res.status).toBe(206);
      await res.arrayBuffer();
    }
    expect((await rowsFor()) - before).toBe(1);
  });
});

describe('indexing while something is playing', () => {
  it('waits between batches until the playback is over', async () => {
    const ts = await startServer();
    started.push(ts);
    const share = tempDir('lc-index-pause-');
    for (let i = 0; i < 10; i += 1) await fs.writeFile(path.join(share, `clip-${i}.mp4`), 'x');
    const folderId = await addFolder(ts, { path: share, label: 'Clips' });

    // A second indexer over the same database, with the pause under test control: "playing" for
    // the first few looks, then not. Batches of two, so a ten-file folder takes several.
    let looks = 0;
    const indexer = new Indexer({
      db: ts.server.ctx.db,
      log: silentLogger,
      events: ts.server.ctx.events,
      batchSize: 2,
      shouldPause: () => {
        looks += 1;
        return looks <= 3;
      },
    });

    const startedAt = Date.now();
    const result = await indexer.indexFolder(folderId);
    // It waited: three refusals at a quarter-second each, and the pass still finished.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(700);
    expect(looks).toBeGreaterThan(3);
    expect(result.fileCount).toBe(10);
  }, 15_000);
});
