import fs from 'node:fs/promises';
import path from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import type { EventBus, Logger } from '../kernel.js';
import { describe } from './mediaTypes.js';
import { fileIdFor, stripLongPathPrefix, withLongPathPrefix, type FolderRow } from './resolver.js';

/**
 * Walks the shared folders into the `files` table so that listing, counting and search do
 * not have to hit the disk. It is an index and nothing more: nothing here decides which
 * bytes get served, so a stale row is a cosmetic problem rather than a security one.
 */

export interface IndexResult {
  folderId: string;
  available: boolean;
  fileCount: number;
  totalBytes: number;
  inserted: number;
  updated: number;
  removed: number;
  durationMs: number;
}

/** Windows litter that is never part of a media library and is often unreadable anyway. */
const SKIP_DIRS = new Set([
  '$RECYCLE.BIN',
  'SYSTEM VOLUME INFORMATION',
  '$WINDOWS.~BT',
  '$WINDOWS.~WS',
  'RECYCLER',
  '.GIT',
]);

function shouldSkipEntry(name: string): boolean {
  if (SKIP_DIRS.has(name.toUpperCase())) return true;
  // Office lock files and Windows thumbnail caches.
  if (name.startsWith('~$')) return true;
  if (name.toLowerCase() === 'thumbs.db' || name.toLowerCase() === 'desktop.ini') return true;
  return false;
}

interface ExistingRow {
  id: string;
  size: number | null;
  mtime: number | null;
  is_dir: number;
}

interface WalkedEntry {
  relPath: string;
  parentPath: string;
  name: string;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
}

export interface IndexerDeps {
  db: Db;
  log: Logger;
  events: EventBus;
  /** Guard against a pathologically deep or cyclic tree. */
  maxDepth?: number;
}

export class Indexer {
  /**
   * Coalesces overlapping requests for the same folder. A second caller gets the promise of
   * the pass already running rather than a fabricated "skipped" result — the operator route
   * kicks off an index when a folder is added and the caller may well ask for one straight
   * after, and returning stale counts there is how a test, or a panel, sees zero files in a
   * folder that has plenty.
   */
  private readonly inFlight = new Map<string, Promise<IndexResult>>();

  constructor(private readonly deps: IndexerDeps) {}

  listFolders(): FolderRow[] {
    return this.deps.db
      .prepare('SELECT * FROM shared_folders WHERE enabled = 1')
      .all() as FolderRow[];
  }

  async indexAll(): Promise<IndexResult[]> {
    const out: IndexResult[] = [];
    for (const folder of this.listFolders()) {
      if (folder.auto_index === 0) continue;
      out.push(await this.indexFolder(folder.id));
    }
    return out;
  }

  indexFolder(folderId: string): Promise<IndexResult> {
    const running = this.inFlight.get(folderId);
    if (running) return running;
    const pass = this.runIndex(folderId).finally(() => {
      this.inFlight.delete(folderId);
    });
    this.inFlight.set(folderId, pass);
    return pass;
  }

