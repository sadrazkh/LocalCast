import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrintJobStatus } from '@localcast/contract';
import { defaultExecFile, POWERSHELL, powershellArgs } from '../../src/modules/print/exec.js';
import type { ExecFileFn } from '../../src/modules/print/exec.js';
import { enumeratePrinters, parsePowerShellJson, parsePrinters } from '../../src/modules/print/enumerate.js';
import {
  classifyJobStatus,
  listSpoolerJobs,
  probePrintTo,
  removeSpoolerJob,
} from '../../src/modules/print/spooler.js';
import { PrintQueue } from '../../src/modules/print/jobs.js';
import type { Harness } from './support/context.js';
import { createHarness } from './support/context.js';

/**
 * The print module against the actual Windows print spooler.
 *
 * Every other print test fakes the `execFile` boundary, which is the right way to test the
 * state machine but proves nothing about the things only Windows can answer: what
 * `Get-Printer` and `Get-PrintJob` really put on stdout, which file types the shell can
 * actually print, and what a job's status looks like when something has genuinely gone wrong.
 * All of those turned out to differ from the fakes, so these run for real.
 *
 * Two rules hold everywhere in this file.
 *
 * **It skips with a reason, never vacuously.** A run without a printer, without a spooler or
 * off Windows says which of those it hit. An integration test that cannot tell "this machine
 * has no printer" from "printing is broken" teaches people to ignore a red build.
 *
 * **It leaves the machine as it found it.** The faults below are induced on purpose — a
 * paused queue, a cancelled job — and every one of them is undone in a `finally`, with the
 * final state asserted.
 */

const exec = promisify(execFile);

const PDF_TARGET = 'Microsoft Print to PDF';

/** One `Get-PrintJob` through a fresh `powershell.exe` costs ~0.9 s on the reference machine. */
const SLOW = 180_000;

async function powershell(
  script: string,
  env: NodeJS.ProcessEnv = {},
  timeout = 120_000,
): Promise<string> {
  const { stdout } = await exec(POWERSHELL, powershellArgs(script), {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    env: { ...process.env, ...env },
  });
  return stdout.trim();
}

// ── what this machine can and cannot be asked to do ──────────────────────────

interface Reality {
  /** Non-null when the spooler suites cannot run here, and says which condition applies. */
  skip: string | null;
  printers: string[];
  hasPdfTarget: boolean;
  /** Pausing a queue needs a permission a locked-down account may not have. */
  pauseSkip: string | null;
}

/** Everything about the environment the skip decision depends on, and nothing else. */
export interface RealitySignals {
  platform: string;
  /** The first line of the failure, or null if `Get-Printer` ran. */
  printerQueryError: string | null;
  printerCount: number;
  /** `LOCALCAST_SKIP_REAL_SPOOLER`, for a developer who wants a fast run. */
  forcedOffBy: string | null;
}

/**
 * Why this suite would not run — as a pure function, so every branch can be proven without
 * having to find a machine that has no printer or no spooler.
 *
 * Each condition gets its own sentence on purpose. "skipped" alone is what teaches people to
 * ignore a red build, because it cannot tell a runner without a printer from printing being
 * broken.
 */
export function skipReasonFor(signals: RealitySignals): string | null {
  if (signals.forcedOffBy) return `forced off by ${signals.forcedOffBy}`;
  if (signals.platform !== 'win32') return `not Windows (platform is ${signals.platform})`;
  if (signals.printerQueryError !== null) {
    // The spooler service being stopped, PrintManagement missing and PowerShell being absent
    // all land here, and all three are environment rather than defect.
    return `no usable spooler on this machine — Get-Printer failed (${signals.printerQueryError})`;
  }
  if (signals.printerCount === 0) return 'this machine has no printers installed at all';
  return null;
}

async function probe(): Promise<Reality> {
  const none = { printers: [] as string[], hasPdfTarget: false, pauseSkip: 'not probed' };
  const forcedOffBy = process.env['LOCALCAST_SKIP_REAL_SPOOLER'] ? 'LOCALCAST_SKIP_REAL_SPOOLER' : null;

  if (forcedOffBy || process.platform !== 'win32') {
    return { ...none, skip: skipReasonFor({ platform: process.platform, printerQueryError: null, printerCount: 0, forcedOffBy }) };
  }

  let printers: string[] = [];
  let printerQueryError: string | null = null;
  try {
    // Deliberately not the module's own enumeration: this decides whether the suite may run,
    // and using the code under test to decide would turn a broken enumeration into a skip.
    const out = await powershell('(Get-Printer -ErrorAction Stop).Name -join "`n"', {}, 60_000);
    printers = out.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  } catch (err) {
    printerQueryError = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unknown';
  }

  const skip = skipReasonFor({
    platform: process.platform,
    printerQueryError,
    printerCount: printers.length,
    forcedOffBy,
  });
  if (skip) return { ...none, skip };

  const hasPdfTarget = printers.includes(PDF_TARGET);
  return {
    skip: null,
    printers,
    hasPdfTarget,
    pauseSkip: hasPdfTarget ? await probePauseCapability() : `${PDF_TARGET} is not installed`,
  };
}

