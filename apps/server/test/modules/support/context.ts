import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import type { Express } from 'express';
import { ApiException, ErrorCode, can } from '@localcast/contract';
import type { AccessMode, Entry, Operation, ServerEvent } from '@localcast/contract';
import type {
  ActivityLog,
  EventBus,
  FileResolver,
  Logger,
  PermissionService,
  ResolvedFile,
  ServerContext,
  ServerModule,
} from '../../../src/kernel.js';

/**
 * An in-memory `ServerContext`.
 *
 * The database is the real migration, not a stub: `printers`, `print_jobs` and `uploads` all
 * have CHECK constraints and foreign keys that a hand-written fake would quietly not have,
 * and a state machine that writes an illegal status is exactly the bug worth catching. What
 * is faked is only what the modules are not allowed to reach into anyway — the resolver, the
 * permission service and the event bus, which is the whole reason `kernel.ts` exists.
 */

const MIGRATION = fileURLToPath(
  new URL('../../../src/db/migrations/001_initial.sql', import.meta.url),
);

export interface FolderSpec {
  id?: string;
  label?: string;
  kind?: 'video' | 'documents' | 'photos' | 'mixed';
  writable?: boolean;
  available?: boolean;
}

export interface DeviceSpec {
  id?: string;
  name?: string;
  platform?: string;
  status?: 'pending' | 'active' | 'revoked';
  davPasswordHash?: string | null;
}

export interface Harness {
  ctx: ServerContext;
  root: string;
  events: ServerEvent[];
  activity: { kind: string; deviceId: string | null; detail?: Record<string, unknown> }[];
  logs: { level: string; msg: string; meta?: Record<string, unknown> }[];
  addFolder(spec?: FolderSpec): { id: string; root: string; label: string };
  addDevice(spec?: DeviceSpec): { id: string; name: string };
  grant(deviceId: string, folderId: string, mode: AccessMode): void;
  putFile(folderId: string, relPath: string, contents: Buffer | string): Promise<string>;
  fileId(folderId: string, relPath: string): string;
  addPrinter(spec?: { id?: string; name?: string; enabled?: boolean; online?: boolean }): {
    id: string;
    name: string;
  };
  serve(modules: ServerModule[]): Promise<TestServer>;
  cleanup(): Promise<void>;
}

