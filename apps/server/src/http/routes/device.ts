import { Router } from 'express';
import { z } from 'zod';
import {
  ApiException,
  ErrorCode,
  type Entry,
  type Folder,
  type FolderPermission,
  pairClaimRequestSchema,
  paginationSchema,
  refreshRequestSchema,
} from '@localcast/contract';
import type { PairingService } from '../../auth/pairing.js';
import type { RateLimiter } from '../../auth/rateLimit.js';
import type { TokenService } from '../../auth/tokens.js';
import { authed, bearerAuth } from '../../auth/middleware.js';
import type { ServerConfig } from '../../config.js';
import type { FsFileResolver, FolderRow } from '../../library/resolver.js';
import { toEntry } from '../../library/mediaTypes.js';
import type { SqlPermissionService } from '../../library/permissions.js';
import type { ServerContext } from '../../kernel.js';
import { serveFile } from '../range.js';
import { wrap } from '../errors.js';
import {
  deviceCapabilityReportSchema,
  observedListener,
  type CapabilityReports,
} from '../capabilities.js';

/**
 * The device API from spec 4.1, minus printing, uploads and WebDAV, which live in
 * `src/modules` and register themselves through the kernel.
 *
 * Every body is validated with the schema from `@localcast/contract`; query strings are
 * coerced to the right primitive and then handed to the same schemas, so there is exactly
 * one definition of what a request looks like and the clients import it too.
 */

export interface DeviceRouterDeps {
  ctx: ServerContext;
  config: ServerConfig;
  tokens: TokenService;
  pairing: PairingService;
  limiter: RateLimiter;
  files: FsFileResolver;
  permissions: SqlPermissionService;
  /** Where a device's own account of what its browser granted it is kept. */
  capabilities: CapabilityReports;
}

const pairStatusQuerySchema = z.object({ ticket: z.string().min(1) });

/** `paginationSchema` plus the sub-path being listed. Not in the contract; composed from it. */
const entriesQuerySchema = paginationSchema.extend({
  path: z.string().default(''),
});

const searchQuerySchema = paginationSchema.extend({
  q: z.string().min(1).max(128),
  folderId: z.string().optional(),
});

const contentQuerySchema = z.object({
  /** Explicit download request; refused outright in `stream` mode. */
  download: z.boolean().default(false),
});

interface FileRow {
  id: string;
  folder_id: string;
  rel_path: string;
  parent_path: string;
  name: string;
  is_dir: number;
  size: number | null;
  mtime: number | null;
}