/**
 * Pauses and immediately resumes the print-to-PDF queue to find out whether this account may.
 *
 * Doing it here rather than inside a test means the fault suite skips with a reason instead of
 * failing on a machine where printer administration is locked down. The `finally` matters:
 * the whole point of these tests is that they do not leave a paused printer behind, and that
 * has to include the probe that decides whether to run them.
 */
async function probePauseCapability(): Promise<string | null> {
  let paused = false;
  try {
    const code = await setQueuePaused(PDF_TARGET, true);
    if (code !== 0) return `pausing a print queue is not permitted here (Pause returned ${code})`;
    paused = true;
    return null;
  } catch (err) {
    return `pausing a print queue failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (paused) await setQueuePaused(PDF_TARGET, false).catch(() => undefined);
  }
}

/**
 * Pauses or resumes a queue through `Win32_Printer`'s own methods.
 *
 * `Suspend-PrintQueue` does not exist in Windows PowerShell 5.1, which is what ships with
 * Windows and what this module shells out to. The printer name goes through the environment
 * and is compared in a `Where-Object`, not spliced into a WQL filter, for the same reason
 * every other script in this module does it that way.
 */
function setQueuePaused(printer: string, paused: boolean): Promise<number> {
  return powershell(
    '$p = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $env:LC_PRINTER };' +
      'if (-not $p) { -1 } else { (Invoke-CimMethod -InputObject $p -MethodName ' +
      "$(if ($env:LC_PAUSE -eq '1') { 'Pause' } else { 'Resume' })).ReturnValue }",
    { LC_PRINTER: printer, LC_PAUSE: paused ? '1' : '0' },
    60_000,
  ).then((out) => Number(out.trim()));
}

function printerStatus(printer: string): Promise<string> {
  return powershell(
    '[string](Get-Printer -Name $env:LC_PRINTER -ErrorAction Stop).PrinterStatus',
    { LC_PRINTER: printer },
    60_000,
  );
}

const reality = await probe();

/**
 * Submits a genuine spooler job to `Microsoft Print to PDF` **without any bundled helper and
 * without the Save-As dialog**.
 *
 * The printer's port is `PORTPROMPT:`, which normally opens a file picker and would hang a
 * test forever. Setting `PrinterSettings.PrintToFile` / `PrintFileName` puts the destination
 * in `DOCINFO.lpszOutput`, and the driver writes straight there instead of asking — which is
 * how Print-to-PDF is driven non-interactively.
 */
const SUBMIT_SCRIPT = [
  'Add-Type -AssemblyName System.Drawing;',
  '$d=New-Object System.Drawing.Printing.PrintDocument;',
  '$d.DocumentName=$env:LC_DOCNAME;',
  '$d.PrinterSettings.PrinterName=$env:LC_PRINTER;',
  '$d.PrinterSettings.PrintToFile=$true;',
  '$d.PrinterSettings.PrintFileName=$env:LC_OUTFILE;',
  '$n=[int]$env:LC_PAGES;',
  '$script:i=0;',
  '$d.add_PrintPage({ param($s,$e)',
  '  $script:i++;',
  '  $f=New-Object System.Drawing.Font("Arial",24);',
  '  $e.Graphics.DrawString("LocalCast real spooler test page $script:i",$f,[System.Drawing.Brushes]::Black,60,60);',
  '  $e.HasMorePages = ($script:i -lt $n) });',
  '$d.Print();',
].join('');

function submitRealJob(
  printer: string,
  outFile: string,
  pages: number,
  docName: string,
  timeout = 120_000,
): Promise<string> {
  return powershell(
    SUBMIT_SCRIPT,
    { LC_PRINTER: printer, LC_OUTFILE: outFile, LC_PAGES: String(pages), LC_DOCNAME: docName },
    timeout,
  );
}

async function clearQueue(printer: string): Promise<void> {
  await powershell(
    'Get-PrintJob -PrinterName $env:LC_PRINTER -ErrorAction SilentlyContinue | ' +
      'ForEach-Object { Remove-PrintJob -PrinterName $env:LC_PRINTER -ID $_.Id -ErrorAction SilentlyContinue }',
    { LC_PRINTER: printer },
    60_000,
  ).catch(() => undefined);
}

/**
 * Waits for the queue to actually drain.
 *
 * `Remove-PrintJob` only *asks*: measured here, a removed job sits in the queue reporting
 * `Paused, Deleting, Spooling` for several seconds before it goes. Checking once and
 * declaring the machine clean would have been wrong most of the time.
 */
async function waitForEmptyQueue(printer: string, attempts = 15): Promise<number> {
  let left = 0;
  for (let i = 0; i < attempts; i += 1) {
    const queue = await listSpoolerJobs(defaultExecFile, printer);
    left = queue.jobs.length;
    if (queue.readable && left === 0) return 0;
    await clearQueue(printer);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return (await listSpoolerJobs(defaultExecFile, printer)).jobs.length;
}

/**
 * Waits for the printer to be *stably* back to normal, and reports what it saw.
 *
 * One clean reading is not enough. Observed after a run: the suite's own cleanup checked
 * once, saw an empty unpaused queue, and a second later the printer read `Paused` with one
 * job — the tail of a submission the spooler had not finished tearing down. A cleanup
 * assertion that can pass a second before the machine is actually clean is worth nothing, so
 * this insists on two consecutive clean readings.
 */
async function waitUntilRestored(
  printer: string,
  attempts = 12,
): Promise<{ jobs: number; status: string }> {
  let clean = 0;
  let last = { jobs: -1, status: 'unknown' };
  for (let i = 0; i < attempts; i += 1) {
    const jobs = await waitForEmptyQueue(printer, 3);
    const status = await printerStatus(printer).catch(() => 'unreadable');
    last = { jobs, status };
    if (jobs === 0 && status !== 'Paused') {
      clean += 1;
      if (clean >= 2) return last;
    } else {
      clean = 0;
      await setQueuePaused(printer, false).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return last;
}

// ── the skip decision itself, which must never be skipped ────────────────────

describe('why this suite would not run', () => {
  it('names the condition it hit, one sentence per condition', () => {
    const base = { platform: 'win32', printerQueryError: null, printerCount: 3, forcedOffBy: null };

    expect(skipReasonFor(base)).toBeNull();
    expect(skipReasonFor({ ...base, platform: 'linux' })).toBe('not Windows (platform is linux)');
    expect(skipReasonFor({ ...base, printerCount: 0 })).toBe(
      'this machine has no printers installed at all',
    );
    expect(
      skipReasonFor({ ...base, printerQueryError: 'The term Get-Printer is not recognized' }),
    ).toMatch(/no usable spooler on this machine.*Get-Printer is not recognized/);
    expect(skipReasonFor({ ...base, forcedOffBy: 'LOCALCAST_SKIP_REAL_SPOOLER' })).toBe(
      'forced off by LOCALCAST_SKIP_REAL_SPOOLER',
    );
  });

  it('never reports a spooler failure as an ordinary empty machine', () => {
    // The two look identical from a distance and mean opposite things: one is a runner
    // without a printer, the other is a broken spooler. Conflating them is what makes a red
    // build unreadable.
    const broken = skipReasonFor({
      platform: 'win32',
      printerQueryError: 'RPC server unavailable',
      printerCount: 0,
      forcedOffBy: null,
    });
    expect(broken).toMatch(/RPC server unavailable/);
    expect(broken).not.toMatch(/no printers installed/);
  });
});

// ── enumeration ──────────────────────────────────────────────────────────────

describe.skipIf(reality.skip !== null)('real Get-Printer enumeration', () => {
  it(`maps every field for all ${reality.printers.length} printers on this machine`, async () => {
    const printers = await enumeratePrinters(defaultExecFile);

    expect(printers.length).toBe(reality.printers.length);
    expect(printers.map((p) => p.name).sort()).toEqual([...reality.printers].sort());

    for (const printer of printers) {
      expect(printer.name).not.toBe('');
      // A driver name is what tells a plotter from a fax; a null here means the join with
      // Win32_Printer silently missed.
      expect(typeof printer.driver).toBe('string');
      expect(printer.driver).not.toBe('');
      expect(printer.status).not.toBe('');
      expect(typeof printer.isDefault).toBe('boolean');
      expect(typeof printer.color).toBe('boolean');
      expect(typeof printer.duplex).toBe('boolean');
      expect(typeof printer.online).toBe('boolean');
    }

    // At most one default, and it has to be the one Windows itself calls default. Asserting
    // "exactly one" was wrong: a machine can have no default printer at all, and a CI runner
    // regularly does — that is not a mapping bug and must not read as one.
    const defaults = printers.filter((p) => p.isDefault);
    expect(defaults.length).toBeLessThanOrEqual(1);
    const win32Default = await powershell(
      '[string](Get-CimInstance Win32_Printer | Where-Object { $_.Default } | ' +
        'Select-Object -First 1 -ExpandProperty Name)',
    );
    expect(defaults.map((p) => p.name)).toEqual(win32Default === '' ? [] : [win32Default]);
  }, SLOW);

  it('agrees with Win32_Printer about the default and the capabilities', async () => {
    const raw = await powershell(
      'Get-CimInstance Win32_Printer | ForEach-Object { [pscustomobject]@{ ' +
        'Name=$_.Name; Default=[bool]$_.Default; WorkOffline=[bool]$_.WorkOffline; ' +
        "Color=[bool]($_.CapabilityDescriptions -contains 'Color'); " +
        "Duplex=[bool]($_.CapabilityDescriptions -contains 'Duplex') } } | ConvertTo-Json -Compress",
    );
    // Parsed with the module's own reader, not a second `JSON.parse` in the test.
    // `ConvertTo-Json` emits a bare object rather than an array when the pipeline produced
    // one item, so a hand-rolled `JSON.parse(raw).map(...)` here threw `.map is not a
    // function` on any machine with a single printer — green on this eight-printer
    // workstation, red on the one-printer CI runner. Two parsers is how they drift.
    const truth = new Map(
      parsePowerShellJson<{
        Name: string;
        Default: boolean;
        WorkOffline: boolean;
        Color: boolean;
        Duplex: boolean;
      }>(raw).map((row) => [row.Name, row]),
    );

    for (const printer of await enumeratePrinters(defaultExecFile)) {
      const win32 = truth.get(printer.name);
      if (!win32) continue;
      expect({ name: printer.name, isDefault: printer.isDefault }).toEqual({
        name: printer.name,
        isDefault: win32.Default,
      });
      expect({ name: printer.name, color: printer.color }).toEqual({
        name: printer.name,
        color: win32.Color,
      });
      expect({ name: printer.name, duplex: printer.duplex }).toEqual({
        name: printer.name,
        duplex: win32.Duplex,
      });
      // The regression this exists for: `PrinterStatus` reports `Normal` for a printer
      // flagged WorkOffline, so a status-only reading advertised an unreachable printer as
      // online and let jobs queue where nothing would ever drain them.
      if (win32.WorkOffline) {
        expect({ name: printer.name, online: printer.online }).toEqual({
          name: printer.name,
          online: false,
        });
      }
    }
  }, SLOW);

  it('parses the one-printer shape PowerShell really emits, not just the many-printer one', async () => {
    // The CI shape, produced on this machine. `ConvertTo-Json` only brackets a pipeline that
    // carried more than one item, so a runner with a single printer gets `{...}` where this
    // workstation gets `[{...},{...}]` — and the array path is the only one a many-printer
    // machine ever exercises. Both are checked here through the production parser.
    const single = await powershell(
      'Get-Printer | Select-Object -First 1 | ForEach-Object { [pscustomobject]@{ ' +
        'Name=$_.Name; Driver=[string]$_.DriverName; Status=[string]$_.PrinterStatus; ' +
        'IsDefault=$false; Color=$false; Duplex=$false; Online=$true } } | ConvertTo-Json -Compress',
    );
    expect(single.startsWith('{')).toBe(true);
    expect(parsePowerShellJson(single)).toHaveLength(1);
    expect(parsePrinters(single)).toHaveLength(1);
    expect(reality.printers).toContain(parsePrinters(single)[0]?.name);

    if (reality.printers.length > 1) {
      const many = await powershell(
        'Get-Printer | Select-Object -First 2 | ForEach-Object { [pscustomobject]@{ ' +
          'Name=$_.Name; Driver=[string]$_.DriverName; Status=[string]$_.PrinterStatus; ' +
          'IsDefault=$false; Color=$false; Duplex=$false; Online=$true } } | ConvertTo-Json -Compress',
      );
      expect(many.startsWith('[')).toBe(true);
      expect(parsePrinters(many)).toHaveLength(2);
    }
  }, SLOW);
});

