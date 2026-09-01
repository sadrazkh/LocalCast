import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, utimes } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import { ApiException, ErrorCode } from '@localcast/contract';
import type { UploadSession } from '@localcast/contract';
import type { ServerContext } from '../../kernel.js';
import { reserveFreeName, sanitizeRelativePath } from './paths.js';

/**
 * Resumable chunked upload — surface 4.
 *
 * The phone is not a server and cannot be one: iOS suspends a PWA when the screen locks, and
 * Safari has no File System Access API to hold the camera roll open. So sharing from the
 * phone is a push, and a push over a phone's network has to survive the screen locking, the
 * app being backgrounded and a walk out of Wi-Fi range. That is what makes the offset
 * protocol here load-bearing rather than decoration: a 900 MB video that has to restart from
 * zero after a dropped connection never finishes at all.
 */

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** One event per session per this interval; a 4 GB upload otherwise floods the SSE stream. */
export const PROGRESS_INTERVAL_MS = 500;
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

export interface UploadRow {
  id: string;
  device_id: string;
  folder_id: string;
  rel_path: string;
  total_bytes: number;
  received_bytes: number;
  chunk_size: number;
  temp_path: string;
  status: 'active' | 'complete' | 'aborted';
  created_at: number;
  updated_at: number;
}

export interface UploadServiceOptions {
  chunkSize?: number;
  /** Refused above this. Defaults to 64 GiB — a limit, not a promise of free disk. */
  maxBytes?: number;
  progressIntervalMs?: number;
  now?: () => number;
}

export interface CreateInput {
  deviceId: string;
  folderId: string;
  relativePath: string;
  totalBytes: number;
  mtime?: number | undefined;
}

export class UploadService {
  private readonly chunkSize: number;
  private readonly maxBytes: number;
  private readonly progressIntervalMs: number;
  private readonly now: () => number;
  private readonly lastPublishedAt = new Map<string, number>();
  /**
   * The client-declared original mtime. Deliberately not a column: `uploads` is fixed by
   * migration 001, which the core owns, and a nicety that only matters within one process
   * run is not worth a schema change every existing install has to carry.
   */
  private readonly pendingMtime = new Map<string, number>();

  constructor(
    private readonly ctx: ServerContext,
    options: UploadServiceOptions = {},
  ) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024 * 1024;
    this.progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async create(input: CreateInput): Promise<UploadSession> {
    if (input.totalBytes > this.maxBytes) {
      throw new ApiException(ErrorCode.UPLOAD_TOO_LARGE, 'That file is larger than this server accepts.', {
        maxBytes: this.maxBytes,
      });
    }

    const relPath = sanitizeRelativePath(input.relativePath);
    this.ctx.permissions.assertCan(input.deviceId, input.folderId, 'upload');
    // Resolved now as well as at completion, so an upload into a folder that is not writable
    // fails in the first request rather than after the phone has pushed a gigabyte.
    await this.ctx.files.resolveWritable(input.folderId, relPath);

    const id = randomUUID();
    const tempPath = join(this.ctx.paths.tempDir, `upload-${id}.part`);
    await mkdir(this.ctx.paths.tempDir, { recursive: true });
    const handle = await open(tempPath, 'w');
    await handle.close();

    const at = this.now();
    this.ctx.db
      .prepare(
        `INSERT INTO uploads
           (id, device_id, folder_id, rel_path, total_bytes, received_bytes, chunk_size,
            temp_path, status, created_at, updated_at)
         VALUES (@id, @deviceId, @folderId, @relPath, @totalBytes, 0, @chunkSize,
            @tempPath, 'active', @at, @at)`,
      )
      .run({
        id,
        deviceId: input.deviceId,
        folderId: input.folderId,
        relPath,
        totalBytes: input.totalBytes,
        chunkSize: this.chunkSize,
        tempPath,
        at,
      });

    if (input.mtime !== undefined) this.pendingMtime.set(id, input.mtime);
    this.ctx.activity.record('upload.started', input.deviceId, {
      uploadId: id,
      folderId: input.folderId,
      path: relPath,
      totalBytes: input.totalBytes,
    });

    // An empty file has nothing to PATCH, so it is finished the moment it is created.
    if (input.totalBytes === 0) return this.finalize(this.require(id, input.deviceId));

    const row = this.require(id, input.deviceId);
    this.publish(row, true);
    return toDto(row);
  }

