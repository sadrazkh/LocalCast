import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ApiException, ErrorCode } from '@localcast/contract';
import type { PrintJob, PrintJobStatus } from '@localcast/contract';
import type { ServerContext } from '../../kernel.js';
import type { ExecFileFn } from './exec.js';
import { defaultExecFile } from './exec.js';
import {
  buildPrintSettings,
  classifyJobStatus,
  findSumatra,
  listSpoolerJobs,
  missingSpoolerError,
  removeSpoolerJob,
  submitToSpooler,
} from './spooler.js';

/**
 * The print queue: `queued → printing → done | error | cancelled`.
 *
 * One job at a time per printer. Windows will happily accept concurrent submissions and
 * interleave them, which produces a stack of pages belonging to two documents — and the
 * "which job is mine" question becomes unanswerable, because job discovery works by
 * diffing the spooler queue before and after submission.
 */

export interface PrintJobRow {
  id: string;
  device_id: string;
  printer_id: string;
  source_kind: string;
  source_path: string | null;
  spool_path: string | null;
  file_name: string;
  copies: number;
  color: 'color' | 'mono';
  duplex: 'simplex' | 'long' | 'short';
  page_range: string | null;
  status: PrintJobStatus;
  error_message: string | null;
  windows_job_id: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface EnqueueInput {
  deviceId: string;
  printerId: string;
  printerName: string;
  sourceKind: 'library' | 'upload';
  sourcePath: string;
  fileName: string;
  copies: number;
  color: 'color' | 'mono';
  duplex: 'simplex' | 'long' | 'short';
  pageRange?: string | undefined;
}

export interface PrintQueueOptions {
  exec?: ExecFileFn;
  /** How often `Get-PrintJob` is asked whether the job is still in the queue. */
  pollIntervalMs?: number;
  /** After this, a job still sitting in the spooler is left alone and reported as an error. */
  pollTimeoutMs?: number;
  /** Attempts to spot the new spooler job id after submitting. */
  discoverAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending poll must not hold the process open while Electron is quitting.
    if (typeof timer.unref === 'function') timer.unref();
  });

export class PrintQueue {
  private readonly exec: ExecFileFn;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly discoverAttempts: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** One promise chain per printer id — this is what serialises the queue. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  private disposed = false;

