import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '@localcast/contract';
import { createWebdavModule, parseDavPath } from '../../src/modules/webdav/index.js';
import { hashDavPassword, parseBasicAuth } from '../../src/modules/webdav/auth.js';
import { escapeXml } from '../../src/modules/webdav/xml.js';
import type { Harness, TestServer } from './support/context.js';
import { basicAuth, createHarness } from './support/context.js';

const PASSWORD = 'x7QmT4vLpZ2nRkWs';

/**
 * The names a real share actually contains. `<`, `>` and `"` are illegal in an NTFS file
 * name, so the characters that only a label can carry are exercised through a folder label —
 * which is free text in SQLite — and through `escapeXml` directly.
 */
const TRICKY_NAME = "AC&DC 'live' 2024.mp4";
const PERSIAN_NAME = 'فیلم خانوادگی ۱۴۰۳.mp4';
const TRICKY_LABEL = 'Movies & "Docs" <2024>';

let harness: Harness;
let server: TestServer;
let deviceId: string;
let folderId: string;
let streamFolderId: string;
let closedFolderId: string;

beforeEach(async () => {
  harness = await createHarness();

  const hash = await hashDavPassword(PASSWORD);
  deviceId = harness.addDevice({ name: 'iPhone', davPasswordHash: hash }).id;

  folderId = harness.addFolder({ label: TRICKY_LABEL }).id;
  streamFolderId = harness.addFolder({ label: 'Shared' }).id;
  closedFolderId = harness.addFolder({ label: 'Private' }).id;

  harness.grant(deviceId, folderId, 'full');
  harness.grant(deviceId, streamFolderId, 'stream');
  harness.grant(deviceId, closedFolderId, 'none');

  await harness.putFile(folderId, TRICKY_NAME, Buffer.alloc(1024, 7));
  await harness.putFile(folderId, PERSIAN_NAME, Buffer.alloc(2048, 3));
  await harness.putFile(folderId, 'season 1/ep01.mp4', Buffer.alloc(64, 1));
  await harness.putFile(streamFolderId, 'clip.mp4', Buffer.from('0123456789'));
  await harness.putFile(closedFolderId, 'secret.pdf', Buffer.from('nope'));

  server = await harness.serve([createWebdavModule({ authCacheTtlMs: 60_000 })]);
});

afterEach(async () => {
  await harness.cleanup();
});

function dav(path: string, init: RequestInit = {}, password = PASSWORD): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    ...init,
    headers: { authorization: basicAuth(deviceId, password), ...(init.headers ?? {}) },
  });
}