  /**
   * Appends `body` at `offset`.
   *
   * A mismatched offset is answered with the server's real `receivedBytes`, which is the
   * whole point of the protocol: a client that lost its connection mid-chunk does not know
   * how much of it landed, and being told exactly where to continue is the difference
   * between resuming and starting over.
   */
  async append(
    uploadId: string,
    deviceId: string,
    offset: number,
    body: Readable,
    declaredBytes?: number | null,
  ): Promise<UploadSession> {
    const row = this.require(uploadId, deviceId);
    if (row.status !== 'active') {
      throw new ApiException(
        ErrorCode.UPLOAD_SESSION_UNKNOWN,
        `This upload is already ${row.status}.`,
      );
    }
    if (offset !== row.received_bytes) {
      throw new ApiException(
        ErrorCode.UPLOAD_OFFSET_MISMATCH,
        'That offset is not where this upload currently stands.',
        { receivedBytes: row.received_bytes, totalBytes: row.total_bytes },
      );
    }
    // Checked from Content-Length before a byte is read, so an over-long chunk is refused
    // without the client having to push it first.
    if (declaredBytes !== null && declaredBytes !== undefined && offset + declaredBytes > row.total_bytes) {
      throw new ApiException(
        ErrorCode.UPLOAD_TOO_LARGE,
        'This chunk would take the upload past the size it declared.',
        { receivedBytes: row.received_bytes, totalBytes: row.total_bytes },
      );
    }

    let received = row.received_bytes;
    let overflow = false;
    const handle = await open(row.temp_path, 'r+');
    try {
      for await (const chunk of body) {
        const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (buffer.length === 0) continue;
        if (overflow || received + buffer.length > row.total_bytes) {
          // Discard the rest rather than breaking out. Abandoning a half-read request body
          // makes Node tear the socket down, and the client never receives the 413 that
          // would tell it what it did wrong.
          overflow = true;
          continue;
        }
        await handle.write(buffer, 0, buffer.length, received);
        received += buffer.length;
        this.maybePublishProgress(row, received);
      }
    } finally {
      await handle.close();
      // Always persisted, including when the loop threw because the phone went out of range.
      // The bytes are on disk; forgetting how many would throw away work already done.
      if (received !== row.received_bytes) this.persistReceived(uploadId, received);
    }

    if (overflow) {
      throw new ApiException(
        ErrorCode.UPLOAD_TOO_LARGE,
        'This chunk would take the upload past the size it declared.',
        { receivedBytes: received, totalBytes: row.total_bytes },
      );
    }

    const updated = this.require(uploadId, deviceId);
    if (updated.received_bytes >= updated.total_bytes) return this.finalize(updated);

    this.publish(updated, true);
    return toDto(updated);
  }

  get(uploadId: string, deviceId: string): UploadSession {
    return toDto(this.require(uploadId, deviceId));
  }

  async abort(uploadId: string, deviceId: string): Promise<UploadSession> {
    const row = this.require(uploadId, deviceId);
    if (row.status === 'complete') {
      throw new ApiException(ErrorCode.BAD_REQUEST, 'This upload has already finished.');
    }
    await rm(row.temp_path, { force: true }).catch(() => undefined);
    this.ctx.db
      .prepare(`UPDATE uploads SET status = 'aborted', updated_at = ? WHERE id = ?`)
      .run(this.now(), uploadId);
    this.lastPublishedAt.delete(uploadId);
    this.pendingMtime.delete(uploadId);

    const updated = this.require(uploadId, deviceId);
    this.publish(updated, true);
    this.ctx.activity.record('upload.aborted', deviceId, { uploadId });
    return toDto(updated);
  }

  /**
   * Drops sessions abandoned more than a day ago.
   *
   * Without this the temp directory accumulates a partial copy of every upload a phone ever
   * gave up on — and those are whole videos, not stubs.
   */
  async sweepAbandoned(olderThanMs = ABANDONED_AFTER_MS): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    const rows = this.ctx.db
      .prepare(`SELECT id, temp_path FROM uploads WHERE status = 'active' AND updated_at < ?`)
      .all(cutoff) as { id: string; temp_path: string }[];

