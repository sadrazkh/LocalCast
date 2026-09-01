import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EDGE_PEER_HEADER, EDGE_SECRET_HEADER, type AccessMode } from '@localcast/contract';
import { createServer, type CreateServerOptions, type LocalCastServer } from '../src/index.js';
import { silentLogger } from '../src/logger.js';

const EDGE_SECRET = 'test-edge-secret-0123456789';

export interface TestServer {
  server: LocalCastServer;
  base: string;
  root: string;
  edgeSecret: string;
  /** Adds the edge secret to every request, as `netedge` would. */
  fetch(url: string, init?: RequestInit & { peer?: string }): Promise<Response>;
  json<T = unknown>(url: string, init?: RequestInit & { peer?: string }): Promise<T>;
  dispose(): Promise<void>;
}

const created: string[] = [];

export function tempDir(prefix = 'lc-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop() as string;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A Windows handle held open by a just-closed stream is not worth failing a suite over.
    }
  }
}

export async function startServer(overrides: CreateServerOptions = {}): Promise<TestServer> {
  const root = overrides.dataDir ?? tempDir();
  const server = await createServer({
    dataDir: root,
    edgeSecret: EDGE_SECRET,
    jwtSecret: 'unit-test-signing-key-not-a-real-one',
    log: silentLogger,
    logLevel: 'silent',
    indexOnStart: false,
    publicHost: 'test.localcast.example',
    ...overrides,
  });
  const addr = await server.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;

  const call = (url: string, init: RequestInit & { peer?: string } = {}): Promise<Response> => {
    const { peer, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has(EDGE_SECRET_HEADER)) headers.set(EDGE_SECRET_HEADER, EDGE_SECRET);
    if (peer) headers.set(EDGE_PEER_HEADER, peer);
    return fetch(url.startsWith('http') ? url : base + url, { ...rest, headers });
  };

  return {
    server,
    base,
    root,
    edgeSecret: EDGE_SECRET,
    fetch: call,
    async json<T>(url: string, init: RequestInit & { peer?: string } = {}): Promise<T> {
      const res = await call(url, init);
      return (await res.json()) as T;
    },
    async dispose(): Promise<void> {
      await server.dispose();
    },
  };
}

export function postJson(body: unknown, extra: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    ...extra,
    headers: { 'content-type': 'application/json', ...(extra.headers as Record<string, string>) },
  };
}

