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

// ── the helper-free fallback ─────────────────────────────────────────────────

/**
 * Printing through the shell's `PrintTo` verb, which needs no bundled binary.
 *
 * Windows itself registers `printto` for images — `.png`, `.jpg` and `.tif` all resolve to
 * `rundll32 shimgvw.dll,ImageView_PrintTo` on a stock install — so images print out of the
 * box with nothing vendored at all. PDFs are different: `printto` for `.pdf` only exists if
 * some installed reader registered it. Acrobat does; **Edge, which is the default PDF handler
 * on a clean Windows, does not** (its ProgId `MSEdgePDF` exposes only `open` and `runas`).
 * That is why SumatraPDF is still the supported path for PDFs rather than dead weight.
 *
 * `Start-Process` throws when no handler is registered, which is the signal the caller needs:
 * it fails loudly instead of reporting a job nobody printed.
 */
export const PRINT_TO_SCRIPT =
  "Start-Process -FilePath $env:LC_FILE -Verb PrintTo " +
  "-ArgumentList ('\"' + $env:LC_PRINTER + '\"') -WindowStyle Hidden -ErrorAction Stop";

/**
 * Whether the shell has a `PrintTo` handler for one extension, asked of the registry.
 *
 * The comment above says images work and PDFs may not. That is true of a stock Windows and
 * false of most real machines, in both directions: Acrobat adds `printto` for `.pdf`, and
 * `.bmp` — which LocalCast accepts as a printable image — has **no** `printto` at all,
 * because its ProgId is `Paint.Picture` and Paint never registered the verb. Measured on the
 * reference machine: `.png`/`.jpg`/`.gif`/`.tif` resolve to `pngfile`/`jpegfile`/`giffile`/
 * `TIFImage.Document`, all of which have it; `.bmp` and `.webp` have none.
 *
 * So the limit is read rather than assumed. `Start-Process -Verb PrintTo` on a type with no
 * handler throws *after* the job has been accepted and the spool copy made, with a message
 * about "no app associated with it" that names neither the type nor the fix.
 */
export interface PrintToSupport {
  ext: string;
  /** True only when a `printto` verb was actually found. */
  registered: boolean;
  /** The ProgId that carries the verb, for the log. */
  progId: string | null;
  /**
   * False when the registry could not be read at all. An unanswerable question must not
   * become a refusal: the job is attempted and `Start-Process` gets to fail on its own.
   */
  known: boolean;
}

/** Only ever built from a validated extension, and passed in the environment even so. */
export const PRINT_TO_PROBE_SCRIPT = [
  '$ext=$env:LC_EXT;$ids=@();',
  "$uc=(Get-ItemProperty -LiteralPath ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\'+$ext+'\\UserChoice') -Name ProgId -ErrorAction SilentlyContinue).ProgId;",
  'if($uc){$ids+=$uc};',
  "$assoc=(Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\'+$ext) -Name '(default)' -ErrorAction SilentlyContinue).'(default)';",
  'if($assoc){$ids+=$assoc};$hit=$null;',
  "foreach($id in $ids){ if(-not $hit -and (Test-Path -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\'+$id+'\\shell\\printto'))){$hit=$id} };",
  "if(-not $hit -and (Test-Path -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\SystemFileAssociations\\'+$ext+'\\shell\\printto'))){$hit='SystemFileAssociations'+$ext};",
  '[pscustomobject]@{ProgId=[string]$hit;PrintTo=[bool]$hit}|ConvertTo-Json -Compress',
].join('');

/**
 * An extension is a registry path component here, so it is checked against a shape rather
 * than trusted. `..` or a backslash in a file name would otherwise walk to a different key —
 * a weaker hazard than the printer-name injection this module guards elsewhere, but the same
 * class of mistake, and the check costs nothing.
 */
const SAFE_EXTENSION = /^\.[a-z0-9]{1,16}$/;

