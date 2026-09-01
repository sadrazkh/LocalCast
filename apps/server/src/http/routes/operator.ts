import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import {
  ApiException,
  ErrorCode,
  accessModeSchema,
  addFolderRequestSchema,
  folderKindSchema,
  mintPairingRequestSchema,
  setPermissionsRequestSchema,
  type DeviceSummary,
  type FolderPermission,
} from '@localcast/contract';
import { randomUUID } from 'node:crypto';
import type { SqliteActivityLog } from '../../activity.js';
import { loopbackOnly } from '../../auth/middleware.js';
import type { PairingService } from '../../auth/pairing.js';
import type { TokenService } from '../../auth/tokens.js';
import type { Indexer } from '../../library/indexer.js';
import { stripLongPathPrefix, withLongPathPrefix, type FolderRow } from '../../library/resolver.js';
import type { ServerContext } from '../../kernel.js';
import { wrap } from '../errors.js';

/**
 * The operator API. Adding folders, approving devices and editing the permission matrix are
 * the endpoints that can *grant* privilege, so they are not exposed to the tailnet at all —
 * a stolen device token cannot escalate through a route that never answers it.
 *
 * The router is mounted behind BOTH the loopback check and the edge secret. Loopback alone
 * would admit any other process on the machine; the edge secret alone would admit anything
 * that reached us over the network if the edge were ever misconfigured.
 */

export interface OperatorRouterDeps {
  ctx: ServerContext;
  tokens: TokenService;
  pairing: PairingService;
  indexer: Indexer;
  activity: SqliteActivityLog;
}

const patchFolderSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  kind: folderKindSchema.optional(),
  writable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  autoIndex: z.boolean().optional(),
});

const setModeSchema = z.object({
  folderId: z.string(),
  mode: accessModeSchema,
});

const activityQuerySchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  before: z.number().int().positive().optional(),
});

