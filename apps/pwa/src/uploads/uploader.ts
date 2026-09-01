import { ErrorCode } from '@localcast/contract';
import type { UploadSession } from '@localcast/contract';
import { LocalCastError, NetworkError, backoffDelay, systemSleep } from '@localcast/client-core';
import type { ApiClient, Sleep } from '@localcast/client-core';

/**
 * Read through a function so the compiler cannot carry a narrowing across an `await`.
 *
 * `signal.aborted` is a live external flag: an inline `signal?.aborted === true` at the top
 * of the loop narrows it to `false` for the rest of the body, and TypeScript keeps that
 * belief through every subsequent await even though the user may have cancelled in between.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/**
 * Surface 4: the phone pushes, it does not host.
 *
 * The mockup's screen 12 draws the phone serving on `192.168.1.31:8420`. It cannot: iOS gives
 * a web app no listening socket, no persistent access to the camera roll, and suspends it
 * when the screen locks. So this is an upload, and the only question that matters is what
 * happens when it is interrupted — which on a phone is *every* upload of any size, because a
 * lock screen, a lift, or a switch from wifi to cellular all cut it.
 *
 * The rule the whole file turns on: **the server decides the offset.** After any failure the
 * session is re-read and the next chunk starts wherever the server says it got to. A client
 * that resumed from its own count of bytes sent would double-write the chunk that was in
 * flight when the connection dropped, and a 4 MB duplicate in the middle of a video is a
 * corrupted file nobody ever saw an error about — which is why the server rejects a
 * mismatched offset outright rather than appending.
 */

export interface UploadProgress {
  uploadId: string;
  sent: number;
  total: number;
  status: UploadSession['status'];
}

/**
 * Structural rather than `File`, so the retry logic can be exercised without a browser file
 * picker. A real `File` satisfies it.
 */
export interface UploadSource {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface UploadOptions {
  api: ApiClient;
  file: UploadSource;
  folderId: string;
  /** POSIX-separated and relative; the server rejects anything that escapes the folder root. */
  relativePath: string;
  mtime?: number;
  /** Resume an existing session instead of creating one. */
  uploadId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  /** Attempts per chunk before giving up. Four covers a lift; forty covers nothing extra. */
  maxAttempts?: number;
  sleep?: Sleep;
  random?: () => number;
}

const RETRY_BACKOFF = { baseMs: 500, factor: 2, capMs: 8_000, jitter: 0.3 };

export async function uploadFile(options: UploadOptions): Promise<UploadSession> {
  const {
    api,
    file,
    folderId,
    relativePath,
    mtime,
    signal,
    onProgress,
    maxAttempts = 4,
    sleep = systemSleep,
    random = Math.random,
  } = options;

  let session =
    options.uploadId === undefined
      ? await api.createUpload(
          {
            folderId,
            relativePath,
            totalBytes: file.size,
            ...(mtime === undefined ? {} : { mtime }),
          },
          { signal },
        )
      : await api.upload(options.uploadId, { signal });

  report(onProgress, session);

  let attempt = 0;
  while (session.status === 'active' && session.receivedBytes < session.totalBytes) {
    if (isAborted(signal)) return session;

    // Always the server's number, never a local tally.
    const offset = session.receivedBytes;
    const end = Math.min(offset + session.chunkSize, session.totalBytes);
    const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());

    try {
      session = await api.patchUpload(session.id, offset, chunk, { signal });
      attempt = 0;
      report(onProgress, session);
    } catch (error) {
      if (isAborted(signal)) throw error;

      const resumable = isResumable(error);
      attempt += 1;
      if (!resumable || attempt >= maxAttempts) throw error;

      await sleep(backoffDelay(attempt - 1, RETRY_BACKOFF, random), signal);

      // The resume itself: ask the server where it got to. The chunk that was in flight may
      // have landed in full, in part, or not at all, and this is the only way to know which.
      session = await api.upload(session.id, { signal });
      report(onProgress, session);
    }
  }

  return session;
}

/**
 * Which failures are worth another attempt.
 *
 * A dropped connection, obviously. And `upload_offset_mismatch`, which is not a bug but the
 * server telling us our idea of the offset is stale — re-reading the session fixes it and the
 * next attempt writes in the right place. Everything else (`upload_not_allowed`,
 * `upload_too_large`, a revoked device) will fail identically for ever.
 */
function isResumable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof LocalCastError) {
    return error.code === ErrorCode.UPLOAD_OFFSET_MISMATCH || error.status === 503;
  }
  return false;
}

function report(onProgress: UploadOptions['onProgress'], session: UploadSession): void {
  onProgress?.({
    uploadId: session.id,
    sent: session.receivedBytes,
    total: session.totalBytes,
    status: session.status,
  });
}

/** Characters Windows will not accept in a file name, plus the two path separators. */
const RESERVED = /[<>:"|?*]/g;
const SEPARATORS = /[\\/]+/g;
const LEADING_DOTS = /^\.+/;

/**
 * A file name safe to place under a shared folder.
 *
 * The server re-validates and rejects anything that escapes the root — that is the security
 * boundary and it is not here. This exists so an iOS share sheet handing over
 * `IMG_0001 (1).HEIC` produces a sensible name rather than a rejection the user cannot act on.
 */
export function safeRelativePath(name: string, prefix = ''): string {
  const cleaned = name
    // Separators become a dash rather than vanishing, so `a/b.jpg` cannot silently collide
    // with an `ab.jpg` that is already in the folder.
    .replace(SEPARATORS, '-')
    // A leading dot hides the file on the server, and `..` starts a traversal.
    .replace(LEADING_DOTS, '')
    .replace(RESERVED, '')
    .trim();
  const base = cleaned.length === 0 ? `upload-${Date.now()}` : cleaned;
  return prefix.length === 0 ? base : `${prefix.replace(/\/+$/, '')}/${base}`;
}
