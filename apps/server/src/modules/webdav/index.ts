import { readdir } from 'node:fs/promises';
import express from 'express';
import type { Request, Response } from 'express';
import { ApiException, DAV_PREFIX, ErrorCode } from '@localcast/contract';
import type { AccessMode } from '@localcast/contract';
import type { DeviceIdentity, ResolvedFile, ServerContext, ServerModule } from '../../kernel.js';
import { contentTypeFor } from '../shared/mime.js';
import { DavAuthenticator } from './auth.js';
import type { CreateStream } from './range.js';
import { serveRange, weakEtag } from './range.js';
import type { DavResource } from './xml.js';
import { buildMultistatus, encodeHref, FINITE_DEPTH_BODY } from './xml.js';

/**
 * Read-only WebDAV at `/dav/<folderId>/...`.
 *
 * Read-only in every access mode, including `full`. That is a product decision from the
 * spec, not a missing feature: a phone that is lost or handed to a repair shop keeps a
 * mounted drive letter onto the archive, and no permission model recovers from a client that
 * can issue DELETE. Writing happens only through the upload API, only into folders the
 * operator marked writable, and always with a session the panel can watch.
 */

const ALLOWED_METHODS = ['OPTIONS', 'PROPFIND', 'HEAD', 'GET'] as const;
const ALLOW_HEADER = ALLOWED_METHODS.join(', ');

export interface WebdavModuleOptions {
  /** Injected in tests; production reads the real directory. */
  readdir?: (absPath: string) => Promise<string[]>;
  createStream?: CreateStream;
  /** How long a successful scrypt verification is reused. See `DavAuthenticator`. */
  authCacheTtlMs?: number;
}

interface FolderRow {
  id: string;
  label: string;
  available: number;
  enabled: number;
}

interface DavTarget {
  folderId: string;
  /** POSIX-separated, relative to the folder root. Empty string means the folder root. */
  relPath: string;
  segments: string[];
}

export function createWebdavModule(options: WebdavModuleOptions = {}): ServerModule {
  const listDir = options.readdir ?? ((absPath: string) => readdir(absPath));
  let authenticator: DavAuthenticator | null = null;

  return {
    name: 'webdav',

    register(app, ctx) {
      const auth = new DavAuthenticator(ctx.db, { ttlMs: options.authCacheTtlMs });
      authenticator = auth;
      const router = express.Router();

      // `use` rather than `router.propfind(...)`: PROPFIND, MKCOL and MOVE are only routable
      // in Express when Node's parser lists them, and dispatching by hand keeps the
      // "everything else is 405" rule in one visible place instead of implied by omission.
      router.use((req, res) => {
        void handle(req, res, ctx, auth, listDir, options.createStream);
      });

      app.use(DAV_PREFIX, router);
      ctx.log.info('webdav mounted', { prefix: DAV_PREFIX, readOnly: true });
    },

    dispose() {
      authenticator?.clear();
    },
  };
}

async function handle(
  req: Request,
  res: Response,
  ctx: ServerContext,
  auth: DavAuthenticator,
  listDir: (absPath: string) => Promise<string[]>,
  createStream: CreateStream | undefined,
): Promise<void> {
  // Nothing here reads a request body, but an unread body wedges keep-alive on the next
  // request over the same socket, and iOS reuses one socket for a whole directory walk.
  req.resume();

  try {
    const method = req.method.toUpperCase();

    const result = await auth.authenticate(req.headers.authorization);
    if (!result.ok) {
      challenge(res, result.reason);
      return;
    }
    const device = result.device;

    res.setHeader('DAV', '1');
    // Without this the Windows Explorer "Map network drive" client tries the Office
    // discovery dance first and takes tens of seconds to give up.
    res.setHeader('MS-Author-Via', 'DAV');

    if (method === 'OPTIONS') {
      res.setHeader('Allow', ALLOW_HEADER);
      res.setHeader('Content-Length', '0');
      res.status(200).end();
      return;
    }

    if (method !== 'PROPFIND' && method !== 'GET' && method !== 'HEAD') {
      // PUT, DELETE, MKCOL, MOVE, COPY, PROPPATCH, LOCK, UNLOCK — all of them, always.
      res.setHeader('Allow', ALLOW_HEADER);
      res
        .status(405)
        .type('text/plain; charset=utf-8')
        .end('The LocalCast WebDAV mount is read-only. Use the upload API to write.\n');
      return;
    }

    const target = parseDavPath(req.url);

    if (target === null) {
      if (method !== 'PROPFIND') {
        // A browser pointed at the mount root. There is no directory index to give it, and
        // inventing one means generating HTML from untrusted file names for no client that
        // needs it.
        res.setHeader('Allow', 'OPTIONS, PROPFIND');
        res.status(405).type('text/plain; charset=utf-8').end('Use PROPFIND to list.\n');
        return;
      }
      await propfindRoot(req, res, ctx, device);
      return;
    }

    const mode = assertVisible(ctx, device.id, target.folderId);

    if (method === 'PROPFIND') {
      await propfindTarget(req, res, ctx, device, target, listDir);
      return;
    }

    await getOrHead(req, res, ctx, device, target, mode, createStream);
  } catch (err) {
    sendDavError(res, err, ctx);
  }
}

