import { readdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrintJobStatus } from '@localcast/contract';
import { createPrintModule } from '../../src/modules/print/index.js';
import type { ExecFileFn, ExecOptions } from '../../src/modules/print/exec.js';
import { POWERSHELL, powershellArgs } from '../../src/modules/print/exec.js';
import {
  GET_PRINTERS_SCRIPT,
  parsePowerShellJson,
  parsePrinters,
  syncPrinters,
} from '../../src/modules/print/enumerate.js';
import {
  assertFallbackCanHonour,
  assertFallbackCanPrintType,
  buildPrintSettings,
  buildSumatraArgs,
  classifyJobStatus,
  listSpoolerJobs,
  LIST_JOBS_SCRIPT,
  PRINT_TO_PROBE_SCRIPT,
  PRINT_TO_SCRIPT,
  probePrintTo,
} from '../../src/modules/print/spooler.js';
import { assertPrintable } from '../../src/modules/print/routes.js';
import type { ServerModule } from '../../src/kernel.js';
import type { Harness, TestServer } from './support/context.js';
import { createHarness } from './support/context.js';

// ── the fake Windows boundary ────────────────────────────────────────────────

interface ExecCall {
  file: string;
  args: string[];
  script: string | null;
  env: NodeJS.ProcessEnv | undefined;
}

interface SpoolerJobJson {
  Id: number;
  DocumentName?: string;
  JobStatus: string;
}

interface FakeOptions {
  printersJson?: string;
  printersFails?: boolean;
  /** One entry per `Get-PrintJob`; the last is repeated once the list runs out. */
  spooler?: SpoolerJobJson[][];
  /** `Get-PrintJob` throws, which is a queue that could not be read — not an empty one. */
  spoolerUnreadable?: boolean;
  onSubmit?: () => Promise<void> | void;
  submitFails?: boolean;
  /** The shell has no `PrintTo` handler for the type, so `Start-Process` throws. */
  printToFails?: boolean;
  /** What the registry probe finds: a ProgId carrying `printto`, or nothing. */
  printToProgId?: string | null;
  /** The registry could not be read at all, which is not the same as "no handler". */
  printToProbeFails?: boolean;
}

function createFakeExec(options: FakeOptions = {}): { exec: ExecFileFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const spooler = [...(options.spooler ?? [[]])];

  const exec: ExecFileFn = async (file, args, execOptions: ExecOptions = {}) => {
    const list = [...args];
    const script = file === POWERSHELL ? (list[list.length - 1] ?? null) : null;
    calls.push({ file, args: list, script, env: execOptions.env });

    if (script?.includes('Remove-PrintJob')) return { stdout: '', stderr: '' };

    // The registry lookup that decides whether the shell can print this type at all.
    if (script?.includes('shell\\printto')) {
      if (options.printToProbeFails) throw new Error('Cannot find path HKCU:\\Software\\...');
      const progId = options.printToProgId === undefined ? 'pdffile' : options.printToProgId;
      return {
        stdout: JSON.stringify({ ProgId: progId ?? '', PrintTo: progId !== null }),
        stderr: '',
      };
    }

    if (script?.includes('Get-PrintJob')) {
      if (options.spoolerUnreadable) throw new Error('The specified printer was not found.');
      const next = spooler.length > 1 ? spooler.shift() : spooler[0];
      return { stdout: JSON.stringify(next ?? []), stderr: '' };
    }

    if (script?.includes('Get-Printer ')) {
      if (options.printersFails) throw new Error('Get-Printer is not recognized');
      return { stdout: options.printersJson ?? '[]', stderr: '' };
    }

    // The helper-free fallback: `Start-Process -Verb PrintTo`.
    if (script?.includes('Start-Process')) {
      await options.onSubmit?.();
      if (options.printToFails) {
        throw new Error('This file does not have an app associated with it for this action.');
      }
      return { stdout: '', stderr: '' };
    }

    // Anything else is SumatraPDF.
    await options.onSubmit?.();
    if (options.submitFails) throw new Error('SumatraPDF exited with 1');
    return { stdout: '', stderr: '' };
  };

  return { exec, calls };
}

// ── unit level ───────────────────────────────────────────────────────────────