export function createOperatorRouter(deps: OperatorRouterDeps): Router {
  const router = Router();
  const { ctx, tokens, pairing, indexer, activity } = deps;
  const { db } = ctx;

  router.use(loopbackOnly());

  // ── folders ────────────────────────────────────────────────────────────────

  router.get(
    '/folders',
    wrap((_req, res) => {
      const rows = db
        .prepare('SELECT * FROM shared_folders ORDER BY label')
        .all() as FolderRow[];
      res.json({ folders: rows.map(folderAdminView) });
    }),
  );

  router.post(
    '/folders',
    wrap(async (req, res) => {
      const body = addFolderRequestSchema.parse(req.body);

      // Stored normalised and without the long-path prefix, because it is also what the
      // panel shows the user. The resolver re-applies the prefix for I/O.
      const absolute = path.resolve(stripLongPathPrefix(body.path));
      const stat = await fsp.stat(withLongPathPrefix(absolute)).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new ApiException(ErrorCode.NOT_FOUND, 'That path is not a folder on this machine');
      }

      const id = randomUUID();
      try {
        db.prepare(
          `INSERT INTO shared_folders (id, path, label, kind, writable, auto_index, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          absolute,
          body.label,
          body.kind,
          body.writable ? 1 : 0,
          body.autoIndex ? 1 : 0,
          Date.now(),
        );
      } catch (err) {
        if (String((err as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
          throw new ApiException(ErrorCode.BAD_REQUEST, 'That folder is already shared');
        }
        throw err;
      }

      ctx.activity.record('folder.added', null, { label: body.label, path: absolute });

      // Indexing is fire-and-forget: the panel should not block on walking a 200k-file disk.
      void indexer.indexFolder(id).catch((err: unknown) => {
        ctx.log.error('initial index failed', { folderId: id, error: String(err) });
      });

      const row = db.prepare('SELECT * FROM shared_folders WHERE id = ?').get(id) as FolderRow;
      res.status(201).json(folderAdminView(row));
    }),
  );

  router.patch(
    '/folders/:id',
    wrap((req, res) => {
      const body = patchFolderSchema.parse(req.body);
      const id = req.params['id'] as string;
      const row = db.prepare('SELECT * FROM shared_folders WHERE id = ?').get(id) as
        | FolderRow
        | undefined;
      if (!row) throw new ApiException(ErrorCode.NOT_FOUND, 'Folder not found');

      db.prepare(
        `UPDATE shared_folders
            SET label = ?, kind = ?, writable = ?, enabled = ?, auto_index = ?
          WHERE id = ?`,
      ).run(
        body.label ?? row.label,
        body.kind ?? row.kind,
        body.writable === undefined ? row.writable : body.writable ? 1 : 0,
        body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
        body.autoIndex === undefined ? row.auto_index : body.autoIndex ? 1 : 0,
        id,
      );
      ctx.activity.record('folder.updated', null, { folderId: id });
      const updated = db.prepare('SELECT * FROM shared_folders WHERE id = ?').get(id) as FolderRow;
      res.json(folderAdminView(updated));
    }),
  );

  router.delete(
    '/folders/:id',
    wrap((req, res) => {
      const id = req.params['id'] as string;
      const result = db.prepare('DELETE FROM shared_folders WHERE id = ?').run(id);
      if (result.changes === 0) throw new ApiException(ErrorCode.NOT_FOUND, 'Folder not found');
      ctx.activity.record('folder.removed', null, { folderId: id });
      res.status(204).end();
    }),
  );

  router.post(
    '/folders/:id/reindex',
    wrap(async (req, res) => {
      const id = req.params['id'] as string;
      const row = db.prepare('SELECT 1 FROM shared_folders WHERE id = ?').get(id);
      if (!row) throw new ApiException(ErrorCode.NOT_FOUND, 'Folder not found');
      res.json(await indexer.indexFolder(id));
    }),
  );

  // ── devices ────────────────────────────────────────────────────────────────

  router.get(
    '/devices',
    wrap((_req, res) => {
      const rows = db
        .prepare(
          `SELECT d.*, (SELECT p.code FROM pairing_tokens p WHERE p.consumed_by_device = d.id)
                        AS pairing_code
             FROM devices d
            ORDER BY d.created_at DESC`,
        )
        .all() as Array<{
        id: string;
        name: string;
        platform: string;
        status: 'pending' | 'active' | 'revoked';
        last_seen_at: number | null;
        pairing_code: string | null;
      }>;

      const summaries: DeviceSummary[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        platform: r.platform as DeviceSummary['platform'],
        status: r.status,
        lastSeenAt: r.last_seen_at,
        pairingCode: r.pairing_code,
        permissions: permissionsFor(r.id),
      }));
      res.json({ devices: summaries });
    }),
  );

  router.post(
    '/devices/:id/approve',
    wrap(async (req, res) => {
      const result = await pairing.approve(req.params['id'] as string);
      // The plaintext is returned once, to the operator's own UI, and never stored.
      res.json(result);
    }),
  );

  router.post(
    '/devices/:id/reject',
    wrap((req, res) => {
      pairing.reject(req.params['id'] as string);
      res.status(204).end();
    }),
  );

  router.post(
    '/devices/:id/revoke',
    wrap((req, res) => {
      const id = req.params['id'] as string;
      const device = tokens.getDevice(id);
      if (!device) throw new ApiException(ErrorCode.NOT_FOUND, 'Device not found');
      tokens.revoke(id);
      ctx.activity.record('device.revoked', id, { name: device.name });
      ctx.events.publish({ type: 'device', deviceId: id, status: 'revoked' });
      res.status(204).end();
    }),
  );

  router.delete(
    '/devices/:id',
    wrap((req, res) => {
      const id = req.params['id'] as string;
      const device = tokens.getDevice(id);
      if (!device) throw new ApiException(ErrorCode.NOT_FOUND, 'Device not found');
      // Revoke first: the row disappears either way, but this bumps `token_version` so an
      // in-flight request loses its token in the same instant.
      tokens.revoke(id);
      db.prepare('DELETE FROM devices WHERE id = ?').run(id);
      ctx.activity.record('device.deleted', null, { name: device.name });
      res.status(204).end();
    }),
  );

  // ── permission matrix ──────────────────────────────────────────────────────

  router.get(
    '/devices/:id/permissions',
    wrap((req, res) => {
      const id = req.params['id'] as string;
      if (!tokens.getDevice(id)) throw new ApiException(ErrorCode.NOT_FOUND, 'Device not found');
      res.json({ permissions: permissionsFor(id) });
    }),
  );

  router.put(
    '/permissions',
    wrap((req, res) => {
      const body = setPermissionsRequestSchema.parse(req.body);
      if (!tokens.getDevice(body.deviceId)) {
        throw new ApiException(ErrorCode.NOT_FOUND, 'Device not found');
      }
      applyPermissions(body.deviceId, body.permissions);
      res.json({ permissions: permissionsFor(body.deviceId) });
    }),
  );

  router.put(
    '/devices/:id/permissions',
    wrap((req, res) => {
      const id = req.params['id'] as string;
      if (!tokens.getDevice(id)) throw new ApiException(ErrorCode.NOT_FOUND, 'Device not found');
      const body = z.object({ permissions: z.array(setModeSchema) }).parse(req.body);
      applyPermissions(id, body.permissions);
      res.json({ permissions: permissionsFor(id) });
    }),
  );

  // ── pairing ────────────────────────────────────────────────────────────────

  router.post(
    '/pairing',
    wrap((req, res) => {
      const body = mintPairingRequestSchema.parse(req.body ?? {});
      const minted = pairing.mint({
        defaultPermissions: body.defaultPermissions,
        ttlSeconds: body.ttlSeconds,
      });
      res.status(201).json({ code: minted.code, qr: minted.qr, expiresAt: minted.expiresAt });
    }),
  );

  // ── activity feed ──────────────────────────────────────────────────────────

  router.get(
    '/activity',
    wrap((req, res) => {
      const query = activityQuerySchema.parse({
        limit: req.query['limit'] === undefined ? undefined : Number(req.query['limit']),
        before: req.query['before'] === undefined ? undefined : Number(req.query['before']),
      });
      res.json({ entries: activity.list(query.limit, query.before) });
    }),
  );

  function permissionsFor(deviceId: string): FolderPermission[] {
    return db
      .prepare('SELECT folder_id AS folderId, mode FROM folder_permissions WHERE device_id = ?')
      .all(deviceId) as FolderPermission[];
  }

  /**
   * `none` is stored rather than deleted. An explicit closed row and a missing row behave
   * identically at request time, but the stored one lets the panel show the operator that a
   * decision was made instead of leaving the cell blank.
   */
  function applyPermissions(deviceId: string, permissions: FolderPermission[]): void {
    const upsert = db.prepare(
      `INSERT INTO folder_permissions (device_id, folder_id, mode) VALUES (?, ?, ?)
       ON CONFLICT (device_id, folder_id) DO UPDATE SET mode = excluded.mode`,
    );
    const apply = db.transaction(() => {
      for (const p of permissions) {
        const exists = db.prepare('SELECT 1 FROM shared_folders WHERE id = ?').get(p.folderId);
        if (!exists) throw new ApiException(ErrorCode.NOT_FOUND, 'Folder not found');
        upsert.run(deviceId, p.folderId, p.mode);
      }
    });
    apply();
    ctx.activity.record('permissions.updated', deviceId, { count: permissions.length });
  }

  return router;
}

function folderAdminView(row: FolderRow): Record<string, unknown> {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    kind: row.kind,
    writable: row.writable === 1,
    enabled: row.enabled === 1,
    available: row.available === 1,
    autoIndex: row.auto_index === 1,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    lastIndexedAt: row.last_indexed_at,
    createdAt: row.created_at,
  };
}
