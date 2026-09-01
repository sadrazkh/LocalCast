import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addFolder, bearer, cleanupTempDirs, pairDevice, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

/**
 * The default configuration talks to nothing off this machine.
 *
 * This is the product's central promise and the one that cannot be held by reading the code:
 * a dependency that phones home, a font pulled from a CDN, an analytics beacon or an update
 * check firing unasked would all be invisible in review and obvious here. So the whole device
 * API is exercised — pair, list, range-read, WebDAV, SSE — with the process's own socket layer
 * watching, and any address outside loopback or a private range is recorded by name.
 *
 * The hook is `net.Socket.prototype.connect` and `dns.lookup`, which is as low as this process
 * can reach: `fetch`, `http.request`, `https.request` and every library that wraps them all
 * funnel through those two. Recording rather than merely blocking is deliberate — the failure
 * message has to say *who* was contacted, or the next person has a red test and no lead.
 */

interface Contact {
  /** The hostname or address the process asked for. */
  host: string;
  /** `connect` or `lookup`, so a DNS-only leak is still named. */
  via: string;
}

const contacts: Contact[] = [];

/** Everything a machine can reach without a router in the path. */
const PRIVATE_V4 =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/;

function isLocal(host: string | undefined): boolean {
  if (host === undefined || host === '') return true;
  const bare = host.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (bare === '::1' || bare === '::' || bare === '0.0.0.0') return true;
  if (PRIVATE_V4.test(bare)) return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare)) return true;
  return false;
}

/**
 * `connect` has three overloads and the host can arrive in any of them. Getting this wrong in
 * the permissive direction would make the whole file vacuous, so anything unrecognised is
 * treated as a real host rather than waved through.
 */
function hostOf(args: unknown[]): string | undefined {
  // `net.connect` normalises its own arguments and hands the result to `Socket.connect` as a
  // single array — the shape this guard missed on its first run, which let a real outbound
  // socket through while the list stayed empty. The self-tests below exist for that reason.
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  // An IPC endpoint (`{ path }` or a pipe name) never leaves the machine.
  if (typeof first === 'string') return undefined;
  if (typeof first === 'number') {
    return typeof args[1] === 'string' ? args[1] : '127.0.0.1';
  }
  if (typeof first === 'object' && first !== null) {
    const opts = first as { host?: string; path?: string; hostname?: string };
    if (typeof opts.path === 'string') return undefined;
    return opts.host ?? opts.hostname ?? '127.0.0.1';
  }
  return 'unknown';
}

type ConnectFn = typeof net.Socket.prototype.connect;
type LookupFn = typeof dns.lookup;

let realConnect: ConnectFn;
let realLookup: LookupFn;
let realPromisesLookup: typeof dns.promises.lookup;

beforeAll(() => {
  realConnect = net.Socket.prototype.connect;
  realLookup = dns.lookup;
  realPromisesLookup = dns.promises.lookup;

  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    const host = hostOf(args);
    if (isLocal(host)) {
      return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    }
    contacts.push({ host: host as string, via: 'connect' });
    // Failed rather than allowed through: a test that quietly reaches the internet when it is
    // run on a connected machine and passes when it is not would be worse than no test.
    process.nextTick(() => {
      this.destroy(new Error(`offline guard blocked a connection to ${String(host)}`));
    });
    return this;
  } as ConnectFn;

  const patchedLookup = ((hostname: string, ...rest: unknown[]) => {
    const done = rest[rest.length - 1];
    if (isLocal(hostname)) {
      return (realLookup as (...a: unknown[]) => unknown)(hostname, ...rest);
    }
    contacts.push({ host: hostname, via: 'lookup' });
    if (typeof done === 'function') {
      const err = Object.assign(new Error(`offline guard blocked a DNS lookup of ${hostname}`), {
        code: 'ENOTFOUND',
      });
      process.nextTick(() => (done as (e: Error) => void)(err));
      return undefined;
    }
    throw new Error(`offline guard blocked a DNS lookup of ${hostname}`);
  }) as unknown as LookupFn;

  dns.lookup = patchedLookup;
  dns.promises.lookup = (async (hostname: string, ...rest: unknown[]) => {
    if (isLocal(hostname)) {
      return (realPromisesLookup as (...a: unknown[]) => Promise<unknown>)(hostname, ...rest);
    }
    contacts.push({ host: hostname, via: 'lookup' });
    throw Object.assign(new Error(`offline guard blocked a DNS lookup of ${hostname}`), {
      code: 'ENOTFOUND',
    });
  }) as typeof dns.promises.lookup;
});

afterAll(() => {
  net.Socket.prototype.connect = realConnect;
  dns.lookup = realLookup;
  dns.promises.lookup = realPromisesLookup;
  cleanupTempDirs();
});

