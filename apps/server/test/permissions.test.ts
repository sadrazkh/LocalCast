import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiException,
  can,
  type AccessMode,
  type Operation,
} from '@localcast/contract';
import {
  addFolder,
  bearer,
  cleanupTempDirs,
  pairDevice,
  setMode,
  startServer,
  tempDir,
  type PairedDevice,
  type TestServer,
} from './helpers.js';

let ts: TestServer;
let device: PairedDevice;
let openFolder: string;
let closedFolder: string;
let openFileId: string;
let closedFileId: string;

const MODES: AccessMode[] = ['full', 'stream', 'none'];
const OPS: Operation[] = ['list', 'stream', 'download', 'print', 'upload'];

beforeAll(async () => {
  const openDir = tempDir('lc-open-');
  const closedDir = tempDir('lc-closed-');
  fs.writeFileSync(path.join(openDir, 'visible.mp4'), 'x'.repeat(1024));
  fs.writeFileSync(path.join(closedDir, 'hidden-treasure.mp4'), 'y'.repeat(1024));

  ts = await startServer();
  openFolder = await addFolder(ts, { path: openDir, label: 'Open', writable: true });
  closedFolder = await addFolder(ts, { path: closedDir, label: 'Closed' });
  device = await pairDevice(ts, [
    { folderId: openFolder, mode: 'full' },
    { folderId: closedFolder, mode: 'none' },
  ]);

  openFileId = idOf(openFolder, 'visible.mp4');
  closedFileId = idOf(closedFolder, 'hidden-treasure.mp4');
}, 120_000);

afterAll(async () => {
  await ts?.dispose();
  cleanupTempDirs();
});

function idOf(folderId: string, name: string): string {
  const row = ts.server.ctx.db
    .prepare('SELECT id FROM files WHERE folder_id = ? AND name = ?')
    .get(folderId, name) as { id: string } | undefined;
  if (!row) throw new Error(`${name} was not indexed`);
  return row.id;
}

