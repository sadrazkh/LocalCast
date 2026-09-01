import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiException, ErrorCode } from '@localcast/contract';
import type { Database as Db } from 'better-sqlite3';
import type { FileResolver, ResolvedFile } from '../kernel.js';
import { toEntry } from './mediaTypes.js';

/**
 * Path resolution. Everything that serves a byte goes through here, so this file is the one
 * place a traversal bug would be fatal, and it is written to be boringly paranoid.
 *
 * The order matters: reject syntactically, join, check lexically, THEN `realpath` and check
 * again. The lexical check is not sufficient (a junction defeats it) and the realpath check
 * is not sufficient on its own either (an absolute or device path must never reach the
 * filesystem at all), so both are done.
 */

const IS_WINDOWS = process.platform === 'win32';
const LONG_PATH_PREFIX = '\\\\?\\';

/**
 * Reserved DOS device names. Windows resolves these *anywhere* in a path, with or without an
 * extension, so `logs/CON.txt` opens the console rather than a file.
 */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', 'CLOCK$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export interface FolderRow {
  id: string;
  path: string;
  label: string;
  kind: 'video' | 'documents' | 'photos' | 'mixed';
  writable: number;
  enabled: number;
  available: number;
  auto_index: number;
  last_indexed_at: number | null;
  file_count: number | null;
  total_bytes: number | null;
  created_at: number;
}

function escapes(message = 'Path is not valid'): ApiException {
  return new ApiException(ErrorCode.PATH_ESCAPES_ROOT, message);
}

function notFound(): ApiException {
  return new ApiException(ErrorCode.NOT_FOUND, 'Not found');
}

export function stripLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith(LONG_PATH_PREFIX)) return p.slice(4);
  return p;
}

/**
 * Windows' 260-character MAX_PATH still bites on a real media library. The `\\?\` form lifts
 * it, but it also disables all path normalisation, so it may only be applied to a path that
 * is already absolute, already backslash-separated and already free of `.`/`..`.
 */
export function withLongPathPrefix(p: string): string {
  if (!IS_WINDOWS) return p;
  if (p.startsWith(LONG_PATH_PREFIX)) return p;
  if (p.startsWith('\\\\')) return `${LONG_PATH_PREFIX}UNC\\${p.slice(2)}`;
  if (/^[a-zA-Z]:\\/.test(p)) return LONG_PATH_PREFIX + p;
  return p;
}

function splitSegments(p: string): string[] {
  return stripLongPathPrefix(p)
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
}

function sameSegment(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Segment-wise containment. A raw `startsWith` would accept `C:\Media2` for a root of
 * `C:\Media`, and appending a separator before comparing still trips over case and over
 * trailing separators. Comparing whole segments has neither problem.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const r = splitSegments(root);
  const c = splitSegments(candidate);
  if (r.length === 0) return false;
  if (c.length < r.length) return false;
  for (let i = 0; i < r.length; i++) {
    if (!sameSegment(r[i] as string, c[i] as string)) return false;
  }
  return true;
}

/**
 * Rejects a folder-relative path outright, before it can be joined to anything.
 *
 * Percent-decoding is deliberately *not* performed for I/O — decoding twice is its own
 * classic bug. The decoded form is examined only to reject input that would be traversal
 * after a decode somewhere else in the chain; the literal string is what gets joined.
 */
