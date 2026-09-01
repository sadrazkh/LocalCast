import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrintJobStatus } from '@localcast/contract';
import { defaultExecFile, POWERSHELL, powershellArgs } from '../../src/modules/print/exec.js';
import type { ExecFileFn } from '../../src/modules/print/exec.js';
import { enumeratePrinters } from '../../src/modules/print/enumerate.js';
import { classifyJobStatus, listSpoolerJobs } from '../../src/modules/print/spooler.js';
import { PrintQueue } from '../../src/modules/print/jobs.js';
import type { Harness } from './support/context.js';
import { createHarness } from './support/context.js';

/**
 * The print module against the actual Windows print spooler.
 *
 * Every other print test fakes the `execFile` boundary, which is the right way to test the
 * state machine but proves nothing about the two things only Windows can answer: what
 * `Get-Printer` and `Get-PrintJob` really put on stdout. Both turned out to differ from the
 * fakes — `JobStatus` arrives as an integer unless it is cast, and `PrinterStatus` says
 * `Normal` for a printer Windows itself calls offline — so these run for real.
 *
 * They skip, loudly, off Windows or without a usable printer rather than passing vacuously.
 */

const exec = promisify(execFile);

const PDF_TARGET = 'Microsoft Print to PDF';

/** One `Get-PrintJob` through a fresh `powershell.exe` costs ~0.9 s on the reference machine. */
const SLOW = 180_000;

async function powershell(script: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await exec(POWERSHELL, powershellArgs(script), {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return stdout.trim();
}

interface Reality {
  windows: boolean;
  printers: string[];
  hasPdfTarget: boolean;
  reason: string;
}

async function probe(): Promise<Reality> {
  if (process.platform !== 'win32') {
    return { windows: false, printers: [], hasPdfTarget: false, reason: `not Windows (${process.platform})` };
  }
  try {
    const out = await powershell('(Get-Printer -ErrorAction Stop).Name -join "`n"');
    const printers = out.split(/\r?\n/).map((n) => n.trim()).filter(Boolean);
    return {
      windows: true,
      printers,
      hasPdfTarget: printers.includes(PDF_TARGET),
      reason: printers.length === 0 ? 'Get-Printer returned no printers' : '',
    };
  } catch (err) {
    return {
      windows: true,
      printers: [],
      hasPdfTarget: false,
      reason: `Get-Printer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

function submitRealJob(printer: string, outFile: string, pages: number, docName: string): Promise<string> {
  return powershell(SUBMIT_SCRIPT, {
    LC_PRINTER: printer,
    LC_OUTFILE: outFile,
    LC_PAGES: String(pages),
    LC_DOCNAME: docName,
  });
}

async function clearQueue(printer: string): Promise<void> {
  await powershell(
    'Get-PrintJob -PrinterName $env:LC_PRINTER -ErrorAction SilentlyContinue | ' +
      'ForEach-Object { Remove-PrintJob -PrinterName $env:LC_PRINTER -ID $_.Id -ErrorAction SilentlyContinue }',
    { LC_PRINTER: printer },
  ).catch(() => undefined);
}

// ── enumeration ──────────────────────────────────────────────────────────────

describe.skipIf(!reality.windows || reality.printers.length === 0)(
  'real Get-Printer enumeration',
  () => {
    it(`maps every field for all ${reality.printers.length} printers on this machine`, async () => {
      const printers = await enumeratePrinters(defaultExecFile);

      // The many-printer case: `ConvertTo-Json` emits a real array here, and every printer
      // Windows listed has to survive the round trip.
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

      // Windows has exactly one default printer, and so must we.
      expect(printers.filter((p) => p.isDefault)).toHaveLength(1);
    }, SLOW);

    it('agrees with Win32_Printer about the default and the capabilities', async () => {
      const raw = await powershell(
        'Get-CimInstance Win32_Printer | ForEach-Object { [pscustomobject]@{ ' +
          'Name=$_.Name; Default=[bool]$_.Default; WorkOffline=[bool]$_.WorkOffline; ' +
          "Color=[bool]($_.CapabilityDescriptions -contains 'Color'); " +
          "Duplex=[bool]($_.CapabilityDescriptions -contains 'Duplex') } } | ConvertTo-Json -Compress",
      );
      const truth = new Map(
        (JSON.parse(raw) as { Name: string; Default: boolean; WorkOffline: boolean; Color: boolean; Duplex: boolean }[])
          .map((row) => [row.Name, row]),
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
  },
);

// ── the queue, read back from the real spooler ───────────────────────────────

describe.skipIf(!reality.windows || reality.printers.length === 0)('real Get-PrintJob', () => {
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

describe.skipIf(!reality.windows || !reality.hasPdfTarget)('a real job through the real spooler', () => {
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
});

// ── the whole state machine, with the real spooler deciding ──────────────────

describe.skipIf(!reality.windows || !reality.hasPdfTarget)('PrintQueue against the real spooler', () => {
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
});

if (!reality.windows || reality.printers.length === 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `[print.real] real-spooler tests skipped: ${reality.reason || 'no printers'}. ` +
      'These only run on Windows with at least one installed printer.',
  );
}
