import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteActivityLog } from '../src/activity.js';
import { openDatabase, ownerUserId } from '../src/db/index.js';
import { InMemoryEventBus } from '../src/events/bus.js';
import { describe as describeMedia, toEntry } from '../src/library/mediaTypes.js';
import { createLogger, silentLogger } from '../src/logger.js';
import {
  addFolder,
  bearer,
  cleanupTempDirs,
  pairDevice,
  startServer,
  tempDir,
} from './helpers.js';

afterAll(cleanupTempDirs);

describe('the database opens, migrates and seeds itself', () => {
  it('records each migration and is idempotent across restarts', () => {
    const dir = tempDir('lc-db-');
    const file = path.join(dir, 'localcast.db');

    const first = openDatabase({ path: file, log: silentLogger });
    const applied = first.prepare('SELECT version, name FROM schema_migrations').all() as Array<{
      version: number;
      name: string;
    }>;
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect(applied[0]?.version).toBe(1);
    expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1);
    const owner = ownerUserId(first);
    first.close();

    // Reopening applies nothing and reseeds nothing: the same owner comes back.
    const second = openDatabase({ path: file, log: silentLogger });
    expect(second.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({
      n: applied.length,
    });
    expect(second.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get()).toEqual({
      n: 1,
    });
    expect(ownerUserId(second)).toBe(owner);
    expect(second.prepare('SELECT COUNT(*) AS n FROM network_config').get()).toEqual({ n: 1 });
    second.close();
  });

  it('seeds a network config a fresh install can actually act on', () => {
    const db = openDatabase({ path: path.join(tempDir('lc-db2-'), 'x.db'), log: silentLogger });
    const cfg = db.prepare('SELECT * FROM network_config WHERE id = 1').get() as {
      mode: string;
      cert_strategy: string;
      expose: string;
    };
    // `default` + `control-plane` is the only combination that needs nothing from the user.
    expect(cfg).toMatchObject({ mode: 'default', cert_strategy: 'control-plane', expose: 'tailnet' });
    db.close();
  });

  it('enforces the foreign keys the schema declares', () => {
    const db = openDatabase({ path: ':memory:', log: silentLogger });
    expect(() =>
      db
        .prepare(
          "INSERT INTO devices (id, user_id, name, platform, status, created_at) VALUES ('d','nope','n','web','pending',1)",
        )
        .run(),
    ).toThrowError(/FOREIGN KEY/i);
    db.close();
  });
});

describe('media classification is honest about what Safari can play', () => {
  it.each([
    ['movie.mp4', 'video', false, true],
    ['movie.m4v', 'video', false, true],
    ['movie.mov', 'video', false, true],
    ['movie.mkv', 'video', false, false],
    ['movie.avi', 'video', false, false],
    ['movie.wmv', 'video', false, false],
    ['movie.flv', 'video', false, false],
    ['movie.webm', 'video', false, false],
    ['song.mp3', 'audio', false, true],
    ['song.flac', 'audio', false, true],
    ['song.ogg', 'audio', false, false],
    ['scan.pdf', 'document', true, false],
    ['photo.jpg', 'image', true, false],
    ['photo.jpeg', 'image', true, false],
    ['photo.png', 'image', true, false],
    ['photo.gif', 'image', true, false],
    ['photo.bmp', 'image', true, false],
    ['photo.tiff', 'image', true, false],
    ['photo.webp', 'image', true, false],
    ['photo.heic', 'image', false, false],
    ['report.docx', 'document', false, false],
    ['archive.zip', 'archive', false, false],
    ['unknown.xyz', 'other', false, false],
    ['no-extension', 'other', false, false],
  ])('%s', (name, kind, printable, browserPlayable) => {
    const d = describeMedia(name);
    expect(d.kind).toBe(kind);
    expect(d.printable).toBe(printable);
    expect(d.browserPlayable).toBe(browserPlayable);
  });

  it('is case-insensitive about the extension', () => {
    expect(describeMedia('MOVIE.MP4').browserPlayable).toBe(true);
    expect(describeMedia('SCAN.PDF').printable).toBe(true);
  });

  it('never marks a directory as playable or printable', () => {
    const entry = toEntry({
      id: 'x',
      folderId: 'f',
      relPath: 'films.mp4',
      name: 'films.mp4',
      isDir: true,
      size: null,
      mtime: 1,
    });
    expect(entry.printable).toBe(false);
    expect(entry.browserPlayable).toBe(false);
    expect(entry.ext).toBeNull();
  });
});

