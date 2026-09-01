import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { ErrorCode } from '@localcast/contract';
import type { MediaKind } from '@localcast/contract';
import { errorFromResponse, isCancelled, LocalCastError } from '@localcast/client-core';
import type { Clock, Logger } from '@localcast/client-core';
import type { DownloadJob } from '../shared/ipc.js';
import type { OpenedResponse } from './transport.js';

/**
 * The transfer queue behind screen 06.
 *
 * It runs in the main process and writes with `fs`, so the bytes of an 18 GB film never touch
 * the renderer, never cross the context bridge and are never held in memory. The renderer
 * sees progress numbers and nothing else.
 *
 * The interesting behaviour is resumption, and the rule it follows is worth stating plainly:
 *
 *   **the bytes on disk are the resume point, not the recorded offset.**
 *
 * `receivedBytes` in `downloads.json` is a display value written periodically; the partial
 * file is the thing that actually exists. After a crash the file may hold more than the last
 * record admits (the OS flushed writes we never got to record) or fewer (the record was
 * written and the flush was lost). Re-`stat`ing and asking for `bytes=<size>-` is correct in
 * both directions, and it is the same discipline the server applies to its own file index.
 */

/** How the queue reaches a server. Both come straight from that server's `client-core` client. */
export interface DownloadTargets {
  /** Bearer headers, refreshed through `client-core`'s single-flight gate. */
  authorize(serverId: string): Promise<Record<string, string>>;
  /** `ApiClient.contentUrl(fileId, { download: true })` for that server. */
  contentUrl(serverId: string, fileId: string): string;
}

