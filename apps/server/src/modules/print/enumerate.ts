import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { Printer } from '@localcast/contract';
import type { ExecFileFn } from './exec.js';
import { POWERSHELL, powershellArgs } from './exec.js';

/**
 * Printer enumeration.
 *
 * `Get-Printer` gives the list and the driver; `Win32_Printer` is where the default flag and
 * the colour/duplex capability descriptions live. Joining them in one script means one
 * PowerShell start-up (roughly 400 ms) per refresh instead of one per printer.
 */
export const GET_PRINTERS_SCRIPT = [
  '$w=@{};',
  "Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue | ForEach-Object { $w[$_.Name]=$_ };",
  'Get-Printer -ErrorAction Stop | ForEach-Object {',
  '$c=$w[$_.Name];',
  '$s=[string]$_.PrinterStatus;',
  // `PrinterStatus` alone is not enough. Measured on a real machine, an HP that Windows
  // itself lists as "Offline" still reports `PrinterStatus = Normal`; what Windows shows the
  // user is `Win32_Printer.WorkOffline`, the "Use Printer Offline" flag. Reading only the
  // status marked that printer online and invited jobs into a queue nothing would drain.
  '$wo=[bool]($c -and $c.WorkOffline);',
  "$off=[bool]($wo -or ($s -in @('Offline','Error','NotAvailable','ServerOffline')));",
  '[pscustomobject]@{',
  'Name=$_.Name;',
  'Driver=[string]$_.DriverName;',
  // Reporting "Normal" for a printer Windows calls offline is the same lie one level down,
  // so the flag wins over the enum in the text the user is shown too.
  "Status=[string]$(if($wo -and $s -eq 'Normal'){'Offline'}else{$s});",
  'IsDefault=[bool]($c -and $c.Default);',
  "Color=[bool]($c -and ($c.CapabilityDescriptions -contains 'Color'));",
  "Duplex=[bool]($c -and ($c.CapabilityDescriptions -contains 'Duplex'));",
  'Online=[bool](-not $off)',
  '}',
  '} | ConvertTo-Json -Compress',
].join('');

export interface RawPrinter {
  name: string;
  driver: string | null;
  status: string;
  isDefault: boolean;
  color: boolean;
  duplex: boolean;
  online: boolean;
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
  return false;
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * `ConvertTo-Json` emits a bare object, not a one-element array, when the pipeline produced
 * exactly one item — and a machine with one printer is the common case, not the edge case.
 * A parser that assumes an array reports "no printers found" on precisely the setup most
 * users have.
 */
export function parsePowerShellJson<T = unknown>(stdout: string): T[] {
  const text = stdout.trim();
  if (text === '' || text === 'null') return [];
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || parsed === undefined) return [];
  return (Array.isArray(parsed) ? parsed : [parsed]) as T[];
}

export function parsePrinters(stdout: string): RawPrinter[] {
  const rows = parsePowerShellJson<Record<string, unknown>>(stdout);
  const printers: RawPrinter[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = toText(row['Name']);
    // A row without a name cannot be keyed, matched or printed to; dropping it is the only
    // option that does not corrupt the table.
    if (!name || name.trim() === '') continue;
    printers.push({
      name,
      driver: toText(row['Driver']),
      status: toText(row['Status']) ?? 'Unknown',
      isDefault: toBool(row['IsDefault']),
      color: toBool(row['Color']),
      duplex: toBool(row['Duplex']),
      online: toBool(row['Online']),
    });
  }
  return printers;
}

export async function enumeratePrinters(exec: ExecFileFn): Promise<RawPrinter[]> {
  const { stdout } = await exec(POWERSHELL, powershellArgs(GET_PRINTERS_SCRIPT), {
    timeoutMs: 20_000,
  });
  return parsePrinters(stdout);
}

/**
 * Writes the enumeration into `printers`.
 *
 * `enabled` is deliberately absent from the update: it is the operator's hide flag, and a
 * refresh — which happens on a timer and on every stale read — must never un-hide a printer
 * they took out of the list on purpose.
 */
export function syncPrinters(db: Database, printers: readonly RawPrinter[], now: number): void {
  const upsert = db.prepare(
    `INSERT INTO printers
       (id, name, driver, is_default, color_capable, duplex_capable, status, online, enabled, last_seen_at)
     VALUES (@id, @name, @driver, @isDefault, @color, @duplex, @status, @online, 1, @now)
     ON CONFLICT(name) DO UPDATE SET
       driver         = excluded.driver,
       is_default     = excluded.is_default,
       color_capable  = excluded.color_capable,
       duplex_capable = excluded.duplex_capable,
       status         = excluded.status,
       online         = excluded.online,
       last_seen_at   = excluded.last_seen_at`,
  );
  // A printer that vanished from Windows is marked offline rather than deleted: `print_jobs`
  // references it with ON DELETE RESTRICT, and a device's history should not disappear
  // because someone unplugged a USB printer for an afternoon.
  const markMissing = db.prepare(`UPDATE printers SET online = 0 WHERE last_seen_at <> ?`);

  db.transaction(() => {
    for (const printer of printers) {
      upsert.run({
        id: randomUUID(),
        name: printer.name,
        driver: printer.driver,
        isDefault: printer.isDefault ? 1 : 0,
        color: printer.color ? 1 : 0,
        duplex: printer.duplex ? 1 : 0,
        status: printer.status,
        online: printer.online ? 1 : 0,
        now,
      });
    }
    markMissing.run(now);
  })();
}

export interface PrinterRow {
  id: string;
  name: string;
  driver: string | null;
  is_default: number;
  color_capable: number;
  duplex_capable: number;
  status: string | null;
  online: number;
  enabled: number;
  last_seen_at: number;
}

export function toPrinterDto(row: PrinterRow): Printer {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default === 1,
    colorCapable: row.color_capable === 1,
    duplexCapable: row.duplex_capable === 1,
    status: row.status ?? 'Unknown',
    online: row.online === 1,
  };
}

/** Only printers the operator has not hidden. */
export function listEnabledPrinters(db: Database): PrinterRow[] {
  return db
    .prepare(`SELECT * FROM printers WHERE enabled = 1 ORDER BY is_default DESC, name`)
    .all() as PrinterRow[];
}

export function newestPrinterSeenAt(db: Database): number | null {
  const row = db.prepare(`SELECT MAX(last_seen_at) AS seen FROM printers`).get() as
    | { seen: number | null }
    | undefined;
  return row?.seen ?? null;
}