describe('the activity log is capped', () => {
  it('keeps only the newest rows and never throws on a bad write', () => {
    const db = openDatabase({ path: ':memory:', log: silentLogger });
    const log = new SqliteActivityLog(db, silentLogger, { cap: 50, trimEvery: 10 });

    for (let i = 0; i < 500; i++) log.record('test.event', null, { i });
    expect(log.count()).toBeLessThanOrEqual(50);

    const newest = log.list(5);
    expect(newest[0]?.detail).toEqual({ i: 499 });

    // A device id that does not exist would violate the foreign key; the entry survives
    // without its device rather than turning a working request into a 500.
    expect(() => log.record('test.orphan', 'no-such-device')).not.toThrow();
    expect(log.list(1)[0]?.kind).toBe('test.orphan');

    // A detail object that cannot be serialised is dropped, not fatal.
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => log.record('test.cyclic', null, cyclic)).not.toThrow();

    db.close();
  });
});

describe('the event bus', () => {
  it('only delivers an event to the device it belongs to', () => {
    const bus = new InMemoryEventBus({
      visibility: (event, deviceId) => event.type !== 'device' || event.deviceId === deviceId,
    });
    const alice: string[] = [];
    const bob: string[] = [];
    bus.subscribe('alice', (e) => alice.push(e.type));
    bus.subscribe('bob', (e) => bob.push(e.type));

    bus.publish({ type: 'device', deviceId: 'alice', status: 'active' });
    bus.publish({ type: 'connection', state: 'connected' });

    expect(alice).toEqual(['device', 'connection']);
    expect(bob).toEqual(['connection']);
  });

  it('replays only what a reconnecting device missed, and never heartbeats', () => {
    const bus = new InMemoryEventBus();
    bus.publish({ type: 'connection', state: 'connecting' });
    const mark = bus.currentId();
    bus.publish({ type: 'heartbeat', at: 1 });
    bus.publish({ type: 'connection', state: 'connected' });

    const replayed = bus.replay('anyone', mark);
    expect(replayed.map((e) => e.event.type)).toEqual(['connection']);
    expect(replayed[0]?.event).toMatchObject({ state: 'connected' });
  });

  it('keeps notifying the others when one subscriber throws', () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe('broken', () => {
      throw new Error('this subscriber is on fire');
    });
    bus.subscribe('fine', (e) => seen.push(e.type));
    expect(() => bus.publish({ type: 'connection', state: 'connected' })).not.toThrow();
    expect(seen).toEqual(['connection']);
  });

  it('drops the oldest entries rather than growing without bound', () => {
    const bus = new InMemoryEventBus({ bufferSize: 5 });
    for (let i = 0; i < 20; i++) bus.publish({ type: 'connection', state: 'connected' });
    expect(bus.replay('anyone', 0)).toHaveLength(5);
  });
});