describe('basic auth', () => {
  it('challenges a request with no credentials', async () => {
    const res = await fetch(`${server.url}/dav/${folderId}/`, { method: 'PROPFIND' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic realm="LocalCast"');
    // Without charset="UTF-8" iOS sends the password as ISO-8859-1.
    expect(res.headers.get('www-authenticate')).toContain('charset="UTF-8"');
  });

  it('rejects a wrong password', async () => {
    const res = await dav(`/dav/${folderId}/`, { method: 'PROPFIND' }, 'not-the-password');
    expect(res.status).toBe(401);
  });

  it('rejects a revoked device even with the right password', async () => {
    harness.ctx.db.prepare(`UPDATE devices SET status = 'revoked' WHERE id = ?`).run(deviceId);
    const res = await dav(`/dav/${folderId}/`, { method: 'PROPFIND' });
    expect(res.status).toBe(401);
  });

  it('rejects a device that is still pending approval', async () => {
    harness.ctx.db.prepare(`UPDATE devices SET status = 'pending' WHERE id = ?`).run(deviceId);
    expect((await dav(`/dav/${folderId}/`, { method: 'PROPFIND' })).status).toBe(401);
  });

  it('locks out a revoked device on the very next request, cache or no cache', async () => {
    // Warm the verification cache with a successful request first.
    expect((await dav(`/dav/${folderId}/`, { method: 'PROPFIND' })).status).toBe(207);
    harness.ctx.db.prepare(`UPDATE devices SET status = 'revoked' WHERE id = ?`).run(deviceId);
    expect((await dav(`/dav/${folderId}/`, { method: 'PROPFIND' })).status).toBe(401);
  });

  it('parses a password containing colons', () => {
    expect(parseBasicAuth(basicAuth('dev-1', 'a:b:c'))).toEqual({ user: 'dev-1', pass: 'a:b:c' });
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth('Bearer abc')).toBeNull();
  });
});

describe('methods', () => {
  it('advertises the read-only method set on OPTIONS', async () => {
    const res = await dav(`/dav/${folderId}/`, { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    expect(res.headers.get('dav')).toBe('1');
    const allow = res.headers.get('allow') ?? '';
    expect(allow).toContain('PROPFIND');
    expect(allow).toContain('GET');
    expect(allow).not.toContain('PUT');
  });

  it.each(['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY', 'PROPPATCH', 'LOCK'])(
    'answers 405 to %s — the mount is read-only in every mode',
    async (method) => {
      const res = await dav(`/dav/${folderId}/${encodeURIComponent(TRICKY_NAME)}`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('OPTIONS, PROPFIND, HEAD, GET');
    },
  );

  it('refuses to write even into a folder the device has full access to', async () => {
    const res = await dav(`/dav/${folderId}/new.txt`, { method: 'PUT', body: 'hello' });
    expect(res.status).toBe(405);
  });
});

describe('PROPFIND', () => {
  it('returns Depth 0 as exactly one response', async () => {
    const res = await dav(`/dav/${folderId}/`, { method: 'PROPFIND', headers: { depth: '0' } });
    expect(res.status).toBe(207);
    expect(res.headers.get('content-type')).toContain('application/xml');

    const body = await res.text();
    expect(count(body, '<D:response>')).toBe(1);
    expect(body).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
    expect(body).not.toContain(escapeXml(TRICKY_NAME));
  });

  it('returns Depth 1 as the collection plus every child', async () => {
    const res = await dav(`/dav/${folderId}/`, { method: 'PROPFIND', headers: { depth: '1' } });
    const body = await res.text();
    // self + two files + one directory
    expect(count(body, '<D:response>')).toBe(4);
    expect(body).toContain('<D:displayname>season 1</D:displayname>');
  });

  it('escapes an ampersand in a file name — unescaped, it makes the Files app show an empty folder', async () => {
    const body = await (
      await dav(`/dav/${folderId}/`, { method: 'PROPFIND', headers: { depth: '1' } })
    ).text();

    expect(body).toContain("<D:displayname>AC&amp;DC &apos;live&apos; 2024.mp4</D:displayname>");
    // The raw form must appear nowhere: that is what breaks the parser.
    expect(body).not.toContain('AC&DC');
  });

  it('escapes the characters only a folder label can carry', async () => {
    const body = await (
      await dav('/dav/', { method: 'PROPFIND', headers: { depth: '1' } })
    ).text();

    expect(body).toContain('<D:displayname>Movies &amp; &quot;Docs&quot; &lt;2024&gt;</D:displayname>');
    expect(body).not.toContain('<2024>');
    expect(body).not.toContain('"Docs"');
  });

  it('escapes every XML-significant character and drops the ones XML cannot represent', () => {
    expect(escapeXml('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(escapeXml('bad\u0000name\u0007here')).toBe('badnamehere');
    expect(escapeXml('فیلم')).toBe('فیلم');
  });

  it('carries a Persian name through unharmed and percent-encodes it in the href', async () => {
    const body = await (
      await dav(`/dav/${folderId}/`, { method: 'PROPFIND', headers: { depth: '1' } })
    ).text();

    expect(body).toContain(`<D:displayname>${PERSIAN_NAME}</D:displayname>`);
    expect(body).toContain(`<D:href>/dav/${folderId}/${encodeURIComponent(PERSIAN_NAME)}</D:href>`);
  });

  it('reports the properties clients actually read', async () => {
    const body = await (
      await dav(`/dav/${folderId}/${encodeURIComponent(PERSIAN_NAME)}`, {
        method: 'PROPFIND',
        headers: { depth: '0' },
      })
    ).text();

    expect(body).toContain('<D:getcontentlength>2048</D:getcontentlength>');
    expect(body).toContain('<D:getcontenttype>video/mp4</D:getcontenttype>');
    expect(body).toMatch(/<D:getetag>W\/&quot;2048-\d+&quot;<\/D:getetag>/);
    // RFC 1123, which is what `toUTCString` produces.
    expect(body).toMatch(
      /<D:getlastmodified>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/D:getlastmodified>/,
    );
    expect(body).toContain('<D:resourcetype/>');
  });

  it('gives a collection a trailing slash on its href and a file none', async () => {
    const body = await (
      await dav(`/dav/${folderId}/`, { method: 'PROPFIND', headers: { depth: '1' } })
    ).text();
    expect(body).toContain(`<D:href>/dav/${folderId}/season%201/</D:href>`);
    expect(body).toContain(
      `<D:href>/dav/${folderId}/${encodeURIComponent(PERSIAN_NAME)}</D:href>`,
    );
  });

  it('lists only visible folders at the mount root', async () => {
    const body = await (
      await dav('/dav/', { method: 'PROPFIND', headers: { depth: '1' } })
    ).text();
    expect(body).toContain('<D:displayname>Shared</D:displayname>');
    expect(body).not.toContain('<D:displayname>Private</D:displayname>');
  });

  it('refuses Depth: infinity rather than walking the whole disk', async () => {
    const res = await dav(`/dav/${folderId}/`, {
      method: 'PROPFIND',
      headers: { depth: 'infinity' },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('propfind-finite-depth');
  });

  it('treats a missing Depth as 1, because that is what a client that omits it wants', async () => {
    const body = await (await dav(`/dav/${folderId}/`, { method: 'PROPFIND' })).text();
    expect(count(body, '<D:response>')).toBe(4);
  });
});

describe('permissions', () => {
  it('404s a `none` folder instead of admitting it exists', async () => {
    const res = await dav(`/dav/${closedFolderId}/`, { method: 'PROPFIND' });
    expect(res.status).toBe(404);
  });

  it('404s a file inside a `none` folder', async () => {
    const res = await dav(`/dav/${closedFolderId}/secret.pdf`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('404s a folder the device was never granted at all', async () => {
    const orphan = harness.addFolder({ label: 'Elsewhere' });
    const res = await dav(`/dav/${orphan.id}/`, { method: 'PROPFIND' });
    expect(res.status).toBe(404);
  });

  it('lets a `stream` folder be played by range', async () => {
    const res = await dav(`/dav/${streamFolderId}/clip.mp4`, {
      method: 'GET',
      headers: { range: 'bytes=0-3' },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('0123');
  });

  it('refuses a full download from a `stream` folder, exactly as the main API does', async () => {
    const res = await dav(`/dav/${streamFolderId}/clip.mp4`, { method: 'GET' });
    expect(res.status).toBe(403);
  });

  it('allows a full download from a `full` folder', async () => {
    const res = await dav(`/dav/${folderId}/${encodeURIComponent(PERSIAN_NAME)}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect((await res.arrayBuffer()).byteLength).toBe(2048);
  });
});

describe('GET', () => {
  it('serves a range with a correct Content-Range', async () => {
    const res = await dav(`/dav/${streamFolderId}/clip.mp4`, {
      method: 'GET',
      headers: { range: 'bytes=2-5' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('answers 416 past the end with the size the client needs to correct itself', async () => {
    const res = await dav(`/dav/${streamFolderId}/clip.mp4`, {
      method: 'GET',
      headers: { range: 'bytes=99-200' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('answers HEAD with the size and no body', async () => {
    const res = await dav(`/dav/${streamFolderId}/clip.mp4`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('');
  });

  it('405s a GET on a collection rather than inventing a directory index', async () => {
    const res = await dav(`/dav/${folderId}/season 1`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('404s a file that is not there', async () => {
    expect((await dav(`/dav/${folderId}/missing.mp4`, { method: 'GET' })).status).toBe(404);
  });
});

describe('path handling', () => {
  // `fetch` runs the URL through the WHATWG parser, which collapses `..` — and `%2e%2e` with
  // it — before anything reaches the socket. Testing the server's own check therefore needs
  // a client that sends the request line verbatim.
  it.each(['..', '%2e%2e', '%2E%2E', '.'])('rejects `%s` as a raw segment on the wire', async (segment) => {
    const res = await rawRequest('PROPFIND', `/dav/${folderId}/${segment}/etc`);
    expect(res.status).toBe(400);
  });

  it.each(['..', '%2e%2e', '%2E%2E', '.', 'a%2fb'])(
    'parseDavPath refuses `%s` before a path is ever built',
    (segment) => {
      expect(() => parseDavPath(`/${folderId}/${segment}/etc`)).toThrow(ApiException);
    },
  );

  it('parseDavPath decodes ordinary segments and reads the mount root as null', () => {
    expect(parseDavPath('/')).toBeNull();
    expect(parseDavPath('/f1/%D9%81%DB%8C%D9%84%D9%85.mp4')).toEqual({
      folderId: 'f1',
      relPath: 'فیلم.mp4',
      segments: ['فیلم.mp4'],
    });
  });

  it('serves a name that needs percent-encoding', async () => {
    const res = await dav(`/dav/${folderId}/${encodeURIComponent(TRICKY_NAME)}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  });
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Sends the request line exactly as written, without WHATWG URL normalisation. */
function rawRequest(method: string, path: string): Promise<{ status: number; body: string }> {
  const url = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method,
        path,
        host: url.hostname,
        port: url.port,
        headers: { authorization: basicAuth(deviceId, PASSWORD), 'content-length': '0' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