describe('PowerShell JSON parsing', () => {
  it('accepts a bare object, because that is what one printer produces', () => {
    // `ConvertTo-Json` only emits an array when the pipeline had more than one item, so a
    // machine with a single printer is the case a naive parser reports as "no printers".
    const single = parsePrinters(
      JSON.stringify({ Name: 'Office Laser', Driver: 'HP', Status: 'Normal', Online: true }),
    );
    expect(single).toHaveLength(1);
    expect(single[0]?.name).toBe('Office Laser');
  });

  it('accepts an array', () => {
    const many = parsePrinters(
      JSON.stringify([
        { Name: 'A', IsDefault: true, Color: true, Duplex: false, Status: 'Normal', Online: true },
        { Name: 'B', IsDefault: false, Status: 'Offline', Online: false },
      ]),
    );
    expect(many.map((p) => p.name)).toEqual(['A', 'B']);
    expect(many[0]?.isDefault).toBe(true);
    expect(many[1]?.online).toBe(false);
  });

  it('treats empty output and a JSON null as no printers', () => {
    expect(parsePowerShellJson('')).toEqual([]);
    expect(parsePowerShellJson('   ')).toEqual([]);
    expect(parsePowerShellJson('null')).toEqual([]);
  });

  it('drops a row with no usable name rather than writing it', () => {
    expect(parsePrinters(JSON.stringify([{ Name: '' }, { Driver: 'x' }, { Name: 'Good' }]))).toEqual(
      [expect.objectContaining({ name: 'Good' })],
    );
  });

  it('asks PowerShell for JSON with the flags that make output predictable', () => {
    const args = powershellArgs(GET_PRINTERS_SCRIPT);
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ]);
    expect(args[5]).toContain('Get-Printer');
    expect(args[5]).toContain('ConvertTo-Json');
    expect(args[5]).toContain('OutputEncoding');
  });
});

describe('print settings', () => {
  it('maps the request onto SumatraPDF switches', () => {
    expect(buildPrintSettings({ copies: 1, color: 'mono', duplex: 'simplex' })).toBe(
      'monochrome,simplex',
    );
    expect(buildPrintSettings({ copies: 3, color: 'color', duplex: 'long' })).toBe(
      'color,duplexlong,3x',
    );
    expect(
      buildPrintSettings({ copies: 1, color: 'mono', duplex: 'short', pageRange: '1-4, 7' }),
    ).toBe('1-4,7,monochrome,duplexshort');
  });

  it('refuses a page range it cannot vouch for', () => {
    // A malformed range makes SumatraPDF print the whole document, which on 400 pages is an
    // expensive way to discover the mistake.
    expect(() => buildPrintSettings({ copies: 1, color: 'mono', duplex: 'simplex', pageRange: 'all' })).toThrow(
      /Page range/,
    );
    expect(() =>
      buildPrintSettings({ copies: 1, color: 'mono', duplex: 'simplex', pageRange: '1;2' }),
    ).toThrow();
  });

  it('builds an argument array, never a command line', () => {
    const args = buildSumatraArgs({
      sumatraPath: 'C:/vendor/SumatraPDF.exe',
      printerName: 'HP "Big" & Loud',
      settings: 'color,simplex',
      filePath: 'C:/temp/a b.pdf',
    });
    expect(args).toEqual([
      '-print-to',
      'HP "Big" & Loud',
      '-print-settings',
      'color,simplex',
      '-silent',
      '-exit-when-done',
      'C:/temp/a b.pdf',
    ]);
  });
});

describe('spooler status', () => {
  it('reads the flag list Windows actually returns', () => {
    expect(classifyJobStatus('Printing')).toBe('printing');
    expect(classifyJobStatus('Spooling, Retained')).toBe('printing');
    expect(classifyJobStatus('Error, Offline')).toBe('error');
    expect(classifyJobStatus('PaperOut')).toBe('error');
    expect(classifyJobStatus('Deleting')).toBe('cancelled');
    expect(classifyJobStatus('Printed')).toBe('done');
  });

  it('asks PowerShell to stringify JobStatus, because ConvertTo-Json emits the raw enum', () => {
    // Observed against the real spooler: without the cast a spooling job serialises as
    // {"Id":6,"JobStatus":8} and a printing one as 8216, and every status then classifies as
    // "still printing" — so a jammed printer looked healthy until the ten-minute timeout.
    expect(LIST_JOBS_SCRIPT).toContain('[string]$_.JobStatus');
    expect(LIST_JOBS_SCRIPT).not.toContain('Select-Object Id,DocumentName,JobStatus');
  });

  it('still classifies the raw integer bitmask correctly', () => {
    // The exact values captured from Get-PrintJob on this machine.
    expect(classifyJobStatus('8')).toBe('printing'); // Spooling
    expect(classifyJobStatus('8208')).toBe('printing'); // Printing, Retained
    expect(classifyJobStatus('8216')).toBe('printing'); // Spooling, Printing, Retained
    // …and the outcomes that used to be invisible.
    expect(classifyJobStatus('2')).toBe('error'); // Error
    expect(classifyJobStatus('64')).toBe('error'); // PaperOut
    expect(classifyJobStatus('512')).toBe('error'); // Blocked
    expect(classifyJobStatus('4')).toBe('cancelled'); // Deleting
    expect(classifyJobStatus('128')).toBe('done'); // Printed
    expect(classifyJobStatus('4096')).toBe('done'); // Complete
    expect(classifyJobStatus('0')).toBe('printing'); // Normal
  });

  it('tells an empty queue apart from one it could not read', async () => {
    const empty: ExecFileFn = async () => ({ stdout: '', stderr: '' });
    await expect(listSpoolerJobs(empty, 'Whatever')).resolves.toEqual({
      readable: true,
      jobs: [],
    });

    const broken: ExecFileFn = async () => {
      throw new Error('The specified printer was not found.');
    };
    await expect(listSpoolerJobs(broken, 'Whatever')).resolves.toEqual({
      readable: false,
      jobs: [],
    });
  });
});

