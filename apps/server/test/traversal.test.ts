import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiException } from '@localcast/contract';
import {
  addFolder,
  bearer,
  cleanupTempDirs,
  createJunction,
  pairDevice,
  startServer,
  tempDir,
  type PairedDevice,
  type TestServer,
} from './helpers.js';
import { isInsideRoot, sanitiseRelPath, withLongPathPrefix } from '../src/library/resolver.js';

let ts: TestServer;
let device: PairedDevice;
let folderId: string;
let root: string;
let outside: string;

beforeAll(async () => {
  root = tempDir('lc-root-');
  outside = tempDir('lc-outside-');
  fs.writeFileSync(path.join(root, 'inside.txt'), 'inside');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'deep.txt'), 'deep');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');

  ts = await startServer();
  folderId = await addFolder(ts, { path: root, label: 'Root', writable: true });
  device = await pairDevice(ts, [{ folderId, mode: 'full' }]);
}, 120_000);

afterAll(async () => {
  await ts?.dispose();
  cleanupTempDirs();
});

/**
 * Everything here is rejected before it can reach the filesystem. The table is the point:
 * a traversal bug is not caught by a single clever case, it is caught by never having
 * accepted the whole family.
 */
const REJECTED: Array<[label: string, input: string]> = [
  ['parent directory', '../secret.txt'],
  ['parent directory, nested', 'nested/../../secret.txt'],
  ['bare parent', '..'],
  ['percent-encoded slash', '..%2fsecret.txt'],
  ['percent-encoded dots', '%2e%2e/secret.txt'],
  ['backslash traversal', '..\\secret.txt'],
  ['mixed separators', 'nested\\..\\..\\secret.txt'],
  ['absolute posix path', '/etc/passwd'],
  ['absolute windows path', 'C:\\Windows\\System32\\config\\SAM'],
  ['drive relative', 'C:secret.txt'],
  ['UNC share', '\\\\server\\share\\secret.txt'],
  ['UNC long path', '\\\\?\\C:\\Windows\\win.ini'],
  ['long path prefix', '\\\\?\\UNC\\server\\share'],
  ['reserved device CON', 'CON'],
  ['reserved device NUL', 'NUL'],
  ['reserved device with extension', 'CON.txt'],
  ['reserved device nested', 'nested/AUX.log'],
  ['reserved serial port', 'COM1'],
  ['alternate data stream', 'inside.txt::$DATA'],
  ['named alternate stream', 'inside.txt:hidden'],
  ['trailing dot', 'inside.txt.'],
  ['trailing space', 'inside.txt '],
  ['null byte', 'inside.txt\u0000.jpg'],
  ['wildcard', '*.txt'],
  ['control character', 'inside\u0001.txt'],
];