  constructor(
    private readonly ctx: ServerContext,
    options: PrintQueueOptions = {},
  ) {
    this.exec = options.exec ?? defaultExecFile;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 10 * 60_000;
    this.discoverAttempts = options.discoverAttempts ?? 5;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  // ── public surface ─────────────────────────────────────────────────────────

  enqueue(input: EnqueueInput): PrintJob {
    const id = randomUUID();
    const at = this.now();
    // The spool copy lives beside the other scratch files and carries the source extension,
    // because SumatraPDF decides how to render from the extension and not from the content.
    const spoolPath = join(this.ctx.paths.tempDir, `print-${id}${extname(input.fileName)}`);

    this.ctx.db
      .prepare(
        `INSERT INTO print_jobs
           (id, device_id, printer_id, source_kind, source_path, spool_path, file_name,
            copies, color, duplex, page_range, status, created_at)
         VALUES (@id, @deviceId, @printerId, @sourceKind, @sourcePath, @spoolPath, @fileName,
            @copies, @color, @duplex, @pageRange, 'queued', @at)`,
      )
      .run({
        id,
        deviceId: input.deviceId,
        printerId: input.printerId,
        sourceKind: input.sourceKind,
        sourcePath: input.sourcePath,
        spoolPath,
        fileName: input.fileName,
        copies: input.copies,
        color: input.color,
        duplex: input.duplex,
        pageRange: input.pageRange ?? null,
        at,
      });

    const job = this.requireJob(id);
    this.publish(job);
    this.ctx.activity.record('print.queued', input.deviceId, {
      jobId: id,
      printer: input.printerName,
      fileName: input.fileName,
    });

    const previous = this.chains.get(input.printerId) ?? Promise.resolve();
    const next = previous.then(() =>
      this.run(id, input.printerName).catch((err: unknown) => {
        // `run` already records failures on the job; anything reaching here would otherwise
        // poison the chain and silently stop the printer for the rest of the session.
        this.ctx.log.error('print job crashed', { jobId: id, error: String(err) });
      }),
    );
    this.chains.set(input.printerId, next);

    return this.toDto(job);
  }

  cancel(jobId: string, deviceId: string): PrintJob {
    const row = this.findJob(jobId);
    if (!row || row.device_id !== deviceId) {
      throw new ApiException(ErrorCode.NOT_FOUND, 'No such print job.');
    }
    if (row.status === 'cancelled') return this.toDto(row);
    if (row.status === 'done' || row.status === 'error') {
      throw new ApiException(ErrorCode.BAD_REQUEST, 'This job has already finished.');
    }

    this.cancelRequested.add(jobId);

    if (row.status === 'queued') {
      // Nothing has been handed to Windows yet, so this is final immediately.
      const finished = this.finish(jobId, 'cancelled', null);
      void this.cleanupSpool(row.spool_path);
      return this.toDto(finished);
    }

    // Already printing: the poll loop asks the spooler to drop it and settles the state. The
    // caller gets the job as it stands rather than a state this method cannot yet promise.
    return this.toDto(row);
  }

  /** Resolves once every queued and printing job has settled. Used by tests and shutdown. */
  async drain(): Promise<void> {
    let chains = [...this.chains.values()];
    while (chains.length > 0) {
      await Promise.all(chains);
      const next = [...this.chains.values()];
      if (next.length === chains.length && next.every((c, i) => c === chains[i])) break;
      chains = next;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.drain();
  }

  // ── the state machine ──────────────────────────────────────────────────────

  private async run(jobId: string, printerName: string): Promise<void> {
    const row = this.findJob(jobId);
    if (!row) return;
    if (row.status !== 'queued' || this.cancelRequested.has(jobId) || this.disposed) {
      await this.cleanupSpool(row.spool_path);
      return;
    }

    const spoolPath = row.spool_path;
    if (!spoolPath || !row.source_path) {
      this.fail(jobId, 'The job lost its source file before it could be printed.');
      return;
    }

    try {
      // Copy before printing. The user is free to delete or move the original the moment
      // they have tapped print, and the spooler reads the file lazily — printing straight
      // from the share turns that into a half-printed document.
      await copyFile(row.source_path, spoolPath);
    } catch (err) {
      await this.cleanupSpool(spoolPath);
      this.fail(jobId, `Could not read the file to print: ${describe(err)}`);
      return;
    }

    const sumatra = await findSumatra(this.ctx.paths.vendorDir);
    if (!sumatra) {
      const missing = missingSpoolerError(this.ctx.paths.vendorDir);
      this.ctx.log.error('print helper missing', {
        code: missing.code,
        vendorDir: this.ctx.paths.vendorDir,
      });
      await this.cleanupSpool(spoolPath);
      this.fail(jobId, missing.message);
      return;
    }

    let settings: string;
    try {
      settings = buildPrintSettings({
        copies: row.copies,
        color: row.color,
        duplex: row.duplex,
        pageRange: row.page_range,
      });
    } catch (err) {
      await this.cleanupSpool(spoolPath);
      this.fail(jobId, describe(err));
      return;
    }

    const before = new Set((await listSpoolerJobs(this.exec, printerName)).map((job) => job.id));

    this.transition(jobId, 'printing', { started_at: this.now() });

    try {
      await submitToSpooler(this.exec, {
        sumatraPath: sumatra,
        printerName,
        settings,
        filePath: spoolPath,
      });
    } catch (err) {
      await this.cleanupSpool(spoolPath);
      this.fail(jobId, `The print helper failed: ${describe(err)}`);
      return;
    }

    const windowsJobId = await this.discoverJobId(printerName, before);
    if (windowsJobId !== null) {
      this.ctx.db
        .prepare(`UPDATE print_jobs SET windows_job_id = ? WHERE id = ?`)
        .run(windowsJobId, jobId);
    }

    const outcome = await this.watch(jobId, printerName, windowsJobId);
    // The spool copy goes before the terminal state is published, so an observer can never
    // see "the job is finished" while a full second copy of the document is still on disk.
    await this.cleanupSpool(spoolPath);
    this.finish(jobId, outcome.status, outcome.message);
  }

  /**
   * Finds the spooler job SumatraPDF just created by diffing the queue.
   *
   * SumatraPDF reports nothing about what it submitted, and there is no other handle: the
   * only way to name the job the spooler now owns is to know which ids were there before.
   */
  private async discoverJobId(printerName: string, before: Set<number>): Promise<number | null> {
    for (let attempt = 0; attempt < this.discoverAttempts; attempt += 1) {
      const jobs = await listSpoolerJobs(this.exec, printerName);
      const fresh = jobs.find((job) => !before.has(job.id));
      if (fresh) return fresh.id;
      if (attempt + 1 < this.discoverAttempts) await this.sleep(this.pollIntervalMs);
    }
    return null;
  }

  private async watch(
    jobId: string,
    printerName: string,
    windowsJobId: number | null,
  ): Promise<{ status: PrintJobStatus; message: string | null }> {
    if (windowsJobId === null) {
      // The queue never showed the job. On a fast local printer it can be spooled, rendered
      // and gone before the first poll, and the helper did exit successfully — so this is a
      // completed job, logged because it is also what a silently dropped job looks like.
      this.ctx.log.warn('print job left the spooler before it could be observed', { jobId });
      return { status: 'done', message: null };
    }

    const deadline = this.now() + this.pollTimeoutMs;
    while (this.now() < deadline) {
      if (this.cancelRequested.has(jobId)) {
        try {
          await removeSpoolerJob(this.exec, printerName, windowsJobId);
        } catch (err) {
          this.ctx.log.warn('could not remove spooler job', { jobId, error: describe(err) });
        }
        return { status: 'cancelled', message: null };
      }

      const jobs = await listSpoolerJobs(this.exec, printerName);
      const mine = jobs.find((job) => job.id === windowsJobId);
      if (!mine) {
        // Gone from the queue is the spooler saying it is finished with it. This — not a
        // zero exit code from the helper — is what "انجام‌شده" is allowed to mean.
        return { status: 'done', message: null };
      }

      const outcome = classifyJobStatus(mine.status);
      if (outcome === 'error') return { status: 'error', message: `Printer reported: ${mine.status}` };
      if (outcome === 'cancelled') return { status: 'cancelled', message: null };
      if (outcome === 'done') return { status: 'done', message: null };

      if (this.disposed) return { status: 'printing', message: null };
      await this.sleep(this.pollIntervalMs);
    }

    return {
      status: 'error',
      message: 'The job was still in the Windows queue after ten minutes and was given up on.',
    };
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private transition(
    jobId: string,
    status: PrintJobStatus,
    extra: { started_at?: number; finished_at?: number; error_message?: string | null } = {},
  ): PrintJobRow {
    this.ctx.db
      .prepare(
        `UPDATE print_jobs
            SET status = @status,
                started_at = COALESCE(@startedAt, started_at),
                finished_at = COALESCE(@finishedAt, finished_at),
                error_message = COALESCE(@errorMessage, error_message)
          WHERE id = @id`,
      )
      .run({
        id: jobId,
        status,
        startedAt: extra.started_at ?? null,
        finishedAt: extra.finished_at ?? null,
        errorMessage: extra.error_message ?? null,
      });
    const row = this.requireJob(jobId);
    // Every transition is published. The PWA's job card is driven entirely by these; a state
    // that changes without an event is a card that stays on "در صف" for ever.
    this.publish(row);
    return row;
  }

  private finish(jobId: string, status: PrintJobStatus, message: string | null): PrintJobRow {
    this.cancelRequested.delete(jobId);
    const row = this.transition(jobId, status, {
      finished_at: this.now(),
      ...(message === null ? {} : { error_message: message }),
    });
    this.ctx.activity.record(`print.${status}`, row.device_id, {
      jobId,
      fileName: row.file_name,
      ...(message ? { message } : {}),
    });
    return row;
  }

  private fail(jobId: string, message: string): void {
    this.finish(jobId, 'error', message);
  }

  private async cleanupSpool(spoolPath: string | null): Promise<void> {
    if (!spoolPath) return;
    // The spool copy is a full second copy of the document sitting in a temp directory. It
    // goes as soon as the job leaves the queue, whichever way it left.
    await rm(spoolPath, { force: true }).catch(() => undefined);
  }

  findJob(jobId: string): PrintJobRow | null {
    const row = this.ctx.db.prepare(`SELECT * FROM print_jobs WHERE id = ?`).get(jobId) as
      | PrintJobRow
      | undefined;
    return row ?? null;
  }

  private requireJob(jobId: string): PrintJobRow {
    const row = this.findJob(jobId);
    if (!row) throw new ApiException(ErrorCode.NOT_FOUND, 'No such print job.');
    return row;
  }

  listForDevice(deviceId: string, limit = 50): PrintJob[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM print_jobs WHERE device_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(deviceId, limit) as PrintJobRow[];
    return rows.map((row) => this.toDto(row));
  }

  toDto(row: PrintJobRow): PrintJob {
    const printer = this.ctx.db.prepare(`SELECT name FROM printers WHERE id = ?`).get(row.printer_id) as
      | { name: string }
      | undefined;
    return {
      id: row.id,
      fileName: row.file_name,
      printerName: printer?.name ?? 'unknown',
      status: row.status,
      copies: row.copies,
      color: row.color,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  private publish(row: PrintJobRow): void {
    this.ctx.events.publish({ type: 'print-job', job: this.toDto(row) });
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiException) return err.message;
  return err instanceof Error ? err.message : String(err);
}
