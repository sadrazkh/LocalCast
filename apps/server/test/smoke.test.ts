import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EDGE_SECRET_HEADER } from '@localcast/contract';
import { addFolder, bearer, cleanupTempDirs, pairDevice, startServer, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

describe('server boot and the pairing handshake', () => {
  it('boots without the feature modules, pairs a device and lists a folder', async () => {
    const ts = await startServer();
    try {
      const media = tempDir('lc-media-');
      fs.writeFileSync(path.join(media, 'clip.mp4'), 'x'.repeat(64));
      fs.mkdirSync(path.join(media, 'sub'));
      fs.writeFileSync(path.join(media, 'sub', 'notes.pdf'), 'y'.repeat(32));

      const folderId = await addFolder(ts, { path: media, label: 'Media' });
      const device = await pairDevice(ts, [{ folderId, mode: 'full' }]);

      const me = await ts.json<{ device: { name: string }; permissions: unknown[] }>('/api/v1/me', {
        headers: bearer(device.accessToken),
      });
      expect(me.device.name).toBe('Test Phone');
      expect(me.permissions).toHaveLength(1);

      const folders = await ts.json<{ folders: Array<{ id: string; fileCount: number }> }>(
        '/api/v1/folders',
        { headers: bearer(device.accessToken) },
      );
      expect(folders.folders).toHaveLength(1);
      expect(folders.folders[0]?.fileCount).toBe(2);

      const entries = await ts.json<{ entries: Array<{ name: string; isDir: boolean }> }>(
        `/api/v1/folders/${folderId}/entries`,
        { headers: bearer(device.accessToken) },
      );
      expect(entries.entries.map((e) => e.name)).toEqual(['sub', 'clip.mp4']);

      const search = await ts.json<{ results: Array<{ name: string }> }>(
        '/api/v1/search?q=notes',
        { headers: bearer(device.accessToken) },
      );
      expect(search.results.map((r) => r.name)).toEqual(['notes.pdf']);
    } finally {
      await ts.dispose();
    }
  });

  it('refuses every request that does not carry the edge secret', async () => {
    const ts = await startServer();
    try {
      const res = await fetch(`${ts.base}/api/v1/folders`);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');

      const wrong = await fetch(`${ts.base}/api/v1/folders`, {
        headers: { [EDGE_SECRET_HEADER]: 'not-the-secret' },
      });
      expect(wrong.status).toBe(401);
    } finally {
      await ts.dispose();
    }
  });

  it('serves a typed body for an unknown route and never a stack trace', async () => {
    const ts = await startServer();
    try {
      const res = await ts.fetch('/nope');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('not_found');
      expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:/);

      // An unknown path *inside* the API prefix is answered by the auth guard, not by the
      // router table, so an anonymous caller cannot map which endpoints exist.
      const inside = await ts.fetch('/api/v1/nope');
      expect(inside.status).toBe(401);
    } finally {
      await ts.dispose();
    }
  });
});