// ── auth and authorization ───────────────────────────────────────────────────

function challenge(res: Response, reason: 'missing' | 'bad-credentials' | 'not-active'): void {
  // `charset="UTF-8"` is what tells iOS and macOS to send the password as UTF-8 rather than
  // ISO-8859-1; without it a generated password is fine but any non-ASCII one silently fails.
  res.setHeader('WWW-Authenticate', 'Basic realm="LocalCast", charset="UTF-8"');
  const message =
    reason === 'not-active'
      ? 'This device is not active.'
      : 'A device id and its WebDAV password are required.';
  res
    .status(401)
    .type('text/plain; charset=utf-8')
    .end(`${message}\n`);
}

/**
 * Returns the mode, or throws the 404 that a `none` folder is served as.
 *
 * `assertCan` already maps `none` to a 404-shaped error so the matrix cannot be probed; this
 * goes through it rather than branching on the mode so WebDAV and the main API cannot drift.
 */
function assertVisible(ctx: ServerContext, deviceId: string, folderId: string): AccessMode {
  ctx.permissions.assertCan(deviceId, folderId, 'list');
  return ctx.permissions.modeFor(deviceId, folderId);
}

// ── PROPFIND ─────────────────────────────────────────────────────────────────

type Depth = '0' | '1';

function readDepth(req: Request): Depth {
  const raw = req.headers.depth;
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (value === '0') return '0';
  if (value === '1') return '1';
  if (value === undefined || value === '') {
    // RFC 4918 says a missing Depth means infinity. Taken literally that would answer 403 to
    // every client that omits the header, when what such a client always wants is this
    // directory. Default to 1 and reject only an explicit infinity.
    return '1';
  }
  throw new DepthInfinityError();
}

class DepthInfinityError extends Error {}

async function propfindRoot(
  req: Request,
  res: Response,
  ctx: ServerContext,
  device: DeviceIdentity,
): Promise<void> {
  const depth = readDepth(req);
  const base = mountBase(req);
  const resources: DavResource[] = [
    {
      href: `${base}/`,
      displayName: 'LocalCast',
      isCollection: true,
      contentLength: 0,
      lastModifiedMs: Date.now(),
      etag: weakEtag(0, 0),
    },
  ];

  if (depth === '1') {
    const visible = new Set(ctx.permissions.visibleFolders(device.id));
    const rows = ctx.db
      .prepare(`SELECT id, label, available, enabled FROM shared_folders ORDER BY label`)
      .all() as FolderRow[];
    for (const row of rows) {
      if (!visible.has(row.id) || row.enabled === 0) continue;
      resources.push({
        // An unavailable folder is still listed. Hiding it when a drive is unplugged makes
        // the mount look like the share was deleted; the client sees an empty collection.
        href: `${base}/${encodeHref([row.id])}/`,
        displayName: row.label,
        isCollection: true,
        contentLength: 0,
        lastModifiedMs: Date.now(),
        etag: weakEtag(0, 0),
      });
    }
  }

  sendMultistatus(res, resources);
}

async function propfindTarget(
  req: Request,
  res: Response,
  ctx: ServerContext,
  device: DeviceIdentity,
  target: DavTarget,
  listDir: (absPath: string) => Promise<string[]>,
): Promise<void> {
  const depth = readDepth(req);
  const base = mountBase(req);
  const resolved = await ctx.files.resolve(target.folderId, target.relPath);

  const resources: DavResource[] = [toResource(base, target.folderId, target.segments, resolved)];

  if (depth === '1' && resolved.isDir) {
    let names: string[];
    try {
      names = await listDir(resolved.absPath);
    } catch {
      // The index may say the directory exists after the drive was unplugged. An empty
      // collection is the honest answer; a 500 makes the Files app show a modal error.
      names = [];
    }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      const childRel = target.relPath === '' ? name : `${target.relPath}/${name}`;
      let child: ResolvedFile;
      try {
        // Every path — including one that came straight out of readdir — goes back through
        // the resolver, so a junction planted inside a share cannot widen the mount.
        child = await ctx.files.resolve(target.folderId, childRel);
      } catch {
        continue;
      }
      resources.push(toResource(base, target.folderId, [...target.segments, name], child));
    }
  }

  ctx.activity.record('dav.propfind', device.id, {
    folderId: target.folderId,
    path: target.relPath,
    depth,
  });
  sendMultistatus(res, resources);
}

