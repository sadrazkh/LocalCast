import { Router } from 'express';
import { z } from 'zod';
import { ApiException, ErrorCode, type Printer } from '@localcast/contract';
import type { ServerContext } from '../../kernel.js';
import { wrap } from '../errors.js';

/**
 * The operator's view of the printer table.
 *
 * The device API lists only printers the operator left enabled; this one lists every printer
 * Windows reported, hidden ones included, because the hide switch is the thing the operator
 * came here to change. There is no second enumeration path: the PowerShell call belongs to
 * the print module and is borrowed from it.
 */

const patchPrinterSchema = z.object({ enabled: z.boolean() });

interface PrinterRow {
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

/** Richer than the contract's `Printer`: the operator also sees the hide flag and the driver. */
export interface PrinterAdminView extends Printer {
  driver: string | null;
  enabled: boolean;
  lastSeenAt: number;
}

export function createOperatorPrinterRouter(ctx: ServerContext): Router {
  const router = Router();
  const { db } = ctx;

  // A fresh install has never enumerated, so the first read fills the table once — otherwise
  // the panel's printer screen would be empty until someone found the refresh button. Once
  // per process and only while the table is empty: after that the list is whatever the last
  // enumeration wrote, and refreshing is an explicit action rather than something that starts
  // a PowerShell process every time a screen is opened.
  let firstReadDone = false;

  router.get(
    '/printers',
    wrap(async (_req, res) => {
      if (!firstReadDone && list(db).length === 0) {
        firstReadDone = true;
        await enumerate(ctx).catch((err: unknown) => {
          // A first read that cannot reach Windows answers with an empty list rather than an
          // error: the panel then shows "no printers", which is what the operator sees in
          // Windows too when the spooler is down.
          ctx.log.warn('initial printer enumeration failed', { error: String(err) });
        });
      }
      res.json({ printers: list(db).map(adminView) });
    }),
  );

  router.post(
    '/printers/refresh',
    wrap(async (_req, res) => {
      await enumerate(ctx);
      res.json({ printers: list(db).map(adminView) });
    }),
  );

  router.patch(
    '/printers/:id',
    wrap((req, res) => {
      const body = patchPrinterSchema.parse(req.body);
      const id = req.params['id'] as string;
      const row = db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as
        | PrinterRow
        | undefined;
      if (!row) throw new ApiException(ErrorCode.PRINTER_NOT_FOUND, 'Printer not found');

      db.prepare('UPDATE printers SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, id);
      ctx.activity.record('printer.updated', null, { name: row.name, enabled: body.enabled });

      const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as PrinterRow;
      res.json(adminView(updated));
    }),
  );

  return router;
}

/**
 * Runs the print module's enumeration and writes the result to the table.
 *
 * The import is dynamic for the same reason core loads its feature modules dynamically: the
 * module directory is optional, and an operator API that cannot boot because printing is
 * absent would take folders, devices and pairing down with it.
 */
async function enumerate(ctx: ServerContext): Promise<void> {
  const print = await loadPrintModule(ctx);

  let printers;
  try {
    printers = await print.enumeratePrinters(print.exec);
  } catch (err) {
    // The table is left exactly as it was. An operator who pressed "refresh" is told it
    // failed, rather than being shown a list that silently emptied itself.
    ctx.log.warn('printer enumeration failed', { error: String(err) });
    throw new ApiException(
      ErrorCode.SPOOLER_FAILED,
      'Windows did not return the printer list. Check that the Print Spooler service is running.',
    );
  }
  print.syncPrinters(ctx.db, printers, Date.now());
}

async function loadPrintModule(ctx: ServerContext) {
  try {
    const [enumeration, exec] = await Promise.all([
      import('../../modules/print/enumerate.js'),
      import('../../modules/print/exec.js'),
    ]);
    return {
      enumeratePrinters: enumeration.enumeratePrinters,
      syncPrinters: enumeration.syncPrinters,
      exec: exec.defaultExecFile,
    };
  } catch (err) {
    ctx.log.error('the print module is not installed', { error: String(err) });
    throw new ApiException(ErrorCode.INTERNAL, 'Printing is not installed on this server');
  }
}

function list(db: ServerContext['db']): PrinterRow[] {
  return db
    .prepare('SELECT * FROM printers ORDER BY is_default DESC, name')
    .all() as PrinterRow[];
}

function adminView(row: PrinterRow): PrinterAdminView {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default === 1,
    colorCapable: row.color_capable === 1,
    duplexCapable: row.duplex_capable === 1,
    status: row.status ?? 'Unknown',
    online: row.online === 1,
    driver: row.driver,
    enabled: row.enabled === 1,
    lastSeenAt: row.last_seen_at,
  };
}