describe('the helper-free fallback', () => {
  it('accepts a plain single-copy job', () => {
    expect(() =>
      assertFallbackCanHonour({ copies: 1, color: 'mono', duplex: 'simplex' }, 'C:/vendor'),
    ).not.toThrow();
    // Colour alone is not refused: PrintTo uses the printer's own default, which is the
    // closest honest answer and cannot print the wrong number of pages.
    expect(() =>
      assertFallbackCanHonour({ copies: 1, color: 'color', duplex: 'simplex' }, 'C:/vendor'),
    ).not.toThrow();
  });

  it.each([
    [{ copies: 2, color: 'mono', duplex: 'simplex' } as const, /more than one copy/],
    [{ copies: 1, color: 'mono', duplex: 'long' } as const, /double-sided/],
    [{ copies: 1, color: 'mono', duplex: 'simplex', pageRange: '2-3' } as const, /page range/],
  ])('refuses what PrintTo cannot express: %o', (input, pattern) => {
    expect(() => assertFallbackCanHonour(input, 'C:/vendor')).toThrow(pattern);
    // The message has to name the helper, because installing it is the fix.
    expect(() => assertFallbackCanHonour(input, 'C:/vendor')).toThrow(/SumatraPDF\.exe/);
  });

  it('passes the printer and path as environment data, never as script text', () => {
    expect(PRINT_TO_SCRIPT).toContain('$env:LC_PRINTER');
    expect(PRINT_TO_SCRIPT).toContain('$env:LC_FILE');
    expect(PRINT_TO_SCRIPT).toContain('-Verb PrintTo');
  });
});

describe('the PrintTo handler probe', () => {
  function probeExec(stdout: string): { exec: ExecFileFn; seen: ExecCall[] } {
    const seen: ExecCall[] = [];
    const exec: ExecFileFn = async (file, args, execOptions: ExecOptions = {}) => {
      const list = [...args];
      seen.push({ file, args: list, script: list[list.length - 1] ?? null, env: execOptions.env });
      return { stdout, stderr: '' };
    };
    return { exec, seen };
  }

  it('reads the extension from the environment, never from the script text', async () => {
    const { exec, seen } = probeExec('{"ProgId":"pngfile","PrintTo":true}');
    await probePrintTo(exec, '.PNG');
    expect(seen[0]?.env?.['LC_EXT']).toBe('.png');
    expect(seen[0]?.script).toContain('$env:LC_EXT');
    expect(seen[0]?.script).not.toContain('.png');
    expect(PRINT_TO_PROBE_SCRIPT).toContain('shell\\printto');
  });

  it('reports a registered handler with the ProgId that carries it', async () => {
    const { exec } = probeExec('{"ProgId":"Acrobat.Document.DC","PrintTo":true}');
    await expect(probePrintTo(exec, '.pdf')).resolves.toEqual({
      ext: '.pdf',
      registered: true,
      progId: 'Acrobat.Document.DC',
      known: true,
    });
  });

  it('reports .bmp as unregistered, which is what the registry actually says', async () => {
    // Measured on the reference machine: `.bmp` resolves to `Paint.Picture`, which has no
    // `printto` verb, so PrintTo cannot print a bitmap even though LocalCast accepts one.
    const { exec } = probeExec('{"ProgId":"","PrintTo":false}');
    await expect(probePrintTo(exec, '.bmp')).resolves.toEqual({
      ext: '.bmp',
      registered: false,
      progId: null,
      known: true,
    });
  });

  it('refuses a file name that is not an extension instead of building a registry path', async () => {
    const { exec, seen } = probeExec('{"ProgId":"x","PrintTo":true}');
    // `..\\..` in the place of an extension would walk to another key. It never gets there.
    await expect(probePrintTo(exec, '.\\..\\..\\evil')).resolves.toMatchObject({
      registered: false,
      known: true,
    });
    expect(seen).toEqual([]);
  });

  it('says it does not know when the registry could not be read', async () => {
    const exec: ExecFileFn = async () => {
      throw new Error('powershell.exe is not recognized');
    };
    // known:false, not registered:false — an unanswerable question must not become a refusal.
    await expect(probePrintTo(exec, '.pdf')).resolves.toEqual({
      ext: '.pdf',
      registered: false,
      progId: null,
      known: false,
    });
  });

  it('refuses only what it positively knows has no handler', () => {
    const base = { ext: '.bmp', progId: null };
    expect(() =>
      assertFallbackCanPrintType({ ...base, registered: false, known: true }, 'C:/vendor'),
    ).toThrow(/no application registered to print \.bmp/);
    expect(() =>
      assertFallbackCanPrintType({ ...base, registered: false, known: true }, 'C:/vendor'),
    ).toThrow(/SumatraPDF\.exe/);

    // Registered, or unknown: both go ahead and let Windows answer for itself.
    expect(() =>
      assertFallbackCanPrintType({ ...base, registered: true, known: true }, 'C:/vendor'),
    ).not.toThrow();
    expect(() =>
      assertFallbackCanPrintType({ ...base, registered: false, known: false }, 'C:/vendor'),
    ).not.toThrow();
  });

  it('gives PDFs their own reason, because their fix is a different sentence', () => {
    expect(() =>
      assertFallbackCanPrintType(
        { ext: '.pdf', registered: false, progId: null, known: true },
        'C:/vendor',
      ),
    ).toThrow(/Edge, the default PDF viewer/);
  });
});