  private async runIndex(folderId: string): Promise<IndexResult> {
    const started = Date.now();
    const { db, log } = this.deps;

    const folder = db.prepare('SELECT * FROM shared_folders WHERE id = ?').get(folderId) as
      | FolderRow
      | undefined;
    if (!folder) throw new Error(`unknown folder ${folderId}`);

    const root = withLongPathPrefix(stripLongPathPrefix(folder.path));
    let walked: WalkedEntry[];
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        throw Object.assign(new Error('not a directory'), { code: 'ENOENT' });
      }
      walked = await this.walk(root, this.deps.maxDepth ?? 32);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EPERM' || code === 'EACCES') {
        // An unplugged drive marks the folder unavailable and keeps every row. Deleting them
        // would silently discard the permission grants pointing at them, so the user would
        // have to rebuild the matrix every time they took a disk out.
        this.markUnavailable(folder);
        return this.unavailableResult(folder, started);
      }
      throw err;
    }

    const result = this.reconcile(folder, walked, started);
    log.info('folder indexed', {
      folderId,
      files: result.fileCount,
      inserted: result.inserted,
      updated: result.updated,
      removed: result.removed,
      durationMs: result.durationMs,
    });
    this.deps.events.publish({
      type: 'folder',
      folderId,
      available: true,
      lastIndexedAt: started,
    });
    return result;
  }

  private unavailableResult(folder: FolderRow, started: number): IndexResult {
    return {
      folderId: folder.id,
      available: false,
      // The last known counts, not zero: the panel greys the folder rather than claiming the
      // library just lost every file on that disk.
      fileCount: folder.file_count ?? 0,
      totalBytes: folder.total_bytes ?? 0,
      inserted: 0,
      updated: 0,
      removed: 0,
      durationMs: Date.now() - started,
    };
  }

  private markUnavailable(folder: FolderRow): void {
    this.deps.db
      .prepare('UPDATE shared_folders SET available = 0 WHERE id = ?')
      .run(folder.id);
    this.deps.log.warn('shared folder is not reachable', { folderId: folder.id, path: folder.path });
    this.deps.events.publish({
      type: 'folder',
      folderId: folder.id,
      available: false,
      lastIndexedAt: folder.last_indexed_at,
    });
  }

  private async walk(root: string, maxDepth: number): Promise<WalkedEntry[]> {
    const out: WalkedEntry[] = [];
    const queue: Array<{ abs: string; rel: string; depth: number }> = [
      { abs: root, rel: '', depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.pop() as { abs: string; rel: string; depth: number };
      let dirents;
      try {
        dirents = await fs.readdir(current.abs, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') continue;
        throw err;
      }

      for (const dirent of dirents) {
        if (shouldSkipEntry(dirent.name)) continue;
        // Symlinks and junctions are skipped rather than followed: following them would let
        // a link inside a shared folder index the whole disk, and the resolver would then
        // refuse to serve the very rows the index advertised.
        if (dirent.isSymbolicLink()) continue;
        if (!dirent.isDirectory() && !dirent.isFile()) continue;

        const rel = current.rel === '' ? dirent.name : `${current.rel}/${dirent.name}`;
        const abs = path.join(current.abs, dirent.name);

        if (dirent.isDirectory()) {
          out.push({
            relPath: rel,
            parentPath: current.rel,
            name: dirent.name,
            isDir: true,
            size: null,
            mtime: await mtimeOf(abs),
          });
          if (current.depth + 1 < maxDepth) {
            queue.push({ abs, rel, depth: current.depth + 1 });
          }
          continue;
        }

        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        out.push({
          relPath: rel,
          parentPath: current.rel,
          name: dirent.name,
          isDir: false,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs),
        });
      }
    }

    return out;
  }

  /**
   * Incremental by `(size, mtime)`. Rows whose stat is unchanged are left completely alone —
   * rewriting them would fire the FTS triggers and turn a no-op rescan of a 200k-file library
   * into a full index rebuild.
   */
  private reconcile(folder: FolderRow, walked: WalkedEntry[], started: number): IndexResult {
    const { db } = this.deps;

    const existing = new Map<string, ExistingRow>();
    for (const row of db
      .prepare('SELECT id, rel_path, size, mtime, is_dir FROM files WHERE folder_id = ?')
      .iterate(folder.id) as Iterable<ExistingRow & { rel_path: string }>) {
      existing.set(row.rel_path, row);
    }

    const insert = db.prepare(
      `INSERT INTO files
         (id, folder_id, rel_path, parent_path, name, is_dir, size, mtime, ext,
          media_kind, printable, browser_playable, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE files
          SET parent_path = ?, name = ?, is_dir = ?, size = ?, mtime = ?, ext = ?,
              media_kind = ?, printable = ?, browser_playable = ?, indexed_at = ?
        WHERE id = ?`,
    );
    const remove = db.prepare('DELETE FROM files WHERE id = ?');

    let inserted = 0;
    let updated = 0;
    let fileCount = 0;
    let totalBytes = 0;

    const apply = db.transaction(() => {
      for (const entry of walked) {
        if (!entry.isDir) {
          fileCount += 1;
          totalBytes += entry.size ?? 0;
        }

        const id = fileIdFor(folder.id, entry.relPath);
        const prior = existing.get(entry.relPath);
        existing.delete(entry.relPath);

        if (
          prior &&
          prior.is_dir === (entry.isDir ? 1 : 0) &&
          prior.size === entry.size &&
          prior.mtime === entry.mtime
        ) {
          continue;
        }

        const d = entry.isDir ? null : describe(entry.name);
        const ext = entry.isDir ? null : (path.extname(entry.name).slice(1).toLowerCase() || null);
        const isDir = entry.isDir ? 1 : 0;
        const kind = d ? d.kind : 'other';
        const printable = d?.printable ? 1 : 0;
        const playable = d?.browserPlayable ? 1 : 0;

        if (prior) {
          update.run(
            entry.parentPath,
            entry.name,
            isDir,
            entry.size,
            entry.mtime,
            ext,
            kind,
            printable,
            playable,
            started,
            id,
          );
          updated += 1;
        } else {
          insert.run(
            id,
            folder.id,
            entry.relPath,
            entry.parentPath,
            entry.name,
            isDir,
            entry.size,
            entry.mtime,
            ext,
            kind,
            printable,
            playable,
            started,
          );
          inserted += 1;
        }
      }

      // Whatever is left in `existing` was not seen on disk this pass.
      for (const row of existing.values()) remove.run(row.id);

      db.prepare(
        `UPDATE shared_folders
            SET available = 1, last_indexed_at = ?, file_count = ?, total_bytes = ?
          WHERE id = ?`,
      ).run(started, fileCount, totalBytes, folder.id);
    });
    apply();

    return {
      folderId: folder.id,
      available: true,
      fileCount,
      totalBytes,
      inserted,
      updated,
      removed: existing.size,
      durationMs: Date.now() - started,
    };
  }
}

async function mtimeOf(abs: string): Promise<number | null> {
  try {
    const stat = await fs.stat(abs);
    return Math.floor(stat.mtimeMs);
  } catch {
    return null;
  }
}