// ── what the shell can print without the bundled helper ──────────────────────

describe.skipIf(reality.skip !== null)('the real PrintTo registration', () => {
  it('reads the registry rather than assuming what Windows registers', async () => {
    // The fallback's limits are read from the machine, so this asserts the shape of the
    // answer and the internal consistency of it, not a list of types that would only be
    // true of the workstation it was written on.
    for (const ext of ['.pdf', '.png', '.jpg', '.tif', '.bmp', '.webp'] as const) {
      const support = await probePrintTo(defaultExecFile, ext);
      expect({ ext, known: support.known }).toEqual({ ext, known: true });
      // A ProgId is reported if and only if a handler was found.
      expect({ ext, consistent: support.registered === (support.progId !== null) }).toEqual({
        ext,
        consistent: true,
      });
    }
  }, SLOW);

  it('finds no PrintTo handler for .bmp, which is why a bitmap is refused without the helper', async () => {
    // Measured here, not assumed: `.bmp` resolves to `Paint.Picture`, and Paint never
    // registered `printto`. `.png` is the control — Windows does register it — so a probe
    // that simply always returned false could not pass both halves.
    const bmp = await probePrintTo(defaultExecFile, '.bmp');
    const png = await probePrintTo(defaultExecFile, '.png');
    expect({ bmp: bmp.registered, png: png.registered }).toEqual({ bmp: false, png: true });
  }, SLOW);
});