export interface TestServer {
  url: string;
  app: Express;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'localcast-modules-'));
  const dataDir = join(root, 'data');
  const tempDir = join(root, 'temp');
  const vendorDir = join(root, 'vendor');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(tempDir, { recursive: true }),
    // Present but empty, which is also the state a broken install leaves it in.
    mkdir(vendorDir, { recursive: true }),
    mkdir(join(root, 'folders'), { recursive: true }),
  ]);

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(MIGRATION, 'utf8'));

  const ownerId = randomUUID();
  db.prepare(`INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, 'owner', ?)`).run(
    ownerId,
    'Owner',
    Date.now(),
  );

  const folderRoots = new Map<string, string>();
  const fileIds = new Map<string, { folderId: string; relPath: string }>();
  const events: ServerEvent[] = [];
  const activityRows: Harness['activity'] = [];
  const logs: Harness['logs'] = [];
  const servers: TestServer[] = [];

  const permissions: PermissionService = {
    modeFor(deviceId, folderId) {
      const row = db
        .prepare(`SELECT mode FROM folder_permissions WHERE device_id = ? AND folder_id = ?`)
        .get(deviceId, folderId) as { mode: AccessMode } | undefined;
      return row?.mode ?? 'none';
    },
    assertCan(deviceId, folderId, op) {
      const mode = permissions.modeFor(deviceId, folderId);
      if (mode === 'none') {
        // A closed folder must be indistinguishable from one that does not exist.
        throw new ApiException(ErrorCode.FOLDER_CLOSED, 'No such folder.');
      }
      if (!can(mode, op as Operation)) {
        throw new ApiException(
          op === 'download'
            ? ErrorCode.DOWNLOAD_NOT_ALLOWED
            : op === 'print'
              ? ErrorCode.PRINT_NOT_ALLOWED
              : op === 'upload'
                ? ErrorCode.UPLOAD_NOT_ALLOWED
                : ErrorCode.FORBIDDEN,
          'That is not allowed for this folder.',
        );
      }
    },
    visibleFolders(deviceId) {
      return (
        db
          .prepare(`SELECT folder_id FROM folder_permissions WHERE device_id = ? AND mode <> 'none'`)
          .all(deviceId) as { folder_id: string }[]
      ).map((row) => row.folder_id);
    },
  };

  function entryFor(
    folderId: string,
    relPath: string,
    info: { isDir: boolean; size: number; mtimeMs: number },
  ): Entry {
    const name = relPath === '' ? folderId : (relPath.split('/').pop() as string);
    const ext = info.isDir ? null : extname(name).toLowerCase();
    return {
      id: idFor(folderId, relPath),
      folderId,
      path: relPath,
      name,
      isDir: info.isDir,
      size: info.isDir ? null : info.size,
      mtime: Math.floor(info.mtimeMs),
      ext,
      kind: info.isDir ? 'other' : ext === '.mp4' ? 'video' : ext === '.pdf' ? 'document' : 'other',
      printable: ext === '.pdf' || ext === '.jpg' || ext === '.png',
      browserPlayable: ext === '.mp4',
    };
  }

  function idFor(folderId: string, relPath: string): string {
    const key = `${folderId}::${relPath}`;
    const id = Buffer.from(key, 'utf8').toString('base64url');
    fileIds.set(id, { folderId, relPath });
    return id;
  }

  async function resolveInternal(folderId: string, relPath: string): Promise<ResolvedFile> {
    const folderRoot = folderRoots.get(folderId);
    if (!folderRoot) throw new ApiException(ErrorCode.NOT_FOUND, 'No such folder.');

    const absPath = resolve(folderRoot, relPath);
    const relative = absPath.slice(folderRoot.length);
    if (absPath !== folderRoot && !relative.startsWith(sep)) {
      throw new ApiException(ErrorCode.PATH_ESCAPES_ROOT, 'Path escapes the shared folder.');
    }

    let info;
    try {
      info = await stat(absPath);
    } catch {
      throw new ApiException(ErrorCode.NOT_FOUND, 'No such file.');
    }

    const shape = {
      isDir: info.isDirectory(),
      size: info.isDirectory() ? 0 : info.size,
      mtimeMs: info.mtimeMs,
    };
    return {
      folderId,
      absPath,
      relPath,
      size: shape.size,
      mtimeMs: shape.mtimeMs,
      isDir: shape.isDir,
      entry: entryFor(folderId, relPath, shape),
    };
  }

  const files: FileResolver = {
    resolve: resolveInternal,
    async resolveById(fileId) {
      const known = fileIds.get(fileId);
      if (!known) throw new ApiException(ErrorCode.NOT_FOUND, 'No such file.');
      return resolveInternal(known.folderId, known.relPath);
    },
    async resolveWritable(folderId, relPath) {
      const folderRoot = folderRoots.get(folderId);
      if (!folderRoot) throw new ApiException(ErrorCode.NOT_FOUND, 'No such folder.');
      const row = db.prepare(`SELECT writable FROM shared_folders WHERE id = ?`).get(folderId) as
        | { writable: number }
        | undefined;
      if (!row || row.writable !== 1) {
        throw new ApiException(ErrorCode.UPLOAD_NOT_ALLOWED, 'This folder is not writable.');
      }
      const absPath = resolve(folderRoot, relPath);
      if (!absPath.slice(folderRoot.length).startsWith(sep)) {
        throw new ApiException(ErrorCode.PATH_ESCAPES_ROOT, 'Path escapes the shared folder.');
      }
      return absPath;
    },
  };

  const activity: ActivityLog = {
    record(kind, deviceId, detail) {
      activityRows.push({ kind, deviceId, ...(detail ? { detail } : {}) });
    },
  };

  const subscribers = new Map<string, Set<(event: ServerEvent) => void>>();
  const eventBus: EventBus = {
    publish(event) {
      events.push(event);
      for (const handlers of subscribers.values()) for (const handler of handlers) handler(event);
    },
    subscribe(deviceId, handler) {
      const set = subscribers.get(deviceId) ?? new Set();
      set.add(handler);
      subscribers.set(deviceId, set);
      return () => set.delete(handler);
    },
  };

  const log: Logger = {
    debug: (msg, meta) => logs.push({ level: 'debug', msg, ...(meta ? { meta } : {}) }),
    info: (msg, meta) => logs.push({ level: 'info', msg, ...(meta ? { meta } : {}) }),
    warn: (msg, meta) => logs.push({ level: 'warn', msg, ...(meta ? { meta } : {}) }),
    error: (msg, meta) => logs.push({ level: 'error', msg, ...(meta ? { meta } : {}) }),
  };

  const ctx: ServerContext = {
    db,
    permissions,
    files,
    activity,
    events: eventBus,
    paths: { dataDir, tempDir, vendorDir },
    log,
  };

  return {
    ctx,
    root,
    events,
    activity: activityRows,
    logs,

    addFolder(spec = {}) {
      const id = spec.id ?? randomUUID();
      const label = spec.label ?? `folder-${id.slice(0, 4)}`;
      const folderRoot = join(root, 'folders', id);
      db.prepare(
        `INSERT INTO shared_folders (id, path, label, kind, writable, enabled, available, auto_index, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?)`,
      ).run(
        id,
        folderRoot,
        label,
        spec.kind ?? 'mixed',
        spec.writable ? 1 : 0,
        spec.available === false ? 0 : 1,
        Date.now(),
      );
      folderRoots.set(id, folderRoot);
      return { id, root: folderRoot, label };
    },

    addDevice(spec = {}) {
      const id = spec.id ?? randomUUID();
      const name = spec.name ?? 'iPhone';
      db.prepare(
        `INSERT INTO devices (id, user_id, name, platform, status, dav_password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        ownerId,
        name,
        spec.platform ?? 'ios-pwa',
        spec.status ?? 'active',
        spec.davPasswordHash ?? null,
        Date.now(),
      );
      return { id, name };
    },

    grant(deviceId, folderId, mode) {
      db.prepare(
        `INSERT INTO folder_permissions (device_id, folder_id, mode) VALUES (?, ?, ?)
         ON CONFLICT(device_id, folder_id) DO UPDATE SET mode = excluded.mode`,
      ).run(deviceId, folderId, mode);
    },

    async putFile(folderId, relPath, contents) {
      const folderRoot = folderRoots.get(folderId);
      if (!folderRoot) throw new Error(`unknown folder ${folderId}`);
      const absPath = join(folderRoot, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, contents);
      return idFor(folderId, relPath.split(/[\\/]/).join('/'));
    },

    fileId(folderId, relPath) {
      return idFor(folderId, relPath);
    },

    addPrinter(spec = {}) {
      const id = spec.id ?? randomUUID();
      const name = spec.name ?? 'Office Laser';
      db.prepare(
        `INSERT INTO printers (id, name, driver, is_default, color_capable, duplex_capable, status, online, enabled, last_seen_at)
         VALUES (?, ?, 'Test Driver', 1, 1, 1, 'Normal', ?, ?, ?)`,
      ).run(id, name, spec.online === false ? 0 : 1, spec.enabled === false ? 0 : 1, Date.now());
      return { id, name };
    },

    async serve(modules) {
      const app = express();
      // Stands in for the core auth middleware, which core installs before it calls
      // `register`. Modules may assume `req.device` exists under the API prefix.
      app.use((req, _res, next) => {
        const deviceId = req.header('x-test-device');
        if (deviceId) {
          const row = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as
            | { id: string; user_id: string; name: string; platform: string; token_version: number }
            | undefined;
          if (row) {
            Object.assign(req, {
              device: {
                id: row.id,
                userId: row.user_id,
                name: row.name,
                platform: row.platform,
                tokenVersion: row.token_version,
              },
              peer: 'test-peer',
            });
          }
        }
        next();
      });

      for (const module of modules) await module.register(app, ctx);

      const server = createServer(app);
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address() as AddressInfo;
      const handle: TestServer = {
        url: `http://127.0.0.1:${address.port}`,
        app,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      };
      servers.push(handle);
      return handle;
    },

    async cleanup() {
      for (const server of servers) await server.close();
      db.close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}