export function sanitiseRelPath(input: string): string[] {
  if (input.includes('\0')) throw escapes('Path contains a null byte');

  const forms = [input];
  if (input.includes('%')) {
    try {
      const decoded = decodeURIComponent(input);
      if (decoded !== input) forms.push(decoded);
    } catch {
      // Malformed escapes cannot decode into a separator either, so nothing extra to check.
    }
  }

  for (const form of forms) {
    if (form.includes('\0')) throw escapes('Path contains a null byte');
    // Absolute in any Windows or POSIX spelling, including the long-path and UNC forms.
    if (form.startsWith('/') || form.startsWith('\\')) throw escapes('Path must be relative');
    if (/^[a-zA-Z]:/.test(form)) throw escapes('Path must be relative');

    for (const raw of form.split(/[\\/]+/)) {
      if (raw.length === 0) continue;
      if (raw === '.' || raw === '..') throw escapes('Path may not traverse upwards');
      // `:` covers alternate data streams (`file.txt::$DATA`) and drive-relative spellings in
      // one rule. `*?<>|"` are invalid on NTFS and are wildcards to several Win32 calls.
      if (/[:*?<>|"]/.test(raw)) throw escapes('Path contains an illegal character');
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f]/.test(raw)) throw escapes('Path contains a control character');
      // Win32 silently strips trailing dots and spaces, so `evil. ` and `evil` are the same
      // file; accepting both would make the name we checked differ from the file we open.
      if (/[. ]$/.test(raw)) throw escapes('Path segment may not end in a dot or space');
      const stem = (raw.split('.')[0] ?? '').toUpperCase();
      if (RESERVED.has(stem)) throw escapes('Path refers to a reserved device name');
    }
  }

  return input.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** Stable across reindexing, so a client's cached id keeps working after a rescan. */
export function fileIdFor(folderId: string, relPath: string): string {
  return createHash('sha256').update(`${folderId}\u0000${relPath}`).digest('hex').slice(0, 32);
}

async function realpathOrDeepest(target: string): Promise<{ real: string; existed: boolean }> {
  try {
    return { real: await fs.realpath(target), existed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // The leaf does not exist yet (an upload target). Resolve the deepest ancestor that does
  // and re-append the tail, so a junction in the middle of the path is still caught.
  const parts = splitSegments(target);
  const isUnc = stripLongPathPrefix(target).startsWith('\\\\');
  const tail: string[] = [];
  // Stop above a bare drive letter: `realpath('C:')` resolves to the current directory on
  // that drive, which is emphatically not the same place as `C:\`.
  for (let depth = parts.length; depth > 1; depth--) {
    const head = parts.slice(0, depth);
    const probe = isUnc
      ? `\\\\${head.join('\\')}`
      : IS_WINDOWS
        ? head.join('\\')
        : `/${head.join('/')}`;
    try {
      const real = await fs.realpath(withLongPathPrefix(probe));
      return { real: tail.length ? path.join(real, ...tail) : real, existed: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      tail.unshift(parts[depth - 1] as string);
    }
  }
  throw notFound();
}

export interface FsFileResolverDeps {
  db: Db;
}

export class FsFileResolver implements FileResolver {
  constructor(private readonly deps: FsFileResolverDeps) {}

  getFolder(folderId: string): FolderRow {
    const row = this.deps.db.prepare('SELECT * FROM shared_folders WHERE id = ?').get(folderId) as
      | FolderRow
      | undefined;
    if (!row || row.enabled === 0) throw notFound();
    return row;
  }

  /**
   * Resolve without stat-ing, for callers that need the path but not the metadata. Returns
   * both the plain and the long-path form; the plain one is what gets compared and logged.
   */
  private async resolvePath(
    folder: FolderRow,
    relPath: string,
  ): Promise<{ absPath: string; realPath: string; segments: string[] }> {
    const segments = sanitiseRelPath(relPath ?? '');
    const root = stripLongPathPrefix(folder.path);

    const joined = segments.length === 0 ? root : path.resolve(root, ...segments);

    // Cheap lexical check first: an absolute path or a `..` that slipped past the syntax
    // rules dies here without ever touching the filesystem.
    if (!isInsideRoot(root, joined)) throw escapes();

    const rootReal = await fs.realpath(withLongPathPrefix(root)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ApiException(ErrorCode.FOLDER_UNAVAILABLE, 'This folder is not available');
      }
      throw err;
    });

    const { real } = await realpathOrDeepest(withLongPathPrefix(joined));

    // The one that actually matters: a junction or symlink pointing at `C:\Windows` looks
    // perfectly innocent lexically and only reveals itself after `realpath`.
    if (!isInsideRoot(stripLongPathPrefix(rootReal), stripLongPathPrefix(real))) {
      throw escapes('Path resolves outside its shared folder');
    }

    return {
      absPath: withLongPathPrefix(stripLongPathPrefix(real)),
      realPath: stripLongPathPrefix(real),
      segments,
    };
  }

  async resolve(folderId: string, relPath: string): Promise<ResolvedFile> {
    const folder = this.getFolder(folderId);
    if (folder.available === 0) {
      throw new ApiException(ErrorCode.FOLDER_UNAVAILABLE, 'This folder is not available');
    }

    const { absPath, segments } = await this.resolvePath(folder, relPath);

    // Fresh stat, every time. The `files` index is allowed to be stale; a stale index may
    // show a file that has gone, but it must never decide which bytes are served.
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound();
      if (code === 'EPERM' || code === 'EACCES') throw notFound();
      throw err;
    }

    const posixRel = segments.join('/');
    const name = segments.length === 0 ? folder.label : (segments[segments.length - 1] as string);
    const isDir = stat.isDirectory();

    // Anything that is neither a regular file nor a directory — a pipe, a device — is not a
    // library entry, and streaming it would block forever.
    if (!isDir && !stat.isFile()) throw notFound();

    return {
      folderId: folder.id,
      absPath,
      relPath: posixRel,
      size: isDir ? 0 : stat.size,
      mtimeMs: stat.mtimeMs,
      isDir,
      entry: toEntry({
        id: fileIdFor(folder.id, posixRel),
        folderId: folder.id,
        relPath: posixRel,
        name,
        isDir,
        size: isDir ? null : stat.size,
        mtime: Math.floor(stat.mtimeMs),
      }),
    };
  }

  async resolveById(fileId: string): Promise<ResolvedFile> {
    const row = this.deps.db
      .prepare('SELECT folder_id, rel_path FROM files WHERE id = ?')
      .get(fileId) as { folder_id: string; rel_path: string } | undefined;
    if (!row) throw notFound();
    // The index is trusted only to turn an opaque id into a name. From here the path is
    // re-sanitised, re-resolved and re-stat-ed exactly as if the client had typed it.
    return this.resolve(row.folder_id, row.rel_path);
  }

  async resolveWritable(folderId: string, relPath: string): Promise<string> {
    const folder = this.getFolder(folderId);
    if (folder.writable === 0) {
      throw new ApiException(ErrorCode.UPLOAD_NOT_ALLOWED, 'This folder does not accept uploads');
    }
    if (folder.available === 0) {
      throw new ApiException(ErrorCode.FOLDER_UNAVAILABLE, 'This folder is not available');
    }
    const segments = sanitiseRelPath(relPath ?? '');
    if (segments.length === 0) {
      throw escapes('An upload needs a file name');
    }
    const { absPath } = await this.resolvePath(folder, relPath);
    return absPath;
  }
}