// ── the queue, read back from the real spooler ───────────────────────────────

describe.skipIf(reality.skip !== null)('real Get-PrintJob', () => {
  it('reports an empty queue as readable, not as a failure', async () => {
    const printer = reality.printers[0] as string;
    await clearQueue(printer);
    const queue = await listSpoolerJobs(defaultExecFile, printer);
    // `Get-PrintJob` on an empty queue exits 0 and writes nothing — measured, not assumed.
    // Conflating that with a failed query is what let a dead spooler report a job as done.
    expect(queue.readable).toBe(true);
    expect(queue.jobs).toEqual([]);
  }, SLOW);

  it('reports a printer that does not exist as unreadable', async () => {
    const queue = await listSpoolerJobs(defaultExecFile, 'LocalCast No Such Printer 8f3a');
    expect(queue.readable).toBe(false);
    expect(queue.jobs).toEqual([]);
  }, SLOW);
});

describe.skipIf(reality.skip !== null || !reality.hasPdfTarget)(
  'a real job through the real spooler',
  () => {
    const outFile = join(process.env['TEMP'] ?? '.', `localcast-real-${process.pid}.pdf`);

    afterAll(async () => {
      await clearQueue(PDF_TARGET);
      await rm(outFile, { force: true }).catch(() => undefined);
    });

    it('appears in Get-PrintJob with a numeric id and a NAMED status, then prints', async () => {
      await clearQueue(PDF_TARGET);
      await rm(outFile, { force: true }).catch(() => undefined);

      const before = await listSpoolerJobs(defaultExecFile, PDF_TARGET);
      expect(before.readable).toBe(true);
      const seen = new Set(before.jobs.map((j) => j.id));

      // Enough pages that the job is still in the queue when the first poll lands.
      const submission = submitRealJob(PDF_TARGET, outFile, 40, 'LocalCast integration job');

      let mine: { id: number; documentName: string; status: string } | undefined;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !mine) {
        const queue = await listSpoolerJobs(defaultExecFile, PDF_TARGET);
        expect(queue.readable).toBe(true);
        mine = queue.jobs.find((job) => !seen.has(job.id));
      }
      await submission;

      expect(mine, 'the job never appeared in Get-PrintJob').toBeDefined();
      const job = mine as { id: number; documentName: string; status: string };

      // The id is what `windows_job_id` records and what `Remove-PrintJob` is given.
      expect(Number.isInteger(job.id)).toBe(true);
      expect(job.id).toBeGreaterThan(0);
      expect(job.documentName).toBe('LocalCast integration job');

      // The regression, in one assertion. Without the `[string]` cast in LIST_JOBS_SCRIPT this
      // is "8" or "8216" — a bare bitmask that classifies as "still printing" no matter what
      // the printer is actually doing, hiding every error and every completion.
      expect(job.status).not.toMatch(/^\d+$/);
      expect(job.status).toMatch(/Spooling|Printing|Retained|Printed|Complete|Paused|Error/i);
      expect(['printing', 'done']).toContain(classifyJobStatus(job.status));

      // …and the job really did print: a genuine PDF, written by Windows, no helper involved.
      const bytes = await readFile(outFile);
      expect(bytes.length).toBeGreaterThan(1000);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }, SLOW);
  },
);