export async function probePrintTo(exec: ExecFileFn, rawExt: string): Promise<PrintToSupport> {
  const ext = rawExt.toLowerCase();
  if (!SAFE_EXTENSION.test(ext)) {
    return { ext, registered: false, progId: null, known: true };
  }
  try {
    const { stdout } = await exec(POWERSHELL, powershellArgs(PRINT_TO_PROBE_SCRIPT), {
      timeoutMs: 15_000,
      env: { ...process.env, LC_EXT: ext },
    });
    const [row] = parsePowerShellJson<Record<string, unknown>>(stdout);
    if (!row || typeof row !== 'object') return { ext, registered: false, progId: null, known: true };
    const progId = typeof row['ProgId'] === 'string' && row['ProgId'] !== '' ? row['ProgId'] : null;
    return { ext, registered: row['PrintTo'] === true, progId, known: true };
  } catch {
    return { ext, registered: false, progId: null, known: false };
  }
}

/**
 * Refuses a type the shell cannot print, before anything is handed to Windows.
 *
 * PDFs and images fail for different reasons and have different fixes, so they get different
 * sentences. Both name the helper, because installing it is what makes either work.
 */
export function assertFallbackCanPrintType(support: PrintToSupport, vendorDir: string): void {
  if (!support.known || support.registered) return;

  const helper = `the print helper (${SUMATRA_BINARY} in ${vendorDir})`;
  const why =
    support.ext === '.pdf'
      ? `No PDF reader on this machine registers a Windows print handler for ${support.ext}. ` +
        'Edge, the default PDF viewer on a clean Windows, can open a PDF but not print one ' +
        'from the shell.'
      : `Windows has no application registered to print ${support.ext || 'this type'} files. ` +
        'Its file type has no PrintTo handler, which is the case for .bmp and .webp on a ' +
        'stock install.';

  throw new ApiException(
    ErrorCode.SPOOLER_FAILED,
    `${why} Install ${helper}, or convert the file to PDF first. Nothing was sent to the printer.`,
  );
}

/**
 * What the fallback cannot do.
 *
 * `PrintTo` hands the file to whichever application owns the type and gives no way to ask for
 * copies, duplex, colour or a page range — the document prints with the printer's own
 * defaults. Silently ignoring those would print one copy when two were asked for, or four
 * hundred pages when page 3 was asked for, so a request that depends on them is refused with
 * an explanation instead.
 */
export function assertFallbackCanHonour(input: PrintSettingsInput, vendorDir: string): void {
  const unsupported: string[] = [];
  if (input.pageRange && input.pageRange.trim() !== '') unsupported.push('a page range');
  if (input.copies > 1) unsupported.push('more than one copy');
  if (input.duplex !== 'simplex') unsupported.push('double-sided printing');
  if (unsupported.length === 0) return;

  throw new ApiException(
    ErrorCode.SPOOLER_FAILED,
    `Without the print helper (${SUMATRA_BINARY} in ${vendorDir}) LocalCast prints through Windows, ` +
      `which cannot be asked for ${unsupported.join(' or ')}. Print with the printer's own settings, ` +
      'or install the print helper. Nothing was sent to the printer.',
  );
}

export interface PrintToInput {
  printerName: string;
  filePath: string;
  timeoutMs?: number;
}