export interface RangeTransport {
  open(request: {
    url: string;
    method: 'GET';
    headers: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<OpenedResponse>;
}

export interface DownloadManagerOptions {
  transport: RangeTransport;
  targets: DownloadTargets;
  /** Where finished files land. Shown in the UI so it is never a mystery. */
  downloadDir: string;
  statePath: string;
  clock: Clock;
  logger?: Logger;
  /** Two at a time: more saturates a home uplink and makes every transfer look stuck. */
  concurrency?: number;
}

export interface EnqueueInput {
  serverId: string;
  fileId: string;
  fileName: string;
  kind: MediaKind;
  /** From the entry listing, when known. Corrected from the response headers either way. */
  totalBytes?: number | null;
}

/** Suffix for the partial file. Distinctive so a stray `.part` from a browser is not ours. */
export const PART_SUFFIX = '.lcpart';

/** Progress is persisted and broadcast at most this often; a 4K file writes constantly. */
const PROGRESS_INTERVAL_MS = 400;

interface Running {
  controller: AbortController;
  /** Set when the user pressed pause, so the abort is not reported as a failure. */
  paused: boolean;
  cancelled: boolean;
}

export class DownloadManager {
  readonly #transport: RangeTransport;
  readonly #targets: DownloadTargets;
  readonly #downloadDir: string;
  readonly #statePath: string;
  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  readonly #concurrency: number;

  readonly #jobs = new Map<string, DownloadJob>();
  readonly #running = new Map<string, Running>();
  readonly #listeners = new Set<(jobs: DownloadJob[]) => void>();
  #queue: string[] = [];
  #saving: Promise<void> = Promise.resolve();
  #sequence = 0;

  constructor(options: DownloadManagerOptions) {
    this.#transport = options.transport;
    this.#targets = options.targets;
    this.#downloadDir = options.downloadDir;
    this.#statePath = options.statePath;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#concurrency = options.concurrency ?? 2;
  }

  /**
   * Read the queue back from disk. Anything that was mid-flight when the app closed comes
   * back as `paused`, not as `downloading`: nothing is running, and a row that claims to be
   * moving while no bytes arrive is worse than one that asks to be resumed.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#statePath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { jobs?: DownloadJob[] };
      for (const job of parsed.jobs ?? []) {
        if (typeof job?.id !== 'string') continue;
        const restored: DownloadJob = {
          ...job,
          status: job.status === 'downloading' || job.status === 'queued' ? 'paused' : job.status,
          receivedBytes: bytesOnDisk(partPathFor(job.destination)),
        };
        this.#jobs.set(restored.id, restored);
      }
    } catch {
      // A corrupt queue file costs the user their transfer list, not the app's ability to
      // start. The partial files are still on disk and can be started again.
      this.#logger?.log('warn', 'the download queue file could not be read');
    }
  }

  onChange(handler: (jobs: DownloadJob[]) => void): () => void {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  list(): DownloadJob[] {
    return [...this.#jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(jobId: string): DownloadJob | null {
    return this.#jobs.get(jobId) ?? null;
  }

  enqueue(input: EnqueueInput): DownloadJob {
    this.#sequence += 1;
    const job: DownloadJob = {
      id: `dl-${this.#clock.now().toString(36)}-${this.#sequence}`,
      serverId: input.serverId,
      fileId: input.fileId,
      fileName: input.fileName,
      kind: input.kind,
      destination: this.#destinationFor(input.fileName),
      receivedBytes: 0,
      totalBytes: input.totalBytes ?? null,
      status: 'queued',
      errorCode: null,
      errorMessage: null,
      createdAt: this.#clock.now(),
      finishedAt: null,
    };
    this.#jobs.set(job.id, job);
    this.#queue.push(job.id);
    this.#emit();
    void this.#pump();
    return job;
  }

  pause(jobId: string): void {
    const running = this.#running.get(jobId);
    if (running !== undefined) {
      running.paused = true;
      running.controller.abort();
      return;
    }
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.status !== 'queued') return;
    this.#queue = this.#queue.filter((id) => id !== jobId);
    this.#update(job.id, { status: 'paused' });
  }

  resume(jobId: string): DownloadJob {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new UnknownDownload(jobId);
    if (job.status === 'downloading' || job.status === 'queued') return job;
    // Re-`stat` before re-queuing so the row shows the truth immediately, not the number the
    // record happened to hold when the app was last closed.
    const updated = this.#update(job.id, {
      status: 'queued',
      errorCode: null,
      errorMessage: null,
      receivedBytes: bytesOnDisk(partPathFor(job.destination)),
    });
    this.#queue.push(job.id);
    void this.#pump();
    return updated;
  }

  cancel(jobId: string): void {
    const running = this.#running.get(jobId);
    if (running !== undefined) {
      running.cancelled = true;
      running.controller.abort();
      return;
    }
    const job = this.#jobs.get(jobId);
    if (job === undefined) return;
    this.#queue = this.#queue.filter((id) => id !== jobId);
    rmSync(partPathFor(job.destination), { force: true });
    this.#update(job.id, { status: 'cancelled', receivedBytes: 0, finishedAt: this.#clock.now() });
  }

  async stopAll(): Promise<void> {
    for (const running of this.#running.values()) {
      running.paused = true;
      running.controller.abort();
    }
    await this.#saving;
  }

  // ─── the transfer itself ────────────────────────────────────────────────────

  async #pump(): Promise<void> {
    while (this.#running.size < this.#concurrency) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      const job = this.#jobs.get(next);
      if (job === undefined || job.status !== 'queued') continue;
      void this.#run(job.id);
    }
  }

  async #run(jobId: string): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return;

    const running: Running = { controller: new AbortController(), paused: false, cancelled: false };
    this.#running.set(jobId, running);
    this.#update(jobId, { status: 'downloading', errorCode: null, errorMessage: null });

    try {
      await this.#transfer(jobId, running);
    } catch (error) {
      if (running.cancelled) {
        rmSync(partPathFor(job.destination), { force: true });
        this.#update(jobId, {
          status: 'cancelled',
          receivedBytes: 0,
          finishedAt: this.#clock.now(),
        });
      } else if (running.paused || isCancelled(error)) {
        this.#update(jobId, {
          status: 'paused',
          receivedBytes: bytesOnDisk(partPathFor(job.destination)),
        });
      } else {
        const code = error instanceof LocalCastError ? error.code : ErrorCode.INTERNAL;
        this.#logger?.log('warn', 'download failed', { jobId, code });
        this.#update(jobId, {
          status: 'error',
          errorCode: code,
          errorMessage: error instanceof Error ? error.message : String(error),
          receivedBytes: bytesOnDisk(partPathFor(job.destination)),
          finishedAt: this.#clock.now(),
        });
      }
    } finally {
      this.#running.delete(jobId);
      void this.#pump();
    }
  }

  async #transfer(jobId: string, running: Running): Promise<void> {
    const start = this.#jobs.get(jobId);
    if (start === undefined) return;

    const partPath = partPathFor(start.destination);
    mkdirSync(dirname(partPath), { recursive: true });

    let offset = bytesOnDisk(partPath);
    const auth = await this.#targets.authorize(start.serverId);
    const headers: Record<string, string> = { ...auth, accept: '*/*' };
    // `bytes=<offset>-` is the open-ended form the spec's Range section names first; asking
    // for an explicit end would require knowing the size, which on a resume we may not.
    if (offset > 0) headers.range = `bytes=${offset}-`;

    const response = await this.#transport.open({
      url: this.#targets.contentUrl(start.serverId, start.fileId),
      method: 'GET',
      headers,
      signal: running.controller.signal,
    });

    if (response.status === 416) {
      // The file on disk is already at or past the end. If it is exactly the right size the
      // transfer is simply finished; otherwise the file changed underneath us and the only
      // honest move is to start again.
      const total = totalFromContentRange(response.headers['content-range']);
      if (total !== null && offset === total) {
        this.#finish(jobId, partPath, total);
        return;
      }
      rmSync(partPath, { force: true });
      throw new LocalCastError(
        ErrorCode.RANGE_NOT_SATISFIABLE,
        'the file on the server no longer matches the partial copy on this machine',
        { status: 416 },
      );
    }

    if (response.status !== 200 && response.status !== 206) {
      const body = response.body === null ? '' : await readAllText(response.body);
      throw errorFromResponse(
        { status: response.status, headers: response.headers, body },
        'GET /files/:id/content',
      );
    }

