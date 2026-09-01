import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ApiException, ErrorCode } from '@localcast/contract';
import type { PrintJob, PrintJobStatus } from '@localcast/contract';
import type { ServerContext } from '../../kernel.js';
import type { ExecFileFn } from './exec.js';
import { defaultExecFile } from './exec.js';
import {
  assertFallbackCanHonour,
  assertFallbackCanPrintType,
  buildPrintSettings,
  classifyJobStatus,
  findSumatra,
  listSpoolerJobs,
  probePrintTo,
  removeSpoolerJob,
  submitToSpooler,
  submitViaPrintTo,
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

    const wanted = {
      copies: row.copies,
      color: row.color,
      duplex: row.duplex,
      pageRange: row.page_range,
    };

    // Settings are only expressible through the helper. Without it the job still prints —
    // through the shell's `PrintTo` verb — but only if it asked for nothing the verb cannot
    // carry and the file's type actually has a handler.
    let settings = '';
    try {
      if (sumatra) {
        settings = buildPrintSettings(wanted);
      } else {
        // Cheapest refusal first: the settings check is pure, the type check costs a
        // PowerShell start-up. Both run only on the fallback path.
        assertFallbackCanHonour(wanted, this.ctx.paths.vendorDir);
        const support = await probePrintTo(this.exec, extname(row.file_name));
        this.ctx.log.info('PrintTo handler lookup', {
          jobId,
          ext: support.ext,
          registered: support.registered,
          progId: support.progId,
        });
        assertFallbackCanPrintType(support, this.ctx.paths.vendorDir);
      }
    } catch (err) {
      if (!sumatra) {
        this.ctx.log.error('print helper missing', { vendorDir: this.ctx.paths.vendorDir });
      }
      await this.cleanupSpool(spoolPath);
      this.fail(jobId, describe(err));
      return;
    }

    const seen = await listSpoolerJobs(this.exec, printerName);
    const before = new Set(seen.jobs.map((job) => job.id));

    this.transition(jobId, 'printing', { started_at: this.now() });

    /**
     * Discovery runs *alongside* the submission, not after it.
     *
     * Waiting for the submission to return and only then looking loses the job whenever it
     * is short: measured against the real spooler a one-page job is spooled, rendered and
     * gone in about 1.4 s while a single `Get-PrintJob` costs ~0.9 s, so the queue is
     * already empty by the time the first look happens. The job then has no
     * `windows_job_id`, cannot be cancelled, and its outcome is assumed rather than read —
     * which is the whole thing this module exists to avoid. Polling while the document is
     * still being handed over is what actually catches it.
     */
    let submissionInFlight = true;
    // `PrintTo` is fire-and-forget: `Start-Process` returns as soon as the shell has launched
    // the viewer, and measured against the real spooler the job took about six seconds to
    // appear afterwards. SumatraPDF's `-exit-when-done` has already waited, so it needs far
    // fewer looks once its submission has settled.
    const trailingAttempts = sumatra ? this.discoverAttempts : this.discoverAttempts * 4;
    const discovery = this.discoverJobId(
      printerName,
      before,
      trailingAttempts,
      () => submissionInFlight,
    );

    let submitFailure: unknown = null;
    try {
      if (sumatra) {
        await submitToSpooler(this.exec, {
          sumatraPath: sumatra,
          printerName,
          settings,
          filePath: spoolPath,
        });
      } else {
        this.ctx.log.info('printing without the bundled helper, through the PrintTo verb', {
          jobId,
        });
        await submitViaPrintTo(this.exec, { printerName, filePath: spoolPath });
      }
    } catch (err) {
      submitFailure = err;
    } finally {
      submissionInFlight = false;
    }

    // Awaited either way: an orphaned poll loop would keep spawning PowerShell after the job
    // it belongs to has already been failed and reported.
    const windowsJobId = await discovery;

    if (submitFailure !== null) {
      await this.cleanupSpool(spoolPath);
      this.fail(
        jobId,
        sumatra
          ? `The print helper failed: ${describe(submitFailure)}`
          : `Windows could not print this file: ${describe(submitFailure)}. ` +
              'Install the print helper to print this type.',
      );
      return;
    }

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
   * Finds the spooler job the submission just created by diffing the queue.
   *
   * Neither submission path reports what it handed over, and there is no other handle: the
   * only way to name the job the spooler now owns is to know which ids were there before.
   *
   * `submitting` keeps the loop going for as long as the document is still being handed to
   * Windows, however long that takes, and `trailingAttempts` is how many more looks it gets
   * afterwards. The overall cap exists so a submission that never settles cannot leave a
   * poll loop spawning PowerShell for ever.
   */
  private async discoverJobId(
    printerName: string,
    before: Set<number>,
    trailingAttempts: number,
    submitting: () => boolean,
  ): Promise<number | null> {
    const cap = Math.max(trailingAttempts, 1) * 40;
    let trailing = 0;

    for (let attempt = 0; attempt < cap; attempt += 1) {
      const queue = await listSpoolerJobs(this.exec, printerName);
      const fresh = queue.jobs.find((job) => !before.has(job.id));
      if (fresh) return fresh.id;

      if (!submitting()) {
        trailing += 1;
        if (trailing >= trailingAttempts) return null;
      }
      await this.sleep(this.pollIntervalMs);
    }
    return null;
  }

  private async watch(
    jobId: string,
    printerName: string,
    windowsJobId: number | null,
  ): Promise<{ status: PrintJobStatus; message: string | null }> {
    if (windowsJobId === null) {
      // The queue never showed the job. Measured on this machine a one-page job to a local
      // printer is spooled, rendered and gone in about 1.4 s while a single `Get-PrintJob`
      // costs ~0.9 s, so losing the race is ordinary rather than exotic — and submission did
      // succeed. It is reported as done, and logged, because it is also what a silently
      // dropped job looks like and the log is the only place the two can be told apart.
      this.ctx.log.warn('print job left the spooler before it could be observed', { jobId });
      return { status: 'done', message: null };
    }

    const deadline = this.now() + this.pollTimeoutMs;
    // A queue that cannot be read says nothing about the job. One failed reading is a blip
    // worth retrying; a run of them means the spooler is gone, and that is an error rather
    // than the silent "done" an unreadable queue used to produce.
    let unreadable = 0;
    const unreadableLimit = 3;

    while (this.now() < deadline) {
      if (this.cancelRequested.has(jobId)) {
        try {
          await removeSpoolerJob(this.exec, printerName, windowsJobId);
        } catch (err) {
          this.ctx.log.warn('could not remove spooler job', { jobId, error: describe(err) });
        }
        return { status: 'cancelled', message: null };
      }

      const queue = await listSpoolerJobs(this.exec, printerName);
      if (!queue.readable) {
        unreadable += 1;
        if (unreadable >= unreadableLimit) {
          return {
            status: 'error',
            message:
              'The Windows print queue stopped responding, so LocalCast cannot say whether this ' +
              'job printed. Check the printer before sending it again.',
          };
        }
        if (this.disposed) return { status: 'printing', message: null };
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      unreadable = 0;

      const mine = queue.jobs.find((job) => job.id === windowsJobId);
      if (!mine) {
        // Gone from a queue we could actually read is the spooler saying it is finished with
        // it. This — not a zero exit code from the helper — is what "انجام‌شده" may mean.
        return { status: 'done', message: null };
      }

      const outcome = classifyJobStatus(mine.status);
      if (outcome === 'error') return { status: 'error', message: `Printer reported: ${mine.status}` };
      if (outcome === 'cancelled') return { status: 'cancelled', message: null };
      if (outcome === 'done') return { status: 'done', message: null };

      if (this.disposed) return { status: 'printing', message: null };
      await this.sleep(this.pollIntervalMs);
    }

    // The duration is rendered from the configured timeout rather than written into the
    // sentence. It used to read "ten minutes" unconditionally, which was a lie in every test
    // that shortens the timeout and would have been a lie in production the day the default
    // changed — and this is the one message a user gets for a job that never finished.
    return {
      status: 'error',
      message:
        `The job was still in the Windows queue after ${describeDuration(this.pollTimeoutMs)} ` +
        'and was given up on. The printer is most likely paused, offline or out of paper.',
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

/** Plain English for a timeout, so the message reads the same to a user as to a test. */
export function describeDuration(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1_000));
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