export function createDeviceRouter(deps: DeviceRouterDeps): Router {
  const router = Router();
  const { ctx, config, tokens, pairing, limiter, files, permissions, capabilities } = deps;
  const { db } = ctx;

  // ── pairing (unauthenticated, but behind the edge secret) ──────────────────

  router.post(
    '/pair/claim',
    wrap(async (req, res) => {
      const body = pairClaimRequestSchema.parse(req.body);
      const peer = req.peer ?? 'funnel';

      // Order matters: the global and peer buckets are charged before the code is even
      // looked at, so an attacker cannot use unknown codes as free probes.
      limiter.checkGlobal();
      limiter.checkPeer(peer);
      limiter.checkCode(body.code);

      try {
        const result = await pairing.claim(body, peer);
        limiter.clearCode(body.code);
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof ApiException && isClaimFailure(err.code)) {
          limiter.penaliseCode(body.code);
        }
        throw err;
      }
    }),
  );

  router.get(
    '/pair/status/:id',
    wrap(async (req, res) => {
      const { ticket } = pairStatusQuerySchema.parse(req.query);
      const result = await pairing.status(req.params['id'] as string, ticket);
      res.json(result);
    }),
  );

  router.post(
    '/token/refresh',
    wrap(async (req, res) => {
      const body = refreshRequestSchema.parse(req.body);
      limiter.checkGlobal();
      const issued = await tokens.redeemRefreshToken(body.refreshToken);
      res.json(issued);
    }),
  );

  // ── everything below needs a device ────────────────────────────────────────

  router.use(bearerAuth(tokens));

  router.get(
    '/me',
    wrap((req, res) => {
      const { device } = authed(req);
      const row = tokens.getDevice(device.id);
      if (!row) throw new ApiException(ErrorCode.UNAUTHENTICATED, 'Unknown device');
      res.json({
        device: {
          id: row.id,
          name: row.name,
          platform: row.platform,
          pairedAt: row.created_at,
        },
        server: {
          name: config.serverName,
          version: config.version,
          host: config.publicHost,
        },
        permissions: permissionsFor(device.id),
      });
    }),
  );

  /**
   * The device says what its browser actually granted it.
   *
   * Authenticated, because an unauthenticated version would let anyone on the Wi-Fi write
   * whatever they liked into the operator's panel. Idempotent: a device posts this on every
   * launch and the newest answer replaces the previous one.
   *
   * The response is `204`, not the stored record. A device gains nothing from reading its own
   * report back, and returning it would invite a client to treat this endpoint as storage.
   */
  router.post(
    '/capabilities',
    wrap((req, res) => {
      const { device } = authed(req);
      const report = deviceCapabilityReportSchema.parse(req.body);
      const { changed, stored } = capabilities.record(
        device.id,
        report,
        observedListener(req),
      );

      // One entry per real change, not one per launch: an activity feed that repeats the same
      // line every time a phone unlocks is a feed nobody reads.
      if (changed) {
        ctx.activity.record('device.capabilities', device.id, {
          serviceWorker: stored.serviceWorker,
          camera: stored.camera,
          secureContext: stored.secureContext,
          listener: stored.listener,
        });
        ctx.log.info('device reported its capabilities', {
          deviceId: device.id,
          serviceWorker: stored.serviceWorker,
          ...(stored.serviceWorkerError === undefined
            ? {}
            : { serviceWorkerError: stored.serviceWorkerError }),
          camera: stored.camera,
          secureContext: stored.secureContext,
          listener: stored.listener,
        });
      }

      res.status(204).end();
    }),
  );

  router.get(
    '/folders',
    wrap((req, res) => {
      const { device } = authed(req);
      // `visibleFolders` already drops `none`, so a closed folder is absent rather than
      // present-and-greyed. Unavailable folders stay, greyed, because the grant is still real.
      const ids = permissions.visibleFolders(device.id);
      res.json({ folders: ids.map((id) => folderView(id, device.id)) });
    }),
  );

  router.get(
    '/folders/:id/entries',
    wrap((req, res) => {
      const { device } = authed(req);
      const folderId = req.params['id'] as string;
      const query = entriesQuerySchema.parse({
        path: req.query['path'],
        cursor: req.query['cursor'],
        limit: numeric(req.query['limit']),
      });

      permissions.assertCan(device.id, folderId, 'list');
      const folder = files.getFolder(folderId);

      const parentPath = normaliseListingPath(query.path);
      const cursor = decodeCursor(query.cursor);

      const rows = db
        .prepare(
          `SELECT id, folder_id, rel_path, parent_path, name, is_dir, size, mtime
             FROM files
            WHERE folder_id = ? AND parent_path = ?
              AND (? IS NULL
                   OR is_dir < ?
                   OR (is_dir = ? AND name > ?))
            ORDER BY is_dir DESC, name ASC
            LIMIT ?`,
        )
        .all(
          folderId,
          parentPath,
          cursor ? 1 : null,
          cursor ? cursor.isDir : 0,
          cursor ? cursor.isDir : 0,
          cursor ? cursor.name : '',
          query.limit + 1,
        ) as FileRow[];

      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > query.limit && last
          ? encodeCursor({ isDir: last.is_dir, name: last.name })
          : null;

      res.json({
        folder: folderView(folderId, device.id, folder),
        path: parentPath,
        entries: page.map(rowToEntry),
        nextCursor,
      });
    }),
  );

  router.get(
    '/search',
    wrap((req, res) => {
      const { device } = authed(req);
      const query = searchQuerySchema.parse({
        q: req.query['q'],
        folderId: req.query['folderId'],
        cursor: req.query['cursor'],
        limit: numeric(req.query['limit']),
      });

      let scope = permissions.visibleFolders(device.id);
      if (query.folderId) {
        // Narrowing to a folder the device cannot see must return nothing, not an error:
        // an error would confirm the folder exists.
        scope = scope.filter((id) => id === query.folderId);
      }
      if (scope.length === 0) {
        res.json({ results: [], nextCursor: null });
        return;
      }

      const match = toFtsQuery(query.q);
      if (!match) {
        res.json({ results: [], nextCursor: null });
        return;
      }

      const offset = decodeOffset(query.cursor);
      const placeholders = scope.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT f.id, f.folder_id, f.rel_path, f.parent_path, f.name, f.is_dir, f.size, f.mtime
             FROM files_fts
             JOIN files f ON f.rowid = files_fts.rowid
            WHERE files_fts MATCH ?
              AND f.folder_id IN (${placeholders})
            ORDER BY rank
            LIMIT ? OFFSET ?`,
        )
        .all(match, ...scope, query.limit + 1, offset) as FileRow[];

      const page = rows.slice(0, query.limit);
      res.json({
        results: page.map(rowToEntry),
        nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
      });
    }),
  );

  router.get(
    '/files/:id/meta',
    wrap(async (req, res) => {
      const { device } = authed(req);
      const resolved = await files.resolveById(req.params['id'] as string);
      permissions.assertCan(device.id, resolved.folderId, 'list');
      res.json(resolved.entry);
    }),
  );

  const content = wrap(async (req, res) => {
    const { device } = authed(req);
    const query = contentQuerySchema.parse({ download: boolish(req.query['download']) });

    const resolved = await files.resolveById(req.params['id'] as string);
    // `list` first: a closed folder must 404 before anything else can distinguish it.
    permissions.assertCan(device.id, resolved.folderId, 'list');

    // A HEAD carries no bytes, so it is never a download however it is spelled; every player
    // issues one to learn the size before it seeks.
    const wantsDownload =
      req.method !== 'HEAD' && (query.download || req.header('range') === undefined);
    permissions.assertCan(device.id, resolved.folderId, wantsDownload ? 'download' : 'stream');
    const mode = permissions.modeFor(device.id, resolved.folderId);

    ctx.activity.record(query.download ? 'file.download' : 'file.stream', device.id, {
      folderId: resolved.folderId,
      path: resolved.relPath,
    });

    serveFile(req, res, resolved, {
      mode,
      disposition: query.download ? 'attachment' : 'inline',
      log: ctx.log,
    });
  });

  router.get('/files/:id/content', content);
  router.head('/files/:id/content', content);

  // ── helpers bound to this router's dependencies ────────────────────────────

  function permissionsFor(deviceId: string): FolderPermission[] {
    return db
      .prepare(
        `SELECT p.folder_id AS folderId, p.mode AS mode
           FROM folder_permissions p
           JOIN shared_folders f ON f.id = p.folder_id
          WHERE p.device_id = ? AND f.enabled = 1 AND p.mode <> 'none'`,
      )
      .all(deviceId) as FolderPermission[];
  }

  function folderView(folderId: string, deviceId: string, preloaded?: FolderRow): Folder {
    const row =
      preloaded ??
      (db.prepare('SELECT * FROM shared_folders WHERE id = ?').get(folderId) as
        | FolderRow
        | undefined);
    if (!row) throw new ApiException(ErrorCode.NOT_FOUND, 'Not found');
    return {
      id: row.id,
      label: row.label,
      kind: row.kind,
      mode: permissions.modeFor(deviceId, row.id),
      writable: row.writable === 1,
      available: row.available === 1,
      fileCount: row.file_count,
      totalBytes: row.total_bytes,
      lastIndexedAt: row.last_indexed_at,
    };
  }

  return router;
}

function rowToEntry(row: FileRow): Entry {
  return toEntry({
    id: row.id,
    folderId: row.folder_id,
    relPath: row.rel_path,
    name: row.name,
    isDir: row.is_dir === 1,
    size: row.size,
    mtime: row.mtime,
  });
}

function isClaimFailure(code: string): boolean {
  return (
    code === ErrorCode.PAIRING_INVALID ||
    code === ErrorCode.PAIRING_LOCKED ||
    code === ErrorCode.PAIRING_CONSUMED ||
    code === ErrorCode.PAIRING_EXPIRED
  );
}

/** `parent_path` is stored POSIX-separated with no leading or trailing slash. */
function normaliseListingPath(input: string): string {
  return input
    .split(/[\\/]+/)
    .filter((s) => s.length > 0 && s !== '.')
    .join('/');
}

interface ListingCursor {
  isDir: number;
  name: string;
}

/**
 * Keyset, not offset: a directory listing paged by offset skips or repeats entries whenever
 * the indexer inserts a row between two pages.
 */
function encodeCursor(cursor: ListingCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): ListingCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ListingCursor).name === 'string' &&
      (( parsed as ListingCursor).isDir === 0 || (parsed as ListingCursor).isDir === 1)
    ) {
      return parsed as ListingCursor;
    }
  } catch {
    // A corrupt cursor restarts the listing rather than failing the request.
  }
  return null;
}

/** Search results are ranked, so keyset pagination has nothing stable to key on. */
function encodeOffset(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeOffset(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const n = Number(text.startsWith('o:') ? text.slice(2) : NaN);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * FTS5 has its own query language, so a user typing `foo-bar` or `AND` would otherwise get a
 * syntax error rather than results. Every token becomes a quoted prefix term.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .split(/[\s]+/)
    .map((t) => t.replace(/["*]/g, '').trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function boolish(value: unknown): boolean {
  return value === '1' || value === 'true' || value === true;
}