    // A 200 in answer to a Range request means the server served the whole file: the partial
    // copy is not a prefix of what is arriving, so keeping it would corrupt the result.
    if (response.status === 200 && offset > 0) {
      rmSync(partPath, { force: true });
      offset = 0;
      this.#update(jobId, { receivedBytes: 0 });
    }

    const total = sizeFromHeaders(response.headers, offset);
    if (total !== null) this.#update(jobId, { totalBytes: total });

    if (response.body === null) {
      throw new LocalCastError(ErrorCode.INTERNAL, 'the server sent no body for this file');
    }

    const sink = createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' });
    let written = offset;
    let lastReport = 0;

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        await writeChunk(sink, value);
        written += value.byteLength;
        const now = this.#clock.now();
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now;
          this.#update(jobId, { receivedBytes: written });
        }
      }
    } finally {
      await closeStream(sink);
    }

    // A stream that ended early is not a finished download. Saying so — rather than renaming
    // a truncated file into place — is what stops a half-copied film from looking correct in
    // Explorer and failing three days later when someone tries to play it.
    if (total !== null && written < total) {
      this.#update(jobId, { receivedBytes: written });
      throw new LocalCastError(
        ErrorCode.INTERNAL,
        'the connection ended before the whole file arrived',
      );
    }

    this.#finish(jobId, partPath, total ?? written);
  }

  #finish(jobId: string, partPath: string, size: number): void {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return;
    renameSync(partPath, job.destination);
    this.#update(jobId, {
      status: 'done',
      receivedBytes: size,
      totalBytes: size,
      finishedAt: this.#clock.now(),
    });
  }

  // ─── bookkeeping ────────────────────────────────────────────────────────────

  #destinationFor(fileName: string): string {
    const safe = basename(fileName).replace(/[\\/:*?"<>|]/g, '_') || 'download';
    let candidate = join(this.#downloadDir, safe);
    if (!existsSync(candidate) && !existsSync(`${candidate}${PART_SUFFIX}`)) return candidate;

    // Never overwrite: the user asked to fetch a copy, not to replace whatever is already
    // sitting in their downloads folder under the same name.
    const ext = extname(safe);
    const stem = ext.length > 0 ? safe.slice(0, -ext.length) : safe;
    for (let n = 2; n < 1000; n += 1) {
      candidate = join(this.#downloadDir, `${stem} (${n})${ext}`);
      if (!existsSync(candidate) && !existsSync(`${candidate}${PART_SUFFIX}`)) return candidate;
    }
    return join(this.#downloadDir, `${stem} (${Date.now()})${ext}`);
  }

  #update(jobId: string, patch: Partial<DownloadJob>): DownloadJob {
    const current = this.#jobs.get(jobId);
    if (current === undefined) throw new UnknownDownload(jobId);
    const next = { ...current, ...patch };
    this.#jobs.set(jobId, next);
    this.#emit();
    this.#persist();
    return next;
  }

  #emit(): void {
    const snapshot = this.list();
    for (const listener of this.#listeners) listener(snapshot);
  }

  /** Serialised so two rapid progress ticks cannot interleave two writes of the same file. */
  #persist(): void {
    this.#saving = this.#saving.then(async () => {
      try {
        mkdirSync(dirname(this.#statePath), { recursive: true });
        const tmp = `${this.#statePath}.tmp`;
        await writeFile(tmp, `${JSON.stringify({ version: 1, jobs: this.list() }, null, 2)}\n`, 'utf8');
        await rename(tmp, this.#statePath);
      } catch {
        // Losing the queue file costs the resume list, not the transfer in flight.
      }
    });
  }
}

export class UnknownDownload extends Error {
  constructor(readonly jobId: string) {
    super(`no download is queued under «${jobId}»`);
    this.name = 'UnknownDownload';
  }
}

export function partPathFor(destination: string): string {
  return `${destination}${PART_SUFFIX}`;
}

function bytesOnDisk(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Reads the total size off a Content-Range: `bytes 100-199/1234` gives 1234, and so does
// the unsatisfiable form the server sends with a 416, whose range part is a bare asterisk.
// (Spelled out rather than shown, because the literal token would close this comment.)
function totalFromContentRange(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /\/(\d+)\s*$/.exec(value);
  if (match?.[1] === undefined) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

function sizeFromHeaders(headers: Record<string, string>, offset: number): number | null {
  const fromRange = totalFromContentRange(headers['content-range']);
  if (fromRange !== null) return fromRange;
  const length = headers['content-length'];
  if (length === undefined) return null;
  const parsed = Number(length);
  // `Content-Length` on a 206 describes the slice, not the file, so the offset is added back.
  return Number.isFinite(parsed) ? parsed + offset : null;
}

function writeChunk(sink: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function closeStream(sink: WriteStream): Promise<void> {
  return new Promise((resolve) => sink.end(() => resolve()));
}

async function readAllText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) text += decoder.decode(value, { stream: true });
  }
  return text;
}