beforeEach(() => {
  contacts.length = 0;
});

const started: TestServer[] = [];

afterEach(async () => {
  while (started.length > 0) await started.pop()?.dispose();
});

/** Reads the failure message the assertion should carry: who, and how. */
function offMachine(): string[] {
  return contacts.map((c) => `${c.host} (via ${c.via})`);
}

/**
 * The guard's own test.
 *
 * Without this the file could pass because the hook never fires — the classic way a
 * network-isolation test rots into decoration. These two cases prove that a real outbound
 * attempt is both seen and named, so an empty `contacts` list below means something.
 */
describe('the offline guard itself', () => {
  it('sees and names a connection to the internet', async () => {
    await expect(fetch('https://api.github.com/repos/sadrazkh/LocalCast/releases/latest')).rejects.toThrow();
    expect(contacts.map((c) => c.host)).toContain('api.github.com');
  });

  it('sees a raw socket opened to a public address', async () => {
    const socket = net.connect({ host: '93.184.216.34', port: 443 });
    socket.on('error', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(offMachine()).toContain('93.184.216.34 (via connect)');
    socket.destroy();
  });

  it('lets loopback and private addresses through untouched', async () => {
    const ts = await startServer();
    started.push(ts);
    const res = await ts.fetch('/api/v1/folders');
    expect(res.status).toBe(401);
    expect(offMachine()).toEqual([]);
  });
});

describe('the default configuration', () => {
  it('reaches nothing off this machine while the whole device API is exercised', async () => {
    // Boot is inside the guard on purpose: certificate generation, module loading and the
    // first index pass are exactly where an unasked outbound call would hide.
    const ts = await startServer({ lan: true, lanHosts: ['192.168.77.5'] });
    started.push(ts);

    const media = tempDir('lc-offline-');
    fs.writeFileSync(path.join(media, 'clip.mp4'), Buffer.alloc(4096, 7));
    fs.mkdirSync(path.join(media, 'sub'));
    fs.writeFileSync(path.join(media, 'sub', 'notes.pdf'), 'y'.repeat(64));

    const folderId = await addFolder(ts, { path: media, label: 'Media' });
    const device = await pairDevice(ts, [{ folderId, mode: 'full' }]);
    const auth = bearer(device.accessToken);

    // ── the device API, over the loopback listener ────────────────────────────
    const me = await ts.json<{ device: { name: string } }>('/api/v1/me', { headers: auth });
    expect(me.device.name).toBe('Test Phone');

    const folders = await ts.json<{ folders: Array<{ id: string }> }>('/api/v1/folders', {
      headers: auth,
    });
    expect(folders.folders).toHaveLength(1);

    const entries = await ts.json<{ entries: Array<{ id: string; name: string; isDir: boolean }> }>(
      `/api/v1/folders/${folderId}/entries`,
      { headers: auth },
    );
    const clip = entries.entries.find((e) => e.name === 'clip.mp4');
    expect(clip).toBeDefined();

    await ts.json('/api/v1/search?q=notes', { headers: auth });

    // ── a range read, which is the path that actually moves bytes ─────────────
    const ranged = await ts.fetch(`/api/v1/files/${clip!.id}/content`, {
      headers: { ...auth, range: 'bytes=0-15' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(16);

    const head = await ts.fetch(`/api/v1/files/${clip!.id}/content`, {
      method: 'HEAD',
      headers: auth,
    });
    expect(head.status).toBe(200);

    // ── WebDAV, which is a second front door with its own credentials ─────────
    const dav = await ts.fetch(`/dav/${folderId}/`, {
      method: 'PROPFIND',
      headers: {
        depth: '1',
        authorization: `Basic ${Buffer.from(`${device.deviceId}:${device.davPassword}`, 'utf8').toString('base64')}`,
      },
    });
    expect(dav.status).toBe(207);
    expect(await dav.text()).toContain('clip.mp4');

    // ── SSE, which holds a socket open for the life of the session ────────────
    const abort = new AbortController();
    const stream = await ts.fetch('/api/v1/events', { headers: auth, signal: abort.signal });
    expect(stream.status).toBe(200);
    const first = await stream.body!.getReader().read();
    expect(Buffer.from(first.value!).toString('utf8')).toContain('retry:');
    abort.abort();

    // ── the local-network listener, which is on by default in the desktop ─────
    const lanPort = ts.server.lanAddress()?.port;
    expect(lanPort).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port: lanPort, path: '/api/v1/folders', rejectUnauthorized: false },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end();
    });

    // The whole point of the file. Anything listed here is a host this machine was asked to
    // reach while doing nothing but serving its own files on its own network.
    expect(offMachine()).toEqual([]);
  });
});