describe('the indexer', () => {
  it('is incremental, and marks a vanished root unavailable instead of deleting its rows', async () => {
    const media = tempDir('lc-index-');
    fs.writeFileSync(path.join(media, 'one.mp4'), 'a'.repeat(10));
    fs.mkdirSync(path.join(media, 'season 1'));
    fs.writeFileSync(path.join(media, 'season 1', 'two.mkv'), 'b'.repeat(20));

    const ts = await startServer();
    try {
      const folderId = await addFolder(ts, { path: media, label: 'Series' });

      const first = await ts.server.indexer.indexFolder(folderId);
      // The first pass in `addFolder` already inserted everything, so a rescan that changes
      // nothing must write nothing — otherwise every rescan of a large library rebuilds the
      // whole FTS index.
      expect(first.inserted).toBe(0);
      expect(first.updated).toBe(0);
      expect(first.fileCount).toBe(2);
      expect(first.totalBytes).toBe(30);

      fs.writeFileSync(path.join(media, 'three.mp4'), 'c'.repeat(5));
      const second = await ts.server.indexer.indexFolder(folderId);
      expect(second.inserted).toBe(1);
      expect(second.fileCount).toBe(3);

      fs.rmSync(path.join(media, 'three.mp4'));
      const third = await ts.server.indexer.indexFolder(folderId);
      expect(third.removed).toBe(1);
      expect(third.fileCount).toBe(2);

      // Now pull the drive out from under it.
      const rowsBefore = ts.server.ctx.db
        .prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id = ?')
        .get(folderId) as { n: number };
      fs.rmSync(media, { recursive: true, force: true });

      const gone = await ts.server.indexer.indexFolder(folderId);
      expect(gone.available).toBe(false);
      const folder = ts.server.ctx.db
        .prepare('SELECT available FROM shared_folders WHERE id = ?')
        .get(folderId) as { available: number };
      expect(folder.available).toBe(0);
      // The rows — and therefore the permission grants pointing at them — survive.
      expect(
        ts.server.ctx.db
          .prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id = ?')
          .get(folderId),
      ).toEqual(rowsBefore);
    } finally {
      await ts.dispose();
    }
  }, 60_000);

  it('serves a typed 503 for a folder whose drive is gone', async () => {
    const media = tempDir('lc-gone-');
    fs.writeFileSync(path.join(media, 'x.mp4'), 'a'.repeat(10));
    const ts = await startServer();
    try {
      const folderId = await addFolder(ts, { path: media, label: 'Removable' });
      const device = await pairDevice(ts, [{ folderId, mode: 'full' }]);
      const fileId = (
        ts.server.ctx.db.prepare('SELECT id FROM files WHERE name = ?').get('x.mp4') as {
          id: string;
        }
      ).id;

      fs.rmSync(media, { recursive: true, force: true });
      await ts.server.indexer.indexFolder(folderId);

      const res = await ts.fetch(`/api/v1/files/${fileId}/content`, {
        headers: { ...bearer(device.accessToken), range: 'bytes=0-1' },
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'folder_unavailable',
      );

      // Greyed, not vanished: the grant is still real, so the folder stays in the listing.
      const folders = await ts.json<{ folders: Array<{ id: string; available: boolean }> }>(
        '/api/v1/folders',
        { headers: bearer(device.accessToken) },
      );
      expect(folders.folders[0]).toMatchObject({ id: folderId, available: false });
    } finally {
      await ts.dispose();
    }
  }, 60_000);
});

describe('server-sent events', () => {
  it('streams, heartbeats and honours Last-Event-ID', async () => {
    const ts = await startServer({ sseHeartbeatMs: 120 });
    try {
      const media = tempDir('lc-sse-');
      fs.writeFileSync(path.join(media, 'a.mp4'), 'a');
      const folderId = await addFolder(ts, { path: media, label: 'SSE' });
      const device = await pairDevice(ts, [{ folderId, mode: 'full' }]);

      const controller = new AbortController();
      const res = await ts.fetch('/api/v1/events', {
        headers: bearer(device.accessToken),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(res.headers.get('cache-control')).toMatch(/no-cache/);

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = '';

      const readUntil = async (predicate: (s: string) => boolean, budget = 40): Promise<void> => {
        for (let i = 0; i < budget && !predicate(text); i++) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      };

      await readUntil((s) => s.includes('retry:'));
      expect(text).toContain('retry: 3000');

      ts.server.ctx.events.publish({ type: 'device', deviceId: device.deviceId, status: 'active' });
      await readUntil((s) => s.includes('event: device'));
      expect(text).toMatch(/id: \d+\nevent: device\ndata: /);

      await readUntil((s) => s.includes('event: heartbeat'));
      expect(text).toContain('event: heartbeat');

      controller.abort();
      await reader.cancel().catch(() => undefined);

      // Reconnect with the id we last saw and get only what came after it.
      const lastId = Number([...text.matchAll(/^id: (\d+)$/gm)].at(-1)?.[1]);
      ts.server.ctx.events.publish({
        type: 'folder',
        folderId,
        available: true,
        lastIndexedAt: 1,
      });

      const replayController = new AbortController();
      const replay = await ts.fetch('/api/v1/events', {
        headers: { ...bearer(device.accessToken), 'last-event-id': String(lastId) },
        signal: replayController.signal,
      });
      const replayReader = (replay.body as ReadableStream<Uint8Array>).getReader();
      let replayText = '';
      for (let i = 0; i < 20 && !replayText.includes('event: folder'); i++) {
        const { value, done } = await replayReader.read();
        if (done) break;
        replayText += decoder.decode(value, { stream: true });
      }
      expect(replayText).toContain('event: folder');
      // The device event was already delivered before the disconnect, so it is not repeated.
      expect(replayText).not.toContain('event: device');

      replayController.abort();
      await replayReader.cancel().catch(() => undefined);
    } finally {
      await ts.dispose();
    }
  }, 60_000);

  it('needs a bearer token like every other device route', async () => {
    const ts = await startServer();
    try {
      const res = await ts.fetch('/api/v1/events');
      expect(res.status).toBe(401);
    } finally {
      await ts.dispose();
    }
  });
});

describe('logging', () => {
  it('redacts secrets that appear in metadata', () => {
    const lines: string[] = [];
    const sink = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
    const log = createLogger('debug', sink as unknown as Console);
    log.info('paired', { deviceId: 'd1', davPassword: 'hunter2', secret: 'abc', name: 'Phone' });
    expect(lines[0]).toContain('"deviceId":"d1"');
    expect(lines[0]).toContain('"name":"Phone"');
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).toContain('[redacted]');
  });

  it('honours the level threshold', () => {
    const lines: string[] = [];
    const sink = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
    const log = createLogger('warn', sink as unknown as Console);
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    expect(lines).toHaveLength(1);
  });
});