describe('printer enumeration script', () => {
  it('consults WorkOffline, not just PrinterStatus', () => {
    // Observed on a real machine: an HP that Windows lists as Offline still reports
    // PrinterStatus = Normal. Reading only the status advertised it as online.
    expect(GET_PRINTERS_SCRIPT).toContain('WorkOffline');
  });

  it('maps a printer Windows calls offline via the flag alone', () => {
    const rows = parsePrinters(
      JSON.stringify([
        { Name: 'Working', Status: 'Normal', Online: true },
        // What the fixed script emits for the WorkOffline case.
        { Name: 'Unplugged', Status: 'Offline', Online: false },
      ]),
    );
    expect(rows).toEqual([
      expect.objectContaining({ name: 'Working', online: true, status: 'Normal' }),
      expect.objectContaining({ name: 'Unplugged', online: false, status: 'Offline' }),
    ]);
  });
});

describe('printable types', () => {
  it.each(['a.pdf', 'b.PDF', 'c.jpg', 'd.png', 'e.tiff'])('accepts %s', (name) => {
    expect(() => assertPrintable(name)).not.toThrow();
  });

  it('rejects .docx with a message that says what to do instead', () => {
    expect(() => assertPrintable('report.docx')).toThrow(/Export the file to PDF/);
  });

  it.each(['x.xlsx', 'y.pptx', 'z.rtf', 'w.odt'])('rejects %s as an Office format', (name) => {
    expect(() => assertPrintable(name)).toThrow(/Office documents/);
  });

  it('rejects a type nobody could print', () => {
    expect(() => assertPrintable('movie.mkv')).toThrow(/Only PDF and image/);
  });
});

// ── over HTTP, with a real database ──────────────────────────────────────────

let harness: Harness;
let server: TestServer;
let modul: ServerModule;
let deviceId: string;
let folderId: string;
let printerId: string;
let printerName: string;
let pdfId: string;