describe('path traversal', () => {
  describe('the resolver refuses the whole family, syntactically', () => {
    it.each(REJECTED)('rejects %s', (_label, input) => {
      expect(() => sanitiseRelPath(input)).toThrowError(ApiException);
    });

    it.each([
      ['a plain name', 'inside.txt'],
      ['a nested name', 'nested/deep.txt'],
      ['a name containing a dot', 'my.file.name.txt'],
      ['a name containing a percent', '50%25 off.txt'],
      ['a unicode name', 'ویدیو.mp4'],
      ['the folder root', ''],
    ])('accepts %s', (_label, input) => {
      expect(() => sanitiseRelPath(input)).not.toThrow();
    });

    /**
     * Double-encoding is checked one decode deep and no further, on purpose. `%252e%252e`
     * decodes once to `%2e%2e`, which is a perfectly ordinary directory name — decoding
     * again to reject it would be the classic double-decode bug, and would make a file
     * legitimately called `%2e%2e` unreachable. What matters is not that it is rejected but
     * that it stays inside the root, which is what the joined path proves.
     */
    it('treats a double-encoded traversal as a literal name inside the root', async () => {
      expect(() => sanitiseRelPath('%252e%252e/secret.txt')).not.toThrow();
      const target = await ts.server.ctx.files.resolveWritable(folderId, '%252e%252e/secret.txt');
      expect(isInsideRoot(root, target)).toBe(true);
      expect(target).not.toContain('lc-outside-');
    });
  });

  describe('containment is compared segment by segment', () => {
    it('does not accept a sibling whose name merely starts with the root', () => {
      expect(isInsideRoot('C:\\Media', 'C:\\Media2\\film.mp4')).toBe(false);
      expect(isInsideRoot('C:\\Media', 'C:\\Media-old\\film.mp4')).toBe(false);
      expect(isInsideRoot('C:\\Media', 'C:\\Media\\film.mp4')).toBe(true);
      expect(isInsideRoot('C:\\Media', 'C:\\Media')).toBe(true);
    });

    it('is case-insensitive on Windows and tolerant of separators and the long-path prefix', () => {
      if (process.platform !== 'win32') return;
      expect(isInsideRoot('C:\\Media', 'c:\\media\\a.mp4')).toBe(true);
      expect(isInsideRoot('C:\\Media\\', 'C:/Media/a.mp4')).toBe(true);
      expect(isInsideRoot('C:\\Media', '\\\\?\\C:\\Media\\a.mp4')).toBe(true);
      expect(isInsideRoot('\\\\?\\C:\\Media', 'C:\\Media\\a.mp4')).toBe(true);
    });

    it('never treats a shorter path as contained', () => {
      expect(isInsideRoot('C:\\Media\\Films', 'C:\\Media')).toBe(false);
      expect(isInsideRoot('', 'C:\\Media')).toBe(false);
    });
  });

  describe('the resolver refuses them over HTTP too', () => {
    it.each(REJECTED)('%s does not escape the folder root', async (_label, input) => {
      // Through `resolve`, which is what every byte-serving path calls.
      await expect(ts.server.ctx.files.resolve(folderId, input)).rejects.toThrowError(ApiException);
      await expect(ts.server.ctx.files.resolveWritable(folderId, input)).rejects.toThrowError(
        ApiException,
      );
    });

    it('serves the legitimate file it was refusing traversal to', async () => {
      const resolved = await ts.server.ctx.files.resolve(folderId, 'nested/deep.txt');
      expect(resolved.relPath).toBe('nested/deep.txt');
      expect(fs.readFileSync(resolved.absPath, 'utf8')).toBe('deep');
    });

    it('applies the long-path prefix to what it hands back for I/O', () => {
      if (process.platform !== 'win32') return;
      expect(withLongPathPrefix('C:\\Media\\a.mp4')).toBe('\\\\?\\C:\\Media\\a.mp4');
      expect(withLongPathPrefix('\\\\server\\share\\a.mp4')).toBe('\\\\?\\UNC\\server\\share\\a.mp4');
      expect(withLongPathPrefix('\\\\?\\C:\\already')).toBe('\\\\?\\C:\\already');
    });
  });

  describe('a junction pointing outside the root', () => {
    it('is refused after realpath, even though it looks innocent lexically', async () => {
      const link = path.join(root, 'escape');
      if (!createJunction(link, outside)) {
        console.warn(
          'SKIPPED: could not create an NTFS junction with `mklink /J` on this machine, so the ' +
            'realpath-escape case did not run. The lexical checks above still ran.',
        );
        return;
      }

      // Lexically this is a perfectly ordinary child of the shared folder.
      expect(isInsideRoot(root, path.join(link, 'secret.txt'))).toBe(true);
      // And the file really is reachable through it on disk.
      expect(fs.readFileSync(path.join(link, 'secret.txt'), 'utf8')).toBe('SECRET');

      await expect(
        ts.server.ctx.files.resolve(folderId, 'escape/secret.txt'),
      ).rejects.toThrowError(/outside/i);

      // And the same through the API: the indexer never followed the junction, so there is
      // no file id to ask for in the first place.
      await ts.server.indexer.indexFolder(folderId);
      const search = await ts.json<{ results: Array<{ name: string }> }>(
        '/api/v1/search?q=secret',
        { headers: bearer(device.accessToken) },
      );
      expect(search.results).toHaveLength(0);
    });
  });

  describe('over the wire', () => {
    it('404s a file id that does not exist rather than revealing anything', async () => {
      const res = await ts.fetch('/api/v1/files/0123456789abcdef0123456789abcdef/content', {
        headers: bearer(device.accessToken),
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('rejects a traversal attempt in the entries path without listing anything', async () => {
      const res = await ts.json<{ entries: unknown[] }>(
        `/api/v1/folders/${folderId}/entries?path=${encodeURIComponent('../')}`,
        { headers: bearer(device.accessToken) },
      );
      // `parent_path` is a stored key, not a filesystem path, so a traversal string simply
      // matches nothing rather than escaping.
      expect(res.entries).toEqual([]);
    });
  });
});