export function putJson(body: unknown): RequestInit {
  return {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface SharedFolderSpec {
  path: string;
  label: string;
  writable?: boolean;
}

/** Adds a folder through the operator API and waits for its first index pass. */
export async function addFolder(ts: TestServer, spec: SharedFolderSpec): Promise<string> {
  const res = await ts.fetch(
    '/operator/folders',
    postJson({ path: spec.path, label: spec.label, writable: spec.writable ?? false }),
  );
  if (res.status !== 201) throw new Error(`addFolder failed: ${res.status} ${await res.text()}`);
  const folder = (await res.json()) as { id: string };
  await ts.server.indexer.indexFolder(folder.id);
  return folder.id;
}

export interface PairedDevice {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  davPassword: string;
}

/**
 * Runs the real pairing handshake — mint, claim, approve, poll — so the tests that depend on
 * a device having a token are also exercising the flow that produces one.
 */
export async function pairDevice(
  ts: TestServer,
  permissions: Array<{ folderId: string; mode: AccessMode }> = [],
  deviceName = 'Test Phone',
): Promise<PairedDevice> {
  const mintRes = await ts.fetch(
    '/operator/pairing',
    postJson({ defaultPermissions: permissions, ttlSeconds: 300 }),
  );
  if (mintRes.status !== 201) throw new Error(`mint failed: ${await mintRes.text()}`);
  const minted = (await mintRes.json()) as { code: string; qr: { secret: string } };

  const claimRes = await ts.fetch(
    '/api/v1/pair/claim',
    postJson({
      code: minted.code,
      secret: minted.qr.secret,
      deviceName,
      platform: 'ios-pwa',
    }),
  );
  if (claimRes.status !== 201) throw new Error(`claim failed: ${await claimRes.text()}`);
  const claim = (await claimRes.json()) as { deviceId: string; claimTicket: string };

  const approveRes = await ts.fetch(`/operator/devices/${claim.deviceId}/approve`, {
    method: 'POST',
  });
  if (!approveRes.ok) throw new Error(`approve failed: ${await approveRes.text()}`);

  const statusRes = await ts.fetch(
    `/api/v1/pair/status/${claim.deviceId}?ticket=${encodeURIComponent(claim.claimTicket)}`,
  );
  const status = (await statusRes.json()) as {
    status: string;
    accessToken: string;
    refreshToken: string;
    davPassword: string;
  };
  if (status.status !== 'approved') throw new Error(`poll returned ${JSON.stringify(status)}`);

  return {
    deviceId: claim.deviceId,
    accessToken: status.accessToken,
    refreshToken: status.refreshToken,
    davPassword: status.davPassword,
  };
}

export async function setMode(
  ts: TestServer,
  deviceId: string,
  folderId: string,
  mode: AccessMode,
): Promise<void> {
  const res = await ts.fetch('/operator/permissions', putJson({ deviceId, permissions: [{ folderId, mode }] }));
  if (!res.ok) throw new Error(`setMode failed: ${await res.text()}`);
}

/** Deterministic bytes so a mismatch says exactly which offset went wrong. */
export function patternBlock(seed: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let state = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buf[i] = (state >>> 24) & 0xff;
  }
  return buf;
}

export interface SparseFixture {
  file: string;
  size: number;
  offsets: number[];
  blockSize: number;
}

/**
 * A >4 GiB file without >4 GiB of disk. NTFS sparse files report the full length but only
 * allocate the ranges actually written, so the 20 pattern blocks cost a megabyte. The size
 * is the whole point of the fixture: a 32-bit truncation anywhere in the range path shows up
 * as garbage past the 4 GiB mark and nowhere before it.
 *
 * Returns null when the flag cannot be set (not NTFS, or `fsutil` unavailable), so the
 * caller can skip loudly instead of trying to write five real gigabytes.
 */
export function createSparseFixture(dir: string, size: number, blockSize = 64 * 1024): SparseFixture | null {
  const file = path.join(dir, 'huge.bin');
  fs.writeFileSync(file, Buffer.alloc(0));

  if (process.platform !== 'win32') return null;
  try {
    execFileSync('fsutil', ['sparse', 'setflag', file], { stdio: 'pipe' });
  } catch {
    return null;
  }

  fs.truncateSync(file, size);

  const fourGiB = 4 * 1024 * 1024 * 1024;
  const offsets = [
    0,
    blockSize,
    1024 * 1024,
    1024 * 1024 * 1024,
    2 * 1024 * 1024 * 1024,
    fourGiB - 3 * blockSize,
    fourGiB - 2 * blockSize,
    fourGiB - blockSize,
    fourGiB,
    fourGiB + blockSize,
    fourGiB + 2 * blockSize,
    fourGiB + 1024 * 1024,
    fourGiB + 256 * 1024 * 1024,
    size - 4 * blockSize,
    size - 2 * blockSize,
    size - blockSize,
  ].filter((o) => o >= 0 && o + blockSize <= size);

  const fd = fs.openSync(file, 'r+');
  try {
    for (const offset of offsets) {
      fs.writeSync(fd, expectedBlock(offset, blockSize), 0, blockSize, offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  return { file, size, offsets, blockSize };
}

/** Seeded by block index, so every offset in the fixture carries distinct bytes. */
export function expectedBlock(offset: number, blockSize: number): Buffer {
  return patternBlock(offset / blockSize, blockSize);
}

/**
 * Current file-descriptor pressure, measured by asking the runtime for a new one. libuv
 * hands out the lowest free slot, so the number a fresh open receives IS the count of
 * descriptors currently held. `process.report` does not list fs descriptors at all — they
 * are threadpool work, not libuv handles — so this is the measure that actually moves when a
 * read stream is abandoned.
 */
export function probeDescriptorNumber(probeFile: string): number {
  const fd = fs.openSync(probeFile, 'r');
  try {
    return fd;
  } finally {
    fs.closeSync(fd);
  }
}

/** Creates an NTFS junction. Returns false when the OS refuses, so the case can be skipped. */
export function createJunction(linkPath: string, targetPath: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], { stdio: 'pipe' });
    return fs.existsSync(linkPath);
  } catch {
    return false;
  }
}