function toResource(
  base: string,
  folderId: string,
  segments: readonly string[],
  file: ResolvedFile,
): DavResource {
  const name = segments.length === 0 ? folderId : (segments[segments.length - 1] as string);
  const href = `${base}/${encodeHref([folderId, ...segments])}${file.isDir ? '/' : ''}`;
  return {
    href,
    displayName: file.entry.name || name,
    isCollection: file.isDir,
    contentLength: file.isDir ? 0 : file.size,
    lastModifiedMs: file.mtimeMs,
    etag: weakEtag(file.size, file.mtimeMs),
    ...(file.isDir ? {} : { contentType: contentTypeFor(file.entry.name) }),
  };
}

function sendMultistatus(res: Response, resources: readonly DavResource[]): void {
  const body = buildMultistatus(resources);
  res.status(207);
  res.setHeader('Content-Type', 'application/xml; charset="utf-8"');
  res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
}

// ── GET / HEAD ───────────────────────────────────────────────────────────────

async function getOrHead(
  req: Request,
  res: Response,
  ctx: ServerContext,
  device: DeviceIdentity,
  target: DavTarget,
  mode: AccessMode,
  createStream: CreateStream | undefined,
): Promise<void> {
  const resolved = await ctx.files.resolve(target.folderId, target.relPath);
  if (resolved.isDir) {
    res.setHeader('Allow', 'OPTIONS, PROPFIND');
    res.status(405).type('text/plain; charset=utf-8').end('This is a collection.\n');
    return;
  }

  const wantsRange = typeof req.headers.range === 'string' && /^bytes\s*=/i.test(req.headers.range);
  const isHead = req.method.toUpperCase() === 'HEAD';

  // A ranged read is playback; an unranged GET pulls the whole file down and is a download.
  // `stream` mode allows the first and refuses the second, through exactly the check the
  // main API uses — including the honest admission in the spec that this is a UI restriction
  // and not a security boundary, since a client that can ask for ranges can reassemble.
  ctx.permissions.assertCan(device.id, target.folderId, wantsRange || isHead ? 'stream' : 'download');

  ctx.activity.record(isHead ? 'dav.head' : 'dav.get', device.id, {
    folderId: target.folderId,
    path: target.relPath,
    ranged: wantsRange,
  });

  await serveRange(
    req,
    res,
    {
      absPath: resolved.absPath,
      size: resolved.size,
      mtimeMs: resolved.mtimeMs,
      contentType: contentTypeFor(resolved.entry.name),
      disposition: wantsRange || mode === 'stream' ? 'inline' : 'attachment',
      fileName: resolved.entry.name,
    },
    createStream ? { createStream } : {},
  );
}

// ── path parsing ─────────────────────────────────────────────────────────────

/**
 * Splits `/folderId/a/b.mp4` into its decoded segments, or returns `null` for the mount root.
 *
 * The traversal check here is defence in depth — `ctx.files.resolve` re-checks after
 * `realpath` — but it costs nothing and it catches the encoded forms (`%2e%2e`) before a
 * decoded `..` ever reaches a path join.
 */
export function parseDavPath(url: string): DavTarget | null {
  const withoutQuery = url.split('?')[0] ?? '';
  const raw = withoutQuery.split('/').filter((part) => part.length > 0);

  const segments: string[] = [];
  for (const part of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new ApiException(ErrorCode.PATH_ESCAPES_ROOT, 'Malformed path encoding.');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('\0') || decoded.includes('/')) {
      throw new ApiException(ErrorCode.PATH_ESCAPES_ROOT, 'Path escapes the shared folder.');
    }
    segments.push(decoded);
  }

  const folderId = segments.shift();
  if (folderId === undefined) return null;
  return { folderId, relPath: segments.join('/'), segments };
}

function mountBase(req: Request): string {
  // `req.baseUrl` is the mount path Express matched. Falling back to the contract constant
  // keeps hrefs right if the module is ever mounted directly in a test.
  return req.baseUrl || DAV_PREFIX;
}

// ── errors ───────────────────────────────────────────────────────────────────

function sendDavError(res: Response, err: unknown, ctx: ServerContext): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof DepthInfinityError) {
    res.status(403);
    res.setHeader('Content-Type', 'application/xml; charset="utf-8"');
    res.end(FINITE_DEPTH_BODY);
    return;
  }
  if (err instanceof ApiException) {
    // WebDAV clients read the status, not the body, so the body stays plain text — but the
    // status still comes from the same table the JSON API uses, which is what keeps a `none`
    // folder answering 404 here as well as there.
    res.status(err.status).type('text/plain; charset=utf-8').end(`${err.message}\n`);
    return;
  }
  ctx.log.error('webdav request failed', {
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
  res.status(500).type('text/plain; charset=utf-8').end('Unexpected server error.\n');
}