    for (const row of rows) {
      await rm(row.temp_path, { force: true }).catch(() => undefined);
    }
    if (rows.length > 0) {
      this.ctx.db
        .prepare(
          `UPDATE uploads SET status = 'aborted', updated_at = ?
            WHERE status = 'active' AND updated_at < ?`,
        )
        .run(this.now(), cutoff);
      this.ctx.log.info('swept abandoned uploads', { count: rows.length });
    }
    return rows.length;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async finalize(row: UploadRow): Promise<UploadSession> {
    // Re-resolved rather than remembered: the operator may have made the folder read-only
    // while the phone was uploading, and the answer that matters is the one that holds now.
    const destination = await this.ctx.files.resolveWritable(row.folder_id, row.rel_path);
    await mkdir(dirname(destination), { recursive: true });

    // Never overwrite. A phone's camera roll is full of `IMG_0001.JPG`, and the second one
    // landing on top of the first destroys a file nobody asked to replace.
    const finalPath = await reserveFreeName(destination);

    try {
      // Rename, not copy: the bytes become visible under their real name in one step, so no
      // other device ever sees a half-written file appear in the library.
      await rename(row.temp_path, finalPath);
    } catch (err) {
      // The reservation is an empty file; leaving it behind would be litter that also
      // occupies the name the client will retry with.
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw err;
    }

    const mtime = this.pendingMtime.get(row.id);
    if (mtime !== undefined) {
      const when = new Date(mtime);
      await utimes(finalPath, when, when).catch(() => undefined);
    }
    this.pendingMtime.delete(row.id);

    const finalRel = posix.join(posix.dirname(row.rel_path), basenameOf(finalPath));
    this.ctx.db
      .prepare(
        `UPDATE uploads
            SET status = 'complete', rel_path = ?, received_bytes = total_bytes, updated_at = ?
          WHERE id = ?`,
      )
      .run(normalizeRel(finalRel), this.now(), row.id);
    this.lastPublishedAt.delete(row.id);

    const updated = this.rowById(row.id);
    this.publish(updated, true);
    this.ctx.activity.record('upload.completed', row.device_id, {
      uploadId: row.id,
      folderId: row.folder_id,
      path: updated.rel_path,
      bytes: updated.total_bytes,
    });
    return toDto(updated);
  }

  private persistReceived(uploadId: string, received: number): void {
    this.ctx.db
      .prepare(`UPDATE uploads SET received_bytes = ?, updated_at = ? WHERE id = ?`)
      .run(received, this.now(), uploadId);
  }

  private maybePublishProgress(row: UploadRow, received: number): void {
    const last = this.lastPublishedAt.get(row.id) ?? 0;
    const at = this.now();
    if (at - last < this.progressIntervalMs) return;
    this.lastPublishedAt.set(row.id, at);
    this.ctx.events.publish({
      type: 'upload',
      uploadId: row.id,
      receivedBytes: received,
      totalBytes: row.total_bytes,
      status: 'active',
    });
  }

  private publish(row: UploadRow, force: boolean): void {
    if (!force) return;
    this.lastPublishedAt.set(row.id, this.now());
    this.ctx.events.publish({
      type: 'upload',
      uploadId: row.id,
      receivedBytes: row.received_bytes,
      totalBytes: row.total_bytes,
      status: row.status,
    });
  }

  /**
   * Another device's session is reported as unknown rather than forbidden — the id space
   * must not be walkable to learn what other people are uploading.
   */
  private require(uploadId: string, deviceId: string): UploadRow {
    const row = this.ctx.db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(uploadId) as
      | UploadRow
      | undefined;
    if (!row || row.device_id !== deviceId) {
      throw new ApiException(ErrorCode.UPLOAD_SESSION_UNKNOWN, 'No such upload session.');
    }
    return row;
  }

  private rowById(uploadId: string): UploadRow {
    const row = this.ctx.db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(uploadId) as
      | UploadRow
      | undefined;
    if (!row) throw new ApiException(ErrorCode.UPLOAD_SESSION_UNKNOWN, 'No such upload session.');
    return row;
  }
}

export function toDto(row: UploadRow): UploadSession {
  return {
    id: row.id,
    receivedBytes: row.received_bytes,
    totalBytes: row.total_bytes,
    chunkSize: row.chunk_size,
    status: row.status,
  };
}

/** `path.basename` on a Windows path, without importing the platform-specific variant. */
function basenameOf(absPath: string): string {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? absPath;
}

function normalizeRel(relPath: string): string {
  return relPath.startsWith('./') ? relPath.slice(2) : relPath;
}