export async function submitViaPrintTo(exec: ExecFileFn, input: PrintToInput): Promise<void> {
  await exec(POWERSHELL, powershellArgs(PRINT_TO_SCRIPT), {
    timeoutMs: input.timeoutMs ?? 60_000,
    // Same rule as everywhere else in this module: the printer name and the path are data in
    // the environment, never text spliced into a script.
    env: { ...process.env, LC_PRINTER: input.printerName, LC_FILE: input.filePath },
  });
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

/**
 * Note the `[string]` casts. `JobStatus` is a .NET flags enum, and `ConvertTo-Json` serialises
 * an enum as its **integer** value, not its name: a real spooling job comes back as
 * `{"Id":6,"JobStatus":8}`, and a printing one as `8216` (Spooling|Printing|Retained). Casting
 * first is what turns those into the `"Spooling, Printing, Retained"` text `classifyJobStatus`
 * reads. Without the cast every status is an unrecognised number, so a job that ran out of
 * paper looks exactly like a job that is still going — which is how a jammed printer used to
 * sit at "در حال چاپ" until the ten-minute timeout gave up on it.
 */
export const LIST_JOBS_SCRIPT =
  'Get-PrintJob -PrinterName $env:LC_PRINTER -ErrorAction Stop | ' +
  'ForEach-Object { [pscustomobject]@{ ' +
  'Id=[int]$_.Id; DocumentName=[string]$_.DocumentName; JobStatus=[string]$_.JobStatus } } | ' +
  'ConvertTo-Json -Compress';

export const REMOVE_JOB_SCRIPT =
  'Remove-PrintJob -PrinterName $env:LC_PRINTER -ID ([int]$env:LC_JOB_ID) -ErrorAction Stop';

export interface SpoolerJob {
  id: number;
  documentName: string;
  status: string;
}

/**
 * A queue reading, and whether it is a reading at all.
 *
 * "The queue is empty" and "the queue could not be read" are the same bytes on the wire — an
 * empty `Get-PrintJob` writes nothing to stdout — but they mean opposite things to a watcher
 * that treats an absent job as a finished one. Keeping `readable` separate is what stops a
 * spooler that has stopped answering from being reported to the user as a successful print.
 */
export interface SpoolerQueue {
  readable: boolean;
  jobs: SpoolerJob[];
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
): Promise<SpoolerQueue> {
  let stdout: string;
  try {
    ({ stdout } = await exec(POWERSHELL, powershellArgs(LIST_JOBS_SCRIPT), {
      timeoutMs: 15_000,
      env: { ...process.env, LC_PRINTER: printerName },
    }));
  } catch {
    // Measured against the real spooler, `Get-PrintJob` on an empty queue exits 0 and writes
    // nothing — it does not throw. So reaching here means the query genuinely failed: the
    // printer was deleted, the spooler service is down, or PowerShell could not start. That
    // is emphatically not "the job finished".
    return { readable: false, jobs: [] };
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
  return { readable: true, jobs };
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
 * The bits behind the flag names, straight out of `JOB_STATUS_*` in winspool.
 *
 * `LIST_JOBS_SCRIPT` casts the enum to text so the names arrive, but the numeric form is
 * handled too: it is what the uncast script produced, it is what an older PowerShell or a
 * different serialiser can still emit, and misreading a bitmask as "still printing" is the
 * one failure mode that makes a broken job look healthy.
 */
const JOB_STATUS_BITS = {
  error: 0x0000_0002,
  deleting: 0x0000_0004,
  paperOut: 0x0000_0040,
  printed: 0x0000_0080,
  deleted: 0x0000_0100,
  blocked: 0x0000_0200,
  complete: 0x0000_1000,
} as const;

/**
 * Reads a `JobStatus` into an outcome.
 *
 * `JobStatus` is a flags value. Cast to text it stringifies as a comma list — `Printing,
 * Retained` and `Error, Offline` both occur — and uncast it arrives as an integer bitmask.
 * Both spellings are accepted. Anything carrying an error flag is an error, a delete flag is
 * a cancellation, and everything else is still in the queue.
 */
export function classifyJobStatus(status: string): SpoolerOutcome {
  const text = status.trim();

  // A bare integer is the flags value itself; `Number()` would also accept ' 12 ' and '0x8',
  // so the shape is checked before it is trusted.
  if (/^\d+$/.test(text)) {
    const bits = Number(text);
    if (bits & (JOB_STATUS_BITS.error | JOB_STATUS_BITS.paperOut | JOB_STATUS_BITS.blocked)) {
      return 'error';
    }
    if (bits & (JOB_STATUS_BITS.deleting | JOB_STATUS_BITS.deleted)) return 'cancelled';
    if (bits & (JOB_STATUS_BITS.complete | JOB_STATUS_BITS.printed)) return 'done';
    return 'printing';
  }

  const flags = text
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