async function boot(options: FakeOptions & { withBinary?: boolean } = {}): Promise<ExecCall[]> {
  const { exec, calls } = createFakeExec(options);
  if (options.withBinary !== false) {
    await writeFile(`${harness.ctx.paths.vendorDir}/SumatraPDF.exe`, 'not really a binary');
  }
  modul = createPrintModule({ exec, pollIntervalMs: 0, discoverAttempts: 3, cacheTtlMs: 60_000 });
  server = await harness.serve([modul]);
  return calls;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.url}/api/v1${path}`, {
    ...init,
    headers: { 'x-test-device': deviceId, ...(init.headers ?? {}) },
  });
}

function printJson(body: unknown): Promise<Response> {
  return api('/print', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function statusOf(jobId: string): PrintJobStatus {
  const row = harness.ctx.db.prepare(`SELECT status FROM print_jobs WHERE id = ?`).get(jobId) as
    | { status: PrintJobStatus }
    | undefined;
  if (!row) throw new Error(`no job ${jobId}`);
  return row.status;
}

function errorOf(jobId: string): string | null {
  const row = harness.ctx.db
    .prepare(`SELECT error_message FROM print_jobs WHERE id = ?`)
    .get(jobId) as { error_message: string | null } | undefined;
  return row?.error_message ?? null;
}

async function settle(jobId: string, expected: PrintJobStatus): Promise<void> {
  await vi.waitFor(() => expect(statusOf(jobId)).toBe(expected), { timeout: 4000, interval: 5 });
}

beforeEach(async () => {
  harness = await createHarness();
  await writeFile(`${harness.ctx.paths.vendorDir}/.keep`, '').catch(() => undefined);
  deviceId = harness.addDevice().id;
  folderId = harness.addFolder({ label: 'Docs', kind: 'documents' }).id;
  harness.grant(deviceId, folderId, 'full');
  pdfId = await harness.putFile(folderId, 'invoice.pdf', Buffer.from('%PDF-1.7 fake'));
  const printer = harness.addPrinter({ name: 'Office Laser' });
  printerId = printer.id;
  printerName = printer.name;
});

afterEach(async () => {
  await modul?.dispose?.();
  await harness.cleanup();
});

describe('GET /printers', () => {
  it('lists only the printers the operator left enabled', async () => {
    harness.addPrinter({ name: 'Hidden Plotter', enabled: false });
    await boot();
    const body = (await (await api('/printers')).json()) as { printers: { name: string }[] };
    expect(body.printers.map((p) => p.name)).toEqual(['Office Laser']);
  });

  it('re-enumerates when the cache is stale and keeps the hide flag across the refresh', async () => {
    harness.ctx.db
      .prepare(`UPDATE printers SET enabled = 0, last_seen_at = 0 WHERE id = ?`)
      .run(printerId);

    await boot({
      printersJson: JSON.stringify({
        Name: 'Office Laser',
        Driver: 'HP Universal',
        Status: 'Normal',
        IsDefault: true,
        Color: true,
        Duplex: true,
        Online: true,
      }),
    });

    const body = (await (await api('/printers')).json()) as { printers: unknown[] };
    // The refresh ran and updated the driver…
    const row = harness.ctx.db.prepare(`SELECT * FROM printers WHERE id = ?`).get(printerId) as {
      driver: string;
      enabled: number;
    };
    expect(row.driver).toBe('HP Universal');
    // …but did not undo the operator hiding it.
    expect(row.enabled).toBe(0);
    expect(body.printers).toHaveLength(0);
  });

  it('keeps the last known list when PowerShell fails', async () => {
    harness.ctx.db.prepare(`UPDATE printers SET last_seen_at = 0`).run();
    await boot({ printersFails: true });
    const body = (await (await api('/printers')).json()) as { printers: unknown[] };
    expect(body.printers).toHaveLength(1);
    expect(harness.logs.some((entry) => entry.msg.includes('enumeration failed'))).toBe(true);
  });

  it('marks a printer that vanished from Windows offline instead of deleting it', () => {
    syncPrinters(harness.ctx.db, [{ name: 'Only Me', driver: null, status: 'Normal', isDefault: false, color: false, duplex: false, online: true }], 5_000);
    const rows = harness.ctx.db
      .prepare(`SELECT name, online FROM printers ORDER BY name`)
      .all() as { name: string; online: number }[];
    expect(rows).toEqual([
      { name: 'Office Laser', online: 0 },
      { name: 'Only Me', online: 1 },
    ]);
  });
});

describe('POST /print', () => {
  it('runs a job all the way to done, and done means the spooler said so', async () => {
    const calls = await boot({
      spooler: [
        [], // before submitting
        [{ Id: 42, JobStatus: 'Spooling' }], // discovery
        [{ Id: 42, JobStatus: 'Printing' }], // still going
        [], // gone from the queue → done
      ],
    });

    const res = await printJson({ printerId, source: { kind: 'library', fileId: pdfId }, copies: 2 });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: { id: string; status: string } };
    expect(job.status).toBe('queued');

    await settle(job.id, 'done');

    const row = harness.ctx.db.prepare(`SELECT * FROM print_jobs WHERE id = ?`).get(job.id) as {
      windows_job_id: number;
      started_at: number;
      finished_at: number;
    };
    expect(row.windows_job_id).toBe(42);
    expect(row.started_at).toBeGreaterThan(0);
    expect(row.finished_at).toBeGreaterThan(0);

    // The exit code of the helper was never the thing that decided it.
    const submit = calls.find((call) => call.file.endsWith('SumatraPDF.exe'));
    expect(submit?.args).toContain('-silent');
    expect(submit?.args).toContain('monochrome,simplex,2x');
  });

  it('publishes an event on every transition', async () => {
    await boot({ spooler: [[], [{ Id: 7, JobStatus: 'Printing' }], []] });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await settle(job.id, 'done');

    const statuses = harness.events
      .filter((event) => event.type === 'print-job')
      .map((event) => (event as { job: { status: string } }).job.status);
    expect(statuses).toEqual(['queued', 'printing', 'done']);
  });

  it('copies the source into the temp directory and removes the copy afterwards', async () => {
    await boot({
      spooler: [[], [{ Id: 3, JobStatus: 'Printing' }], []],
      onSubmit: async () => {
        const spooled = (await readdir(harness.ctx.paths.tempDir)).filter((name) =>
          name.startsWith('print-'),
        );
        expect(spooled).toHaveLength(1);
        expect(spooled[0]).toMatch(/\.pdf$/);
      },
    });

    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await settle(job.id, 'done');

    const left = (await readdir(harness.ctx.paths.tempDir)).filter((name) =>
      name.startsWith('print-'),
    );
    expect(left).toEqual([]);
  });

  it('passes the printer name through the environment, never inside the script', async () => {
    harness.ctx.db
      .prepare(`UPDATE printers SET name = ? WHERE id = ?`)
      .run("Evil'; Remove-Item C:\\ -Recurse #", printerId);

    const calls = await boot({ spooler: [[], [{ Id: 1, JobStatus: 'Printing' }], []] });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await settle(job.id, 'done');

    const jobQueries = calls.filter((call) => call.script?.includes('Get-PrintJob'));
    expect(jobQueries.length).toBeGreaterThan(0);
    for (const call of jobQueries) {
      expect(call.script).not.toContain('Remove-Item');
      expect(call.env?.['LC_PRINTER']).toBe("Evil'; Remove-Item C:\\ -Recurse #");
    }
  });

  it('rejects a .docx with UNPRINTABLE_TYPE rather than half-printing it', async () => {
    const docxId = await harness.putFile(folderId, 'contract.docx', 'PK fake');
    await boot();
    const res = await printJson({ printerId, source: { kind: 'library', fileId: docxId } });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unprintable_type');
    expect(body.error.message).toMatch(/Export the file to PDF/);
    // Nothing was queued.
    expect(harness.ctx.db.prepare(`SELECT COUNT(*) AS n FROM print_jobs`).get()).toEqual({ n: 0 });
  });

  it('prints through the shell PrintTo verb when the helper is missing', async () => {
    // Windows registers `printto` for images itself, and PDF readers register it for PDFs, so
    // a missing SumatraPDF is no longer a dead end for a plain one-copy job.
    const calls = await boot({
      withBinary: false,
      spooler: [[], [{ Id: 31, JobStatus: 'Printing' }], []],
    });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };

    await settle(job.id, 'done');
    const printTo = calls.find((call) => call.script?.includes('Start-Process'));
    expect(printTo?.script).toContain('-Verb PrintTo');
    // Same rule as everywhere else: the printer name and path are data, not script text.
    expect(printTo?.script).not.toContain(printerName);
    expect(printTo?.env?.['LC_PRINTER']).toBe(printerName);
    expect(printTo?.env?.['LC_FILE']).toMatch(/print-.*\.pdf$/);
  });

  it.each([
    [{ copies: 2 }, /more than one copy/],
    [{ duplex: 'long' as const }, /double-sided printing/],
    [{ pageRange: '2-3' }, /a page range/],
  ])(
    'refuses %o without the helper, naming what is missing and printing nothing',
    async (extra, pattern) => {
      // `PrintTo` takes a file and a printer and nothing else. Printing one copy when two
      // were asked for, or 400 pages when page 3 was asked for, is worse than saying so.
      // Asserted through HTTP rather than only on the pure function, because the thing that
      // matters is that the *job* refuses — the comment on the pure function proves nothing
      // about whether anything calls it.
      const calls = await boot({ withBinary: false });
      const { job } = (await (
        await printJson({ printerId, source: { kind: 'library', fileId: pdfId }, ...extra })
      ).json()) as { job: { id: string } };

      await settle(job.id, 'error');
      expect(errorOf(job.id)).toMatch(pattern);
      expect(errorOf(job.id)).toMatch(/SumatraPDF\.exe/);
      expect(errorOf(job.id)).toMatch(/Nothing was sent to the printer/);
      expect(statusOf(job.id)).not.toBe('done');
      // Not "refused after submitting": the shell was never asked to print anything.
      expect(calls.some((call) => call.script?.includes('Start-Process'))).toBe(false);
    },
  );

  it('refuses a .bmp without the helper, because no ProgId registers printto for it', async () => {
    // Observed in the registry on the reference machine: `.bmp` → `Paint.Picture`, which has
    // no `printto` verb. Attempting it anyway fails after the spool copy exists, with a
    // message from the shell that names neither the type nor the fix.
    const bmpId = await harness.putFile(folderId, 'scan.bmp', Buffer.from('BM fake'));
    const calls = await boot({ withBinary: false, printToProgId: null });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: bmpId } })
    ).json()) as { job: { id: string } };

    await settle(job.id, 'error');
    expect(errorOf(job.id)).toMatch(/no application registered to print \.bmp/);
    expect(errorOf(job.id)).toMatch(/SumatraPDF\.exe/);
    expect(calls.some((call) => call.script?.includes('Start-Process'))).toBe(false);
    // The spool copy is not left behind by the refusal.
    expect((await readdir(harness.ctx.paths.tempDir)).filter((n) => n.startsWith('print-'))).toEqual(
      [],
    );
  });

  it('refuses a PDF on a machine where only Edge handles PDFs', async () => {
    const calls = await boot({ withBinary: false, printToProgId: null });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };

    await settle(job.id, 'error');
    expect(errorOf(job.id)).toMatch(/No PDF reader on this machine/);
    expect(calls.some((call) => call.script?.includes('Start-Process'))).toBe(false);
  });

  it('still tries when the registry could not be read, rather than refusing on a guess', async () => {
    // "I could not find out" is not "there is no handler". Turning one into the other would
    // refuse every job on a machine where the probe itself is broken.
    const calls = await boot({
      withBinary: false,
      printToProbeFails: true,
      spooler: [[], [{ Id: 44, JobStatus: 'Printing' }], []],
    });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };

    await settle(job.id, 'done');
    expect(calls.some((call) => call.script?.includes('Start-Process'))).toBe(true);
  });

  it('fails loudly when neither the helper nor a PrintTo handler exists', async () => {
    await boot({ withBinary: false, printToFails: true });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };

    await settle(job.id, 'error');
    expect(errorOf(job.id)).toMatch(/Windows could not print this file/);
    // The important half: it did not report success.
    expect(statusOf(job.id)).not.toBe('done');
  });

  it('does not call the fallback at all when the helper is present', async () => {
    const calls = await boot({ spooler: [[], [{ Id: 32, JobStatus: 'Printing' }], []] });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await settle(job.id, 'done');
    expect(calls.some((call) => call.script?.includes('Start-Process'))).toBe(false);
  });

  it('reports the spooler message when the printer errors', async () => {
    await boot({ spooler: [[], [{ Id: 9, JobStatus: 'Error, PaperOut' }]] });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await settle(job.id, 'error');
    expect(errorOf(job.id)).toContain('Error, PaperOut');
  });

  it('404s an unknown printer and 403s a hidden one', async () => {
    const hidden = harness.addPrinter({ name: 'Hidden', enabled: false });
    await boot();
    expect((await printJson({ printerId: 'nope', source: { kind: 'library', fileId: pdfId } })).status).toBe(404);
    expect(
      (await printJson({ printerId: hidden.id, source: { kind: 'library', fileId: pdfId } })).status,
    ).toBe(403);
  });

  it('refuses to print from a `stream` folder', async () => {
    harness.grant(deviceId, folderId, 'stream');
    await boot();
    const res = await printJson({ printerId, source: { kind: 'library', fileId: pdfId } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('print_not_allowed');
  });

  it('404s a file in a folder the device cannot see', async () => {
    const closed = harness.addFolder({ label: 'Private' });
    harness.grant(deviceId, closed.id, 'none');
    const secretId = await harness.putFile(closed.id, 'secret.pdf', 'x');
    await boot();
    expect((await printJson({ printerId, source: { kind: 'library', fileId: secretId } })).status).toBe(404);
  });

  it('rejects a body the contract does not accept', async () => {
    await boot();
    const res = await printJson({ printerId, source: { kind: 'library' }, copies: 500 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request');
  });
});

describe('the queue', () => {
  it('runs one job at a time per printer and cancels a queued one outright', async () => {
    let release = (): void => {};
    const held = new Promise<void>((done) => {
      release = done;
    });

    await boot({
      spooler: [[], [{ Id: 11, JobStatus: 'Printing' }], []],
      onSubmit: () => held,
    });

    const first = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    const second = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };

    // The first has reached the printer; the second is still waiting behind it.
    await vi.waitFor(() => expect(statusOf(first.job.id)).toBe('printing'), { interval: 5 });
    expect(statusOf(second.job.id)).toBe('queued');

    const cancelled = await api(`/print/jobs/${second.job.id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(statusOf(second.job.id)).toBe('cancelled');

    release();
    await settle(first.job.id, 'done');
    // The cancelled job never went near the spooler.
    expect(statusOf(second.job.id)).toBe('cancelled');
    expect(
      harness.ctx.db.prepare(`SELECT windows_job_id FROM print_jobs WHERE id = ?`).get(second.job.id),
    ).toEqual({ windows_job_id: null });
  });

  it('asks the spooler to drop a job that is already printing', async () => {
    let release = (): void => {};
    const held = new Promise<void>((done) => {
      release = done;
    });

    const calls = await boot({
      spooler: [[], [{ Id: 21, JobStatus: 'Printing' }], [{ Id: 21, JobStatus: 'Printing' }]],
      onSubmit: () => held,
    });

    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await vi.waitFor(() => expect(statusOf(job.id)).toBe('printing'), { interval: 5 });

    await api(`/print/jobs/${job.id}/cancel`, { method: 'POST' });
    release();

    await settle(job.id, 'cancelled');
    expect(calls.some((call) => call.script?.includes('Remove-PrintJob'))).toBe(true);
    expect(calls.find((call) => call.script?.includes('Remove-PrintJob'))?.env?.['LC_JOB_ID']).toBe('21');
  });

  it('catches a job that is only in the queue while it is being submitted', async () => {
    // The race, exactly. Measured on a real machine a one-page job is spooled, rendered and
    // gone in ~1.4 s while one `Get-PrintJob` costs ~0.9 s, so a discovery that only starts
    // after the submission returns finds an empty queue — no `windows_job_id`, nothing to
    // cancel, and an outcome that was assumed instead of read.
    let release = (): void => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    let submitting = false;
    let released = false;

    const exec: ExecFileFn = async (file, args) => {
      const script = file === POWERSHELL ? args[args.length - 1] ?? '' : '';
      if (script.includes('Get-PrintJob')) {
        // Visible only for the window in which the document is being handed to Windows.
        return submitting && !released
          ? { stdout: JSON.stringify([{ Id: 99, JobStatus: 'Spooling' }]), stderr: '' }
          : { stdout: '', stderr: '' };
      }
      if (script.includes('Get-Printer ')) return { stdout: '[]', stderr: '' };
      submitting = true;
      await held;
      released = true;
      return { stdout: '', stderr: '' };
    };

    await writeFile(`${harness.ctx.paths.vendorDir}/SumatraPDF.exe`, 'not really a binary');
    modul = createPrintModule({ exec, pollIntervalMs: 1, discoverAttempts: 3 });
    server = await harness.serve([modul]);

    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };

    await vi.waitFor(() => expect(statusOf(job.id)).toBe('printing'), { interval: 5 });
    release();
    await settle(job.id, 'done');

    // Found while it was in flight, rather than assumed after it had gone.
    expect(
      harness.ctx.db.prepare(`SELECT windows_job_id FROM print_jobs WHERE id = ?`).get(job.id),
    ).toEqual({ windows_job_id: 99 });
  });

  it('does not call a job done when the queue stopped answering', async () => {
    // An empty `Get-PrintJob` and a failing one used to be the same empty array, and an
    // absent job is read as a finished one — so a dead spooler reported a successful print.
    let calls = 0;
    const exec: ExecFileFn = async (file, args) => {
      const script = file === POWERSHELL ? args[args.length - 1] ?? '' : '';
      if (script.includes('Get-PrintJob')) {
        calls += 1;
        // 1: the queue before submitting. 2: discovery finds the new job. Then the spooler
        // goes away, which must not be mistaken for the job having finished.
        if (calls === 1) return { stdout: '', stderr: '' };
        if (calls === 2) {
          return { stdout: JSON.stringify([{ Id: 77, JobStatus: 'Printing' }]), stderr: '' };
        }
        throw new Error('The specified printer was not found.');
      }
      if (script.includes('Get-Printer ')) return { stdout: '[]', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    await writeFile(`${harness.ctx.paths.vendorDir}/SumatraPDF.exe`, 'not really a binary');
    modul = createPrintModule({ exec, pollIntervalMs: 0, discoverAttempts: 3 });
    server = await harness.serve([modul]);

    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };

    await settle(job.id, 'error');
    expect(errorOf(job.id)).toMatch(/stopped responding/);
  });

  it('refuses to cancel a job that has already finished', async () => {
    await boot({ spooler: [[], [{ Id: 5, JobStatus: 'Printing' }], []] });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await settle(job.id, 'done');
    expect((await api(`/print/jobs/${job.id}/cancel`, { method: 'POST' })).status).toBe(400);
  });

  it('hides another device`s jobs behind a 404', async () => {
    await boot({ spooler: [[], [{ Id: 6, JobStatus: 'Printing' }], []] });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await settle(job.id, 'done');

    const other = harness.addDevice({ name: 'Laptop' });
    const res = await fetch(`${server.url}/api/v1/print/jobs/${job.id}`, {
      headers: { 'x-test-device': other.id },
    });
    expect(res.status).toBe(404);
    expect((await (await api('/print/jobs')).json()) as unknown).toMatchObject({
      jobs: [{ id: job.id, status: 'done', printerName }],
    });
  });

  it('closes out jobs stranded by a restart instead of leaving them spinning', async () => {
    await boot({ spooler: [[], [{ Id: 8, JobStatus: 'Printing' }], []] });
    const { job } = (await (
      await printJson({ printerId, source: { kind: 'library', fileId: pdfId } })
    ).json()) as { job: { id: string } };
    await settle(job.id, 'done');

    // Simulate a job the previous process left behind.
    harness.ctx.db.prepare(`UPDATE print_jobs SET status = 'printing' WHERE id = ?`).run(job.id);
    const second = createPrintModule({ exec: createFakeExec().exec, pollIntervalMs: 0 });
    await harness.serve([second]);

    expect(statusOf(job.id)).toBe('error');
    expect(errorOf(job.id)).toMatch(/restarted/);
    await second.dispose?.();
  });
});