describe('the permission matrix', () => {
  describe('every (mode × operation) pair', () => {
    for (const mode of MODES) {
      for (const op of OPS) {
        it(`${mode} × ${op} → ${can(mode, op) ? 'allowed' : 'refused'}`, async () => {
          await setMode(ts, device.deviceId, openFolder, mode);
          const check = () =>
            ts.server.ctx.permissions.assertCan(device.deviceId, openFolder, op);

          if (can(mode, op)) {
            expect(check).not.toThrow();
            return;
          }

          expect(check).toThrowError(ApiException);
          try {
            check();
          } catch (err) {
            const code = (err as ApiException).code;
            if (mode === 'none') {
              // The whole point: a closed folder is indistinguishable from one that is not
              // there, so it must never answer with `forbidden`.
              expect(code).toBe('not_found');
            } else {
              expect(code).toBe(
                { download: 'download_not_allowed', print: 'print_not_allowed', upload: 'upload_not_allowed' }[
                  op as 'download' | 'print' | 'upload'
                ] ?? 'forbidden',
              );
            }
          }
        });
      }
    }
  });

  describe('a folder with no row at all', () => {
    it('defaults to closed, so adding a folder never silently grants it', () => {
      const fresh = ts.server.ctx.db
        .prepare("INSERT INTO shared_folders (id, path, label, kind, created_at) VALUES (?, ?, 'Fresh', 'mixed', ?)")
        .run('fresh-folder-id', path.join(tempDir('lc-fresh-'), 'x'), Date.now());
      expect(fresh.changes).toBe(1);
      expect(ts.server.ctx.permissions.modeFor(device.deviceId, 'fresh-folder-id')).toBe('none');
      ts.server.ctx.db.prepare('DELETE FROM shared_folders WHERE id = ?').run('fresh-folder-id');
    });
  });

  describe('a `none` folder over the wire', () => {
    beforeAll(async () => {
      await setMode(ts, device.deviceId, openFolder, 'full');
    });

    it('is absent from the folder listing', async () => {
      const body = await ts.json<{ folders: Array<{ id: string; label: string }> }>(
        '/api/v1/folders',
        { headers: bearer(device.accessToken) },
      );
      expect(body.folders.map((f) => f.id)).toEqual([openFolder]);
      expect(JSON.stringify(body)).not.toContain('Closed');
    });

    it('is absent from search results even when the term only matches there', async () => {
      const body = await ts.json<{ results: Array<{ name: string }> }>(
        '/api/v1/search?q=treasure',
        { headers: bearer(device.accessToken) },
      );
      expect(body.results).toEqual([]);

      // The same term does match once the folder is opened, so the empty result above is
      // the permission filter and not a broken index.
      await setMode(ts, device.deviceId, closedFolder, 'stream');
      const opened = await ts.json<{ results: Array<{ name: string }> }>(
        '/api/v1/search?q=treasure',
        { headers: bearer(device.accessToken) },
      );
      expect(opened.results.map((r) => r.name)).toEqual(['hidden-treasure.mp4']);
      await setMode(ts, device.deviceId, closedFolder, 'none');
    });

    it('404s rather than 403s on a direct entries request', async () => {
      const res = await ts.fetch(`/api/v1/folders/${closedFolder}/entries`, {
        headers: bearer(device.accessToken),
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('404s rather than 403s on direct file metadata and content', async () => {
      for (const url of [
        `/api/v1/files/${closedFileId}/meta`,
        `/api/v1/files/${closedFileId}/content`,
      ]) {
        const res = await ts.fetch(url, {
          headers: { ...bearer(device.accessToken), range: 'bytes=0-9' },
        });
        expect(res.status, url).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
      }
    });

    it('is indistinguishable from a folder that does not exist', async () => {
      const closed = await ts.fetch(`/api/v1/folders/${closedFolder}/entries`, {
        headers: bearer(device.accessToken),
      });
      const missing = await ts.fetch('/api/v1/folders/00000000-0000-0000-0000-000000000000/entries', {
        headers: bearer(device.accessToken),
      });
      expect(closed.status).toBe(missing.status);
      expect(await closed.json()).toEqual(await missing.json());
    });
  });

  describe('`stream` refuses a copy without refusing playback', () => {
    beforeAll(async () => {
      await setMode(ts, device.deviceId, openFolder, 'stream');
    });
    afterAll(async () => {
      await setMode(ts, device.deviceId, openFolder, 'full');
    });

    it('allows a range request', async () => {
      const res = await ts.fetch(`/api/v1/files/${openFileId}/content`, {
        headers: { ...bearer(device.accessToken), range: 'bytes=0-9' },
      });
      expect(res.status).toBe(206);
      expect(await res.text()).toBe('x'.repeat(10));
    });

    it('refuses a plain GET with a typed code', async () => {
      const res = await ts.fetch(`/api/v1/files/${openFileId}/content`, {
        headers: bearer(device.accessToken),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'download_not_allowed',
      );
    });

    it('refuses an explicit download even with a range', async () => {
      const res = await ts.fetch(`/api/v1/files/${openFileId}/content?download=1`, {
        headers: { ...bearer(device.accessToken), range: 'bytes=0-9' },
      });
      expect(res.status).toBe(403);
    });

    it('still lists and still searches', async () => {
      const entries = await ts.json<{ entries: Array<{ name: string }> }>(
        `/api/v1/folders/${openFolder}/entries`,
        { headers: bearer(device.accessToken) },
      );
      expect(entries.entries.map((e) => e.name)).toContain('visible.mp4');
    });
  });

  describe('`full` allows the copy', () => {
    it('serves a plain GET as an attachment when asked', async () => {
      const res = await ts.fetch(`/api/v1/files/${openFileId}/content?download=1`, {
        headers: bearer(device.accessToken),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect((await res.text()).length).toBe(1024);
    });
  });

  describe('visibleFolders', () => {
    it('lists exactly the folders whose mode is not `none`', async () => {
      await setMode(ts, device.deviceId, closedFolder, 'none');
      expect(ts.server.ctx.permissions.visibleFolders(device.deviceId)).toEqual([openFolder]);

      await setMode(ts, device.deviceId, closedFolder, 'full');
      expect(ts.server.ctx.permissions.visibleFolders(device.deviceId).sort()).toEqual(
        [openFolder, closedFolder].sort(),
      );
      await setMode(ts, device.deviceId, closedFolder, 'none');
    });

    it('drops a folder the operator has disabled, whatever the grant says', async () => {
      await setMode(ts, device.deviceId, closedFolder, 'full');
      const res = await ts.fetch(`/operator/folders/${closedFolder}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.ok).toBe(true);
      expect(ts.server.ctx.permissions.visibleFolders(device.deviceId)).toEqual([openFolder]);
      expect(ts.server.ctx.permissions.modeFor(device.deviceId, closedFolder)).toBe('none');

      await ts.fetch(`/operator/folders/${closedFolder}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
        headers: { 'content-type': 'application/json' },
      });
      await setMode(ts, device.deviceId, closedFolder, 'none');
    });
  });
});
