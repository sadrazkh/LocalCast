import type { Database } from 'better-sqlite3';
import type { Express, Request } from 'express';
import type {
  AccessMode,
  Entry,
  Operation,
  ServerEvent,
} from '@localcast/contract';

/**
 * The seam between the server core and the feature modules (WebDAV, printing, uploads).
 *
 * Core owns `src/db`, `src/auth`, `src/library`, `src/http` and `src/index.ts`.
 * Modules own `src/modules/<name>/**` and may import from here and from
 * `@localcast/contract`, but never reach into core internals. That keeps the two
 * buildable and testable independently.
 */

export interface DeviceIdentity {
  id: string;
  userId: string;
  name: string;
  platform: string;
  tokenVersion: number;
}

/** Attached by the auth middleware to every authenticated request. */
export interface AuthenticatedRequest extends Request {
  device: DeviceIdentity;
  /** Tailnet peer identity from the edge, or `funnel` when there is none. */
  peer: string;
}

export interface PermissionService {
  /** Current mode straight from SQLite. Never cached across requests. */
  modeFor(deviceId: string, folderId: string): AccessMode;
  /**
   * Throws `ApiException` with the right code when the operation is not allowed.
   * A `none` folder throws NOT_FOUND, not FORBIDDEN, so the matrix cannot be probed.
   */
  assertCan(deviceId: string, folderId: string, op: Operation): void;
  /** Folder ids the device may see at all. Used to scope listings and search. */
  visibleFolders(deviceId: string): string[];
}

export interface ResolvedFile {
  folderId: string;
  /** Absolute path with the `\\?\` long-path prefix applied. */
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
  entry: Entry;
}

export interface FileResolver {
  /**
   * Resolves a folder-relative path to a real path on disk.
   *
   * Contract: this re-`stat`s the filesystem rather than trusting the `files` index, and
   * after `fs.realpath` rejects anything that escapes the folder root — junctions and
   * symlinks included. Every byte-serving path in the system goes through here.
   */
  resolve(folderId: string, relPath: string): Promise<ResolvedFile>;
  /** Same guarantees, addressed by the opaque file id used in the API. */
  resolveById(fileId: string): Promise<ResolvedFile>;
  /** Where an upload for this folder may land. Throws if the folder is not writable. */
  resolveWritable(folderId: string, relPath: string): Promise<string>;
}

export interface ActivityLog {
  record(kind: string, deviceId: string | null, detail?: Record<string, unknown>): void;
}

export interface EventBus {
  publish(event: ServerEvent): void;
  /** Per-device stream; the SSE handler in core subscribes on behalf of a request. */
  subscribe(deviceId: string, handler: (event: ServerEvent) => void): () => void;
}

export interface ServerPaths {
  /** `%LOCALAPPDATA%\LocalCast` */
  dataDir: string;
  /** Scratch space for spool copies and in-flight uploads. Cleaned on boot. */
  tempDir: string;
  /** Directory holding bundled third-party binaries (SumatraPDF). */
  vendorDir: string;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ServerContext {
  db: Database;
  permissions: PermissionService;
  files: FileResolver;
  activity: ActivityLog;
  events: EventBus;
  paths: ServerPaths;
  log: Logger;
}

/**
 * A feature module. Core calls `register` once, after auth middleware is installed, so a
 * module can assume `req.device` exists on anything under the API prefix.
 */
export interface ServerModule {
  readonly name: string;
  register(app: Express, ctx: ServerContext): void | Promise<void>;
  /** Called on shutdown; modules with workers or open handles clean up here. */
  dispose?(): void | Promise<void>;
}
