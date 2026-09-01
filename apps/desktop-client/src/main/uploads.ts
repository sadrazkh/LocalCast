import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ErrorCode } from '@localcast/contract';
import { LocalCastError } from '@localcast/client-core';
import type { ApiClient, Clock, Logger } from '@localcast/client-core';
import type { UploadJob } from '../shared/ipc.js';

/**
 * Pushing a file from this machine into a writable folder on somebody else's server.
 *
 * The protocol is `client-core`'s: `createUpload` opens a session, `patchUpload` appends one
 * chunk at an explicit offset, and the server rejects a replayed chunk with
 * `upload_offset_mismatch` rather than appending it twice. None of that is re-derived here —
 * this class only reads the file off the disk in chunk-sized bites so a 6 GB video is never
 * resident in memory, and keeps a row the UI can show.
 */

export interface UploadTargets {
  api(serverId: string): ApiClient;
}

export interface UploadManagerOptions {
  targets: UploadTargets;
  clock: Clock;
  logger?: Logger;
}

interface Running {
  controller: AbortController;
  cancelled: boolean;
}

export interface StartUploadInput {
  serverId: string;
  folderId: string;
  sourcePaths: string[];
}

export class UploadManager {
  readonly #targets: UploadTargets;
  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  readonly #jobs = new Map<string, UploadJob>();
  readonly #running = new Map<string, Running>();
  readonly #listeners = new Set<(jobs: UploadJob[]) => void>();
  #sequence = 0;

  constructor(options: UploadManagerOptions) {
    this.#targets = options.targets;
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  onChange(handler: (jobs: UploadJob[]) => void): () => void {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  list(): UploadJob[] {
    return [...this.#jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async start(input: StartUploadInput): Promise<UploadJob[]> {
    const created: UploadJob[] = [];
    for (const sourcePath of input.sourcePaths) {
      let totalBytes = 0;
      let readable = true;
      try {
        totalBytes = (await stat(sourcePath)).size;
      } catch {
        // A file that vanished between the picker closing and this call is reported as a
        // failed row rather than silently skipped, so the count the user sees still matches.
        // It fails *here*, before any request: opening an upload session on somebody else's
        // server for a file this machine cannot read would leave a stranded session there
        // and then report it as "the server did not accept the whole file", which blames the
        // wrong end.
        readable = false;
      }
      this.#sequence += 1;
      const job: UploadJob = {
        id: `up-${this.#clock.now().toString(36)}-${this.#sequence}`,
        serverId: input.serverId,
        folderId: input.folderId,
        // POSIX-separated and relative: the server rejects anything that escapes the root,
        // and a Windows backslash would not survive that check.
        relativePath: basename(sourcePath).replace(/\\/g, '/'),
        sourcePath,
        sentBytes: 0,
        totalBytes,
        status: readable ? 'queued' : 'error',
        errorCode: readable ? null : ErrorCode.NOT_FOUND,
        errorMessage: readable ? null : 'this file could not be read from this machine',
        createdAt: this.#clock.now(),
        finishedAt: readable ? null : this.#clock.now(),
      };
      this.#jobs.set(job.id, job);
      created.push(job);
    }
    this.#emit();
    for (const job of created) {
      if (job.status === 'queued') void this.#run(job.id);
    }
    return created;
  }

  cancel(jobId: string): void {
    const running = this.#running.get(jobId);
    if (running !== undefined) {
      running.cancelled = true;
      running.controller.abort();
      return;
    }
    if (!this.#jobs.has(jobId)) return;
    this.#update(jobId, { status: 'cancelled', finishedAt: this.#clock.now() });
  }

  async stopAll(): Promise<void> {
    for (const running of this.#running.values()) {
      running.cancelled = true;
      running.controller.abort();
    }
  }

  async #run(jobId: string): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return;
    const running: Running = { controller: new AbortController(), cancelled: false };
    this.#running.set(jobId, running);
    this.#update(jobId, { status: 'uploading' });

    try {
      await this.#send(jobId, running);
    } catch (error) {
      if (running.cancelled) {
        this.#update(jobId, { status: 'cancelled', finishedAt: this.#clock.now() });
      } else {
        const code = error instanceof LocalCastError ? error.code : ErrorCode.INTERNAL;
        this.#logger?.log('warn', 'upload failed', { jobId, code });
        this.#update(jobId, {
          status: 'error',
          errorCode: code,
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: this.#clock.now(),
        });
      }
    } finally {
      this.#running.delete(jobId);
    }
  }

  async #send(jobId: string, running: Running): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return;
    const api = this.#targets.api(job.serverId);
    const signal = running.controller.signal;

    let session = await api.createUpload(
      {
        folderId: job.folderId,
        relativePath: job.relativePath,
        totalBytes: job.totalBytes,
        mtime: this.#clock.now(),
      },
      { signal },
    );

    const handle = await open(job.sourcePath, 'r');
    try {
      // The server names the chunk size; honouring it is what keeps a PATCH inside whatever
      // body limit sits in front of it.
      const buffer = new Uint8Array(session.chunkSize);
      // Resume from the server's own count, not from ours: it is the only party that knows
      // how much of a retried chunk actually landed.
      while (session.receivedBytes < job.totalBytes && session.status === 'active') {
        if (signal.aborted) throw new LocalCastError(ErrorCode.INTERNAL, 'cancelled');
        const offset = session.receivedBytes;
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) break;
        const next = await api.patchUpload(session.id, offset, buffer.subarray(0, bytesRead), {
          signal,
        });
        // A PATCH the server accepted but did not count leaves the offset exactly where it
        // was, and the loop condition is written in terms of that offset — so without this
        // the next iteration re-reads the same bytes and sends them again, for ever, at the
        // speed of the link. Stopping is the only honest answer: the server is not applying
        // what it is being sent.
        if (next.receivedBytes <= offset) {
          throw new LocalCastError(
            ErrorCode.UPLOAD_OFFSET_MISMATCH,
            'the server did not move past this chunk',
            { detail: { offset, received: next.receivedBytes } },
          );
        }
        session = next;
        this.#update(jobId, { sentBytes: session.receivedBytes });
      }
    } finally {
      await handle.close();
    }

    if (session.status !== 'complete') {
      throw new LocalCastError(
        ErrorCode.INTERNAL,
        'the server did not accept the whole file',
        { detail: { received: session.receivedBytes, total: job.totalBytes } },
      );
    }
    this.#update(jobId, {
      status: 'done',
      sentBytes: session.receivedBytes,
      finishedAt: this.#clock.now(),
    });
  }

  #update(jobId: string, patch: Partial<UploadJob>): UploadJob {
    const current = this.#jobs.get(jobId);
    if (current === undefined) throw new Error(`no upload is queued under «${jobId}»`);
    const next = { ...current, ...patch };
    this.#jobs.set(jobId, next);
    this.#emit();
    return next;
  }

  #emit(): void {
    const snapshot = this.list();
    for (const listener of this.#listeners) listener(snapshot);
  }
}