// ── the whole state machine, with the real spooler deciding ──────────────────

describe.skipIf(reality.skip !== null || !reality.hasPdfTarget)(
  'PrintQueue against the real spooler',
  () => {
    let harness: Harness;
    let queue: PrintQueue | null = null;
    const outFile = join(process.env['TEMP'] ?? '.', `localcast-queue-${process.pid}.pdf`);

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await queue?.dispose();
      queue = null;
      await clearQueue(PDF_TARGET);
      await rm(outFile, { force: true }).catch(() => undefined);
      await harness.cleanup();
    });

    it('reaches done because Get-PrintJob said so, with a real windows_job_id', async () => {
      await clearQueue(PDF_TARGET);
      await rm(outFile, { force: true }).catch(() => undefined);

      const deviceId = harness.addDevice().id;
      const folderId = harness.addFolder({ label: 'Docs', kind: 'documents' }).id;
      harness.grant(deviceId, folderId, 'full');
      await harness.putFile(folderId, 'real.pdf', Buffer.from('%PDF-1.4 placeholder'));

      const printer = harness.addPrinter({ name: PDF_TARGET });
      await writeFile(join(harness.ctx.paths.vendorDir, 'SumatraPDF.exe'), 'stand-in');

      // Everything PowerShell — the queue reads, the discovery diff, the status classification
      // and the removal — goes to the real spooler. Only the submission is substituted, because
      // the real helper is deliberately not shipped (see vendor/README.md) and the one thing
      // Windows cannot be asked to do non-interactively is print a PDF without one.
      let submitted = 0;
      const realExec: ExecFileFn = async (file, args, options) => {
        if (file === POWERSHELL) return defaultExecFile(file, args, options);
        submitted += 1;
        await submitRealJob(PDF_TARGET, outFile, 40, 'LocalCast queue job');
        return { stdout: '', stderr: '' };
      };

      queue = new PrintQueue(harness.ctx, {
        exec: realExec,
        pollIntervalMs: 250,
        discoverAttempts: 20,
        pollTimeoutMs: 120_000,
      });

      const job = queue.enqueue({
        deviceId,
        printerId: printer.id,
        printerName: PDF_TARGET,
        sourceKind: 'library',
        sourcePath: join(harness.root, 'folders', folderId, 'real.pdf'),
        fileName: 'real.pdf',
        copies: 1,
        color: 'mono',
        duplex: 'simplex',
      });
      expect(job.status).toBe('queued');

      await queue.drain();

      const row = harness.ctx.db
        .prepare(`SELECT status, windows_job_id, started_at, finished_at, error_message FROM print_jobs WHERE id = ?`)
        .get(job.id) as {
        status: PrintJobStatus;
        windows_job_id: number | null;
        started_at: number | null;
        finished_at: number | null;
        error_message: string | null;
      };

      expect(submitted).toBe(1);
      expect(row.error_message).toBeNull();
      expect(row.status).toBe('done');
      expect(row.started_at).toBeGreaterThan(0);
      expect(row.finished_at).toBeGreaterThan(0);

      // The claim this test exists for: `done` came from the real queue, and the real spooler
      // id was captured rather than the job being waved through unobserved.
      expect(row.windows_job_id).not.toBeNull();
      expect(Number.isInteger(row.windows_job_id)).toBe(true);
      expect(row.windows_job_id as number).toBeGreaterThan(0);

      // Windows really produced the document.
      const bytes = await readFile(outFile);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }, SLOW);
  },
);

