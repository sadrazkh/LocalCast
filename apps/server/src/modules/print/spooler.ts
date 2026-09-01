import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { ApiException, ErrorCode } from '@localcast/contract';
import type { ExecFileFn } from './exec.js';
import { POWERSHELL, powershellArgs } from './exec.js';
import { parsePowerShellJson } from './enumerate.js';

/**
 * Submission through the bundled SumatraPDF, and status read back from the real spooler.
 *
 * The split matters: SumatraPDF exits 0 as soon as it has handed the document to Windows,
 * which is long before anything reaches paper and says nothing about whether the printer was
 * out of toner. "انجام‌شده" only ever comes from `Get-PrintJob`.
 */

export const SUMATRA_BINARY = 'SumatraPDF.exe';

/** Also tried, because the bundled build is sometimes the portable single-file one. */
const SUMATRA_ALTERNATIVES = ['SumatraPDF-portable.exe', 'sumatrapdf.exe'];

export interface PrintSettingsInput {
  copies: number;
  color: 'color' | 'mono';
  duplex: 'simplex' | 'long' | 'short';
  pageRange?: string | null;
}

const PAGE_RANGE_PATTERN = /^\s*\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*\s*$/;

/**
 * Builds SumatraPDF's `-print-settings` string.
 *
 * The page range is validated rather than passed through. It is the one part of the string
 * that comes from the client, and although `execFile` means it can never become a shell
 * command, a malformed range makes SumatraPDF print the entire document instead of failing —
 * which on a 400-page PDF is an expensive way to find out.
 */
export function buildPrintSettings(input: PrintSettingsInput): string {
  const parts: string[] = [];

  const range = input.pageRange?.trim();
  if (range) {
    if (!PAGE_RANGE_PATTERN.test(range)) {
      throw new ApiException(ErrorCode.BAD_REQUEST, 'Page range must look like `1-4,7`.');
    }
    parts.push(range.replace(/\s+/g, ''));
  }

  parts.push(input.color === 'color' ? 'color' : 'monochrome');
  parts.push(
    input.duplex === 'long' ? 'duplexlong' : input.duplex === 'short' ? 'duplexshort' : 'simplex',
  );
  if (input.copies > 1) parts.push(`${Math.floor(input.copies)}x`);

  return parts.join(',');
}

/**
 * Locates the bundled helper. Returns `null` rather than throwing so the caller can fail the
 * job with a message the operator can act on — the alternative, pretending a job was printed
 * when nothing was, is the worst possible failure for a print feature.
 */
export async function findSumatra(vendorDir: string): Promise<string | null> {
  for (const name of [SUMATRA_BINARY, ...SUMATRA_ALTERNATIVES]) {
    const candidate = join(vendorDir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function missingSpoolerError(vendorDir: string): ApiException {
  return new ApiException(
    ErrorCode.SPOOLER_FAILED,
    `The print helper (${SUMATRA_BINARY}) is missing from ${vendorDir}. Reinstall LocalCast to restore it; nothing was sent to the printer.`,
  );
}

export interface SubmitInput {
  sumatraPath: string;
  printerName: string;
  settings: string;
  filePath: string;
  timeoutMs?: number;
}

export function buildSumatraArgs(input: SubmitInput): string[] {
  const args = ['-print-to', input.printerName];
  if (input.settings) args.push('-print-settings', input.settings);
  // `-silent` suppresses the error dialog that would otherwise wait for a click on a
  // headless tray app; `-exit-when-done` stops a viewer window from lingering.
  args.push('-silent', '-exit-when-done', input.filePath);
  return args;
}

export async function submitToSpooler(exec: ExecFileFn, input: SubmitInput): Promise<void> {
  await exec(input.sumatraPath, buildSumatraArgs(input), {
    timeoutMs: input.timeoutMs ?? 120_000,
  });
}

// ── spooler status ───────────────────────────────────────────────────────────

export const LIST_JOBS_SCRIPT =
  'Get-PrintJob -PrinterName $env:LC_PRINTER -ErrorAction Stop | ' +
  'Select-Object Id,DocumentName,JobStatus | ConvertTo-Json -Compress';

export const REMOVE_JOB_SCRIPT =
  'Remove-PrintJob -PrinterName $env:LC_PRINTER -ID ([int]$env:LC_JOB_ID) -ErrorAction Stop';

export interface SpoolerJob {
  id: number;
  documentName: string;
  status: string;
}

/**
 * The printer name travels in the environment, never inside the script text.
 *
 * PowerShell's `-Command` takes one string, so interpolating a printer name into it would be
 * a script injection from a value Windows lets the user type freely — `'; Remove-Item ...` is
 * a legal printer name. `$env:` reads it as data no matter what is in it.
 */
export async function listSpoolerJobs(
  exec: ExecFileFn,
  printerName: string,
): Promise<SpoolerJob[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(POWERSHELL, powershellArgs(LIST_JOBS_SCRIPT), {
      timeoutMs: 15_000,
      env: { ...process.env, LC_PRINTER: printerName },
    }));
  } catch {
    // `Get-PrintJob` throws when the queue is empty on some driver versions. An empty queue
    // and an unreadable queue look the same here; the caller treats both as "no job".
    return [];
  }

  const rows = parsePowerShellJson<Record<string, unknown>>(stdout);
  const jobs: SpoolerJob[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = Number(row['Id']);
    if (!Number.isInteger(id)) continue;
    jobs.push({
      id,
      documentName: typeof row['DocumentName'] === 'string' ? row['DocumentName'] : '',
      status: String(row['JobStatus'] ?? ''),
    });
  }
  return jobs;
}

export async function removeSpoolerJob(
  exec: ExecFileFn,
  printerName: string,
  jobId: number,
): Promise<void> {
  await exec(POWERSHELL, powershellArgs(REMOVE_JOB_SCRIPT), {
    timeoutMs: 15_000,
    env: { ...process.env, LC_PRINTER: printerName, LC_JOB_ID: String(jobId) },
  });
}

export type SpoolerOutcome = 'printing' | 'done' | 'error' | 'cancelled';

/**
 * Reads a `JobStatus` string into an outcome.
 *
 * `JobStatus` is a flags value that stringifies as a comma list, so `Printing, Retained` and
 * `Error, Offline` both occur. Anything containing an error flag is an error, a delete flag
 * is a cancellation, and everything else is still in the queue.
 */
export function classifyJobStatus(status: string): SpoolerOutcome {
  const flags = status
    .toLowerCase()
    .split(',')
    .map((flag) => flag.trim());
  if (flags.some((flag) => flag === 'error' || flag === 'blocked' || flag === 'paperout')) {
    return 'error';
  }
  if (flags.some((flag) => flag === 'deleting' || flag === 'deleted')) return 'cancelled';
  if (flags.some((flag) => flag === 'complete' || flag === 'printed')) return 'done';
  return 'printing';
}
