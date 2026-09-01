import { basename, extname } from 'node:path';
import express from 'express';
import type { Router } from 'express';
import { ApiException, ErrorCode, printRequestSchema } from '@localcast/contract';
import type { ServerContext } from '../../kernel.js';
import { asyncRoute, deviceOf, parseWith } from '../shared/http.js';
import type { ExecFileFn } from './exec.js';
import { defaultExecFile } from './exec.js';
import type { PrinterRow } from './enumerate.js';
import {
  enumeratePrinters,
  listEnabledPrinters,
  newestPrinterSeenAt,
  syncPrinters,
  toPrinterDto,
} from './enumerate.js';
import type { PrintQueue } from './jobs.js';

/**
 * PDF and images only.
 *
 * Office formats would need Word or Excel installed and driven over COM, which fails on a
 * machine without Office, prints a different layout than the sender saw, and leaves an
 * invisible WINWORD.EXE behind when it goes wrong. The spec puts them out of scope; the point
 * of naming them here is that the user gets told that, instead of a job that half-works.
 */
const PRINTABLE_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.webp',
]);

const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
]);

export function assertPrintable(fileName: string): void {
  const ext = extname(fileName).toLowerCase();
  if (PRINTABLE_EXTENSIONS.has(ext)) return;
  const message = OFFICE_EXTENSIONS.has(ext)
    ? `Office documents (${ext}) cannot be printed by LocalCast. Export the file to PDF and print that.`
    : `Only PDF and image files can be printed; ${ext || 'this file'} is not one of them.`;
  throw new ApiException(ErrorCode.UNPRINTABLE_TYPE, message);
}

export interface PrintRoutesOptions {
  exec?: ExecFileFn;
  /** How stale the cached printer list may be before `GET /printers` re-enumerates. */
  cacheTtlMs?: number;
  now?: () => number;
}

interface UploadRow {
  id: string;
  device_id: string;
  folder_id: string;
  rel_path: string;
  status: string;
}

export function createPrintRouter(
  ctx: ServerContext,
  queue: PrintQueue,
  options: PrintRoutesOptions = {},
): Router {
  const exec = options.exec ?? defaultExecFile;
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const router = express.Router();

  // Guards against a fleet of clients each triggering their own PowerShell start-up when the
  // cache expires; they all wait on the one refresh that is already running.
  let inflight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const printers = await enumeratePrinters(exec);
        syncPrinters(ctx.db, printers, now());
      } catch (err) {
        // A failed enumeration keeps the last known list. Emptying the table because
        // PowerShell hiccuped would make every client's printer picker go blank.
        ctx.log.warn('printer enumeration failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const refreshIfStale = async (force: boolean): Promise<void> => {
    const seen = newestPrinterSeenAt(ctx.db);
    if (force || seen === null || now() - seen > cacheTtlMs) await refresh();
  };

  router.get(
    '/printers',
    asyncRoute(async (req, res) => {
      deviceOf(req);
      await refreshIfStale(req.query['refresh'] === '1');
      res.json({ printers: listEnabledPrinters(ctx.db).map(toPrinterDto) });
    }, ctx.log),
  );

  router.post(
    '/print',
    // Mounted locally so the module works on a bare app in its own tests. body-parser marks
    // the request once parsed, so this is a no-op when core already installed a JSON parser.
    express.json({ limit: '64kb' }),
    asyncRoute(async (req, res) => {
      const device = deviceOf(req);
      const body = parseWith(printRequestSchema, req.body, 'print request');

      const printer = ctx.db
        .prepare(`SELECT * FROM printers WHERE id = ?`)
        .get(body.printerId) as PrinterRow | undefined;
      if (!printer) throw new ApiException(ErrorCode.PRINTER_NOT_FOUND, 'No such printer.');
      if (printer.enabled !== 1) {
        throw new ApiException(ErrorCode.PRINTER_DISABLED, 'This printer is not available.');
      }

      const source = await resolveSource(ctx, device.id, body.source);
      assertPrintable(source.fileName);
      // The permission is read here, per request, from the folder the file actually lives in
      // — not from anything the client sent and not from the token.
      ctx.permissions.assertCan(device.id, source.folderId, 'print');

      const job = queue.enqueue({
        deviceId: device.id,
        printerId: printer.id,
        printerName: printer.name,
        sourceKind: body.source.kind,
        sourcePath: source.absPath,
        fileName: source.fileName,
        copies: body.copies,
        color: body.color,
        duplex: body.duplex,
        pageRange: body.pageRange,
      });

      res.status(202).json({ job });
    }, ctx.log),
  );

  router.get(
    '/print/jobs',
    asyncRoute(async (req, res) => {
      const device = deviceOf(req);
      res.json({ jobs: queue.listForDevice(device.id) });
    }, ctx.log),
  );

  router.get(
    '/print/jobs/:id',
    asyncRoute(async (req, res) => {
      const device = deviceOf(req);
      const row = queue.findJob(String(req.params['id']));
      // Another device's job is reported as absent rather than forbidden, so the job id
      // space cannot be walked to learn what other devices printed.
      if (!row || row.device_id !== device.id) {
        throw new ApiException(ErrorCode.NOT_FOUND, 'No such print job.');
      }
      res.json({ job: queue.toDto(row) });
    }, ctx.log),
  );

  router.post(
    '/print/jobs/:id/cancel',
    asyncRoute(async (req, res) => {
      const device = deviceOf(req);
      res.json({ job: queue.cancel(String(req.params['id']), device.id) });
    }, ctx.log),
  );

  return router;
}

interface PrintSource {
  folderId: string;
  absPath: string;
  fileName: string;
}

async function resolveSource(
  ctx: ServerContext,
  deviceId: string,
  source: { kind: 'library'; fileId: string } | { kind: 'upload'; uploadId: string },
): Promise<PrintSource> {
  if (source.kind === 'library') {
    const resolved = await ctx.files.resolveById(source.fileId);
    if (resolved.isDir) throw new ApiException(ErrorCode.UNPRINTABLE_TYPE, 'A folder cannot be printed.');
    return {
      folderId: resolved.folderId,
      absPath: resolved.absPath,
      fileName: resolved.entry.name,
    };
  }

  const row = ctx.db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(source.uploadId) as
    | UploadRow
    | undefined;
  if (!row || row.device_id !== deviceId) {
    throw new ApiException(ErrorCode.UPLOAD_SESSION_UNKNOWN, 'No such upload.');
  }
  if (row.status !== 'complete') {
    throw new ApiException(ErrorCode.BAD_REQUEST, 'This upload has not finished yet.');
  }

  // A finished upload is an ordinary file in a shared folder, so it is re-resolved through
  // the same path that serves everything else — including the escape check.
  const resolved = await ctx.files.resolve(row.folder_id, row.rel_path);
  return {
    folderId: resolved.folderId,
    absPath: resolved.absPath,
    fileName: resolved.entry.name || basename(row.rel_path),
  };
}