// ── a fault that actually happened, not one that was typed in ────────────────

/**
 * Until now `error` and `cancelled` were only ever proven against status *strings*. Both
 * classifications were correct about text somebody wrote down; neither had ever seen a job
 * that really went wrong. These induce one.
 *
 * The lever is a paused queue. `Win32_Printer.Pause()` needs no administrator, wastes no
 * paper, and — measured on the reference machine — holds a submitted job at `Spooling`
 * indefinitely, which is exactly the shape of a printer that has stopped taking work. The
 * cost is that it is a real change to a real printer, so every test here resumes the queue in
 * a `finally` and the suite asserts, at the end, that nothing was left behind.
 */
describe.skipIf(reality.skip !== null || !reality.hasPdfTarget || reality.pauseSkip !== null)(
  'a real fault, induced and cleaned up',
  () => {
    let harness: Harness;
    let queue: PrintQueue | null = null;
    /** Submissions are started and not awaited; a paused queue means they do not return. */
    let pending: Promise<unknown>[] = [];
    const outFile = join(process.env['TEMP'] ?? '.', `localcast-fault-${process.pid}.pdf`);

    /**
     * Starts a real submission without waiting for it.
     *
     * With the queue paused `$d.Print()` blocks until the job is drained or removed, so
     * awaiting it inside the substituted `exec` would deadlock the state machine. Returning
     * immediately is also the more faithful model: the `PrintTo` fallback really is
     * fire-and-forget, which is why `discoverJobId` polls while the submission is in flight.
     */
    function startSubmission(docName: string): void {
      pending.push(
        submitRealJob(PDF_TARGET, outFile, 120, docName, 150_000).catch(() => undefined),
      );
    }

    function fireAndForgetExec(docName: string): ExecFileFn {
      return async (file, args, options) => {
        if (file === POWERSHELL) return defaultExecFile(file, args, options);
        startSubmission(docName);
        return { stdout: '', stderr: '' };
      };
    }

    async function waitForColumn<T>(
      jobId: string,
      column: 'status' | 'windows_job_id',
      predicate: (value: T) => boolean,
      timeoutMs = 90_000,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const row = harness.ctx.db
          .prepare(`SELECT ${column} AS value FROM print_jobs WHERE id = ?`)
          .get(jobId) as { value: T } | undefined;
        if (row && predicate(row.value)) return row.value;
        if (Date.now() > deadline) {
          throw new Error(`print job ${jobId} never reached the expected ${column} (last: ${String(row?.value)})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    function enqueueOne(printerId: string, folderId: string, deviceId: string): string {
      const job = (queue as PrintQueue).enqueue({
        deviceId,
        printerId,
        printerName: PDF_TARGET,
        sourceKind: 'library',
        sourcePath: join(harness.root, 'folders', folderId, 'real.pdf'),
        fileName: 'real.pdf',
        copies: 1,
        color: 'mono',
        duplex: 'simplex',
      });
      return job.id;
    }

    async function setUp(): Promise<{ deviceId: string; folderId: string; printerId: string }> {
      const deviceId = harness.addDevice().id;
      const folderId = harness.addFolder({ label: 'Docs', kind: 'documents' }).id;
      harness.grant(deviceId, folderId, 'full');
      await harness.putFile(folderId, 'real.pdf', Buffer.from('%PDF-1.4 placeholder'));
      const printer = harness.addPrinter({ name: PDF_TARGET });
      // Present so the settings path is the helper path; the submission is substituted anyway.
      await writeFile(join(harness.ctx.paths.vendorDir, 'SumatraPDF.exe'), 'stand-in');
      return { deviceId, folderId, printerId: printer.id };
    }

    // Every hook here shells out to PowerShell several times, and one `Get-PrintJob` alone
    // costs ~0.9 s. Vitest's 10 s hook default is not enough, and a cleanup that is cut off
    // half way is precisely how a paused queue gets left behind.
    beforeEach(async () => {
      harness = await createHarness();
      pending = [];
      await clearQueue(PDF_TARGET);
    }, SLOW);

    afterEach(async () => {
      // Order matters. Resume first so a blocked submission can finish and let go of the
      // job, then clear the queue, then wait for the submissions to actually exit — an
      // orphaned powershell.exe holding a spool file is its own kind of mess.
      await setQueuePaused(PDF_TARGET, false).catch(() => undefined);
      await clearQueue(PDF_TARGET);
      await Promise.all(pending).catch(() => undefined);
      await waitForEmptyQueue(PDF_TARGET);
      await queue?.dispose();
      queue = null;
      await rm(outFile, { force: true }).catch(() => undefined);
      await harness.cleanup();
    }, SLOW);

    afterAll(async () => {
      // The assertion the "leave no paused queues" rule deserves: not a promise in a comment.
      await setQueuePaused(PDF_TARGET, false).catch(() => undefined);
      const restored = await waitUntilRestored(PDF_TARGET);
      expect({ jobs: restored.jobs, paused: restored.status === 'Paused' }).toEqual({
        jobs: 0,
        paused: false,
      });
      await rm(outFile, { force: true }).catch(() => undefined);
    }, SLOW);

    it('reports a job stranded in a paused queue as an error, and says how long it waited', async () => {
      const { deviceId, folderId, printerId } = await setUp();
      expect(await setQueuePaused(PDF_TARGET, true)).toBe(0);
      expect(await printerStatus(PDF_TARGET)).toBe('Paused');

      queue = new PrintQueue(harness.ctx, {
        exec: fireAndForgetExec('LocalCast stranded job'),
        pollIntervalMs: 250,
        discoverAttempts: 40,
        // Short on purpose. The production default is ten minutes; what is being proven is
        // that the give-up path fires on a genuinely stuck job and says what happened.
        pollTimeoutMs: 20_000,
      });

      const jobId = enqueueOne(printerId, folderId, deviceId);
      const windowsJobId = await waitForColumn<number | null>(
        jobId,
        'windows_job_id',
        (value) => typeof value === 'number' && value > 0,
      );

      // The job is genuinely in the real queue and genuinely not moving.
      const stuck = await listSpoolerJobs(defaultExecFile, PDF_TARGET);
      const mine = stuck.jobs.find((job) => job.id === windowsJobId);
      expect(mine, 'the stranded job should still be in the real queue').toBeDefined();
      // Whatever the spooler calls it, it must not read as finished.
      expect(classifyJobStatus((mine as { status: string }).status)).not.toBe('done');

      await queue.drain();

      const row = harness.ctx.db
        .prepare(`SELECT status, error_message FROM print_jobs WHERE id = ?`)
        .get(jobId) as { status: PrintJobStatus; error_message: string | null };

      expect(row.status).toBe('error');
      // The message carries the configured wait, not a number baked into the sentence.
      expect(row.error_message).toMatch(/still in the Windows queue after 20 seconds/);
      expect(row.error_message).toMatch(/paused, offline or out of paper/);
    }, SLOW);

    it('cancels a real job mid-spool, and the spooler really loses it', async () => {
      const { deviceId, folderId, printerId } = await setUp();
      expect(await setQueuePaused(PDF_TARGET, true)).toBe(0);

      queue = new PrintQueue(harness.ctx, {
        exec: fireAndForgetExec('LocalCast cancelled job'),
        pollIntervalMs: 250,
        discoverAttempts: 40,
        pollTimeoutMs: 120_000,
      });

      const jobId = enqueueOne(printerId, folderId, deviceId);
      const windowsJobId = (await waitForColumn<number | null>(
        jobId,
        'windows_job_id',
        (value) => typeof value === 'number' && value > 0,
      )) as number;
      await waitForColumn<string>(jobId, 'status', (value) => value === 'printing');

      (queue as PrintQueue).cancel(jobId, deviceId);
      await queue.drain();

      const row = harness.ctx.db
        .prepare(`SELECT status, error_message FROM print_jobs WHERE id = ?`)
        .get(jobId) as { status: PrintJobStatus; error_message: string | null };
      expect(row.status).toBe('cancelled');
      expect(row.error_message).toBeNull();

      // …and it was not just a database write. The spooler was really asked, and either the
      // job is gone or it is on its way out — never still printing.
      const after = await listSpoolerJobs(defaultExecFile, PDF_TARGET);
      expect(after.readable).toBe(true);
      const leftover = after.jobs.find((job) => job.id === windowsJobId);
      if (leftover) expect(classifyJobStatus(leftover.status)).toBe('cancelled');
    }, SLOW);

    it('classifies the live status of a suspended and then removed job, not a written-down one', async () => {
      // The honesty gap this closes: `classifyJobStatus` was only ever fed strings a human
      // typed. These come from `Get-PrintJob` on a job that was really paused and really
      // deleted. The values observed here were `Paused, Spooling, Printing, Retained` (8217)
      // and `Paused, Deleting, Spooling, Printing, Retained` (8221).
      const before = await listSpoolerJobs(defaultExecFile, PDF_TARGET);
      expect(before.readable).toBe(true);
      const seen = new Set(before.jobs.map((job) => job.id));

      expect(await setQueuePaused(PDF_TARGET, true)).toBe(0);
      startSubmission('LocalCast live status job');

      // Diffed against what was there first. Taking the head of the queue picked up a job
      // another test had left mid-deletion, which made this assert about the wrong job.
      let mine: { id: number; status: string } | undefined;
      const appear = Date.now() + 90_000;
      while (Date.now() < appear && !mine) {
        mine = (await listSpoolerJobs(defaultExecFile, PDF_TARGET)).jobs.find(
          (job) => !seen.has(job.id),
        );
      }
      expect(mine, 'no job ever reached the paused queue').toBeDefined();
      const jobId = (mine as { id: number }).id;

      await powershell(
        'Suspend-PrintJob -PrinterName $env:LC_PRINTER -ID ([int]$env:LC_JOB_ID) -ErrorAction Stop',
        { LC_PRINTER: PDF_TARGET, LC_JOB_ID: String(jobId) },
        60_000,
      );

      const suspended = (await listSpoolerJobs(defaultExecFile, PDF_TARGET)).jobs.find(
        (job) => job.id === jobId,
      );
      expect(suspended?.status).toMatch(/Paused/i);
      // A paused job is not a finished one. Reporting `done` here is the specific lie this
      // module exists to prevent.
      expect(classifyJobStatus((suspended as { status: string }).status)).toBe('printing');

      // The production removal, against the real spooler.
      await removeSpoolerJob(defaultExecFile, PDF_TARGET, jobId);

      const observed: string[] = [];
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const found = (await listSpoolerJobs(defaultExecFile, PDF_TARGET)).jobs.find(
          (job) => job.id === jobId,
        );
        if (!found) break;
        observed.push(found.status);
        if (observed.length >= 6) break;
      }

      // `Remove-PrintJob` is asynchronous and the queue is paused, so the job lingers in a
      // deleting state for several seconds — long enough that never seeing it would mean the
      // reading is wrong, not that the machine was quick.
      expect(observed.length, 'the removed job was never observed on its way out').toBeGreaterThan(0);
      expect(observed.every((status) => /Deleting|Deleted/i.test(status))).toBe(true);
      expect(observed.map((status) => classifyJobStatus(status))).toEqual(
        observed.map(() => 'cancelled'),
      );
    }, SLOW);
  },
);

// ── say what was skipped, and why ────────────────────────────────────────────

const skipped: string[] = [];
if (reality.skip) {
  skipped.push(`every real-spooler test: ${reality.skip}`);
} else {
  if (!reality.hasPdfTarget) {
    skipped.push(
      `the submission tests: "${PDF_TARGET}" is not installed, and it is the only printer ` +
        'that can be driven non-interactively without wasting paper',
    );
  }
  if (reality.pauseSkip) skipped.push(`the induced-fault tests: ${reality.pauseSkip}`);
}
if (skipped.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(`\n[print.real] skipped on this machine:\n  - ${skipped.join('\n  - ')}\n`);
}
