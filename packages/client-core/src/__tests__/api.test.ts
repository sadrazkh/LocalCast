import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@localcast/contract';
import { ApiClient } from '../api.js';
import { NetworkError } from '../errors.js';
import { SessionManager } from '../session.js';
import type { Handler } from './fakes.js';
import { apiError, BASE_URL, FakeClock, FakeTransport, folder, json, MemoryTokenStore, session } from './fakes.js';

function client(handler: Handler, onOutcome?: (reached: boolean) => void) {
  const clock = new FakeClock();
  const transport = new FakeTransport(handler);
  const sessions = new SessionManager({
    transport,
    tokenStore: new MemoryTokenStore(session()),
    clock,
    baseUrl: BASE_URL,
  });
  return {
    transport,
    sessions,
    api: new ApiClient({ transport, session: sessions, baseUrl: BASE_URL, onOutcome }),
  };
}

const ENTRY = {
  id: 'e1',
  folderId: 'f1',
  path: 'Movies/Dune.mkv',
  name: 'Dune.mkv',
  isDir: false,
  size: 18_000_000_000,
  mtime: 1_700_000_000_000,
  ext: 'mkv',
  kind: 'video',
  printable: false,
  browserPlayable: false,
};

describe('URL builders', () => {
  const { api } = client(() => json(200, {}));

  it('builds a content URL that a <video> element can be handed directly', () => {
    expect(api.contentUrl('file 1')).toBe(`${BASE_URL}/api/v1/files/file%201/content`);
    expect(api.contentUrl('f1', { download: true })).toBe(
      `${BASE_URL}/api/v1/files/f1/content?download=1`,
    );
  });

  it('builds a WebDAV URL, encoding each segment but keeping the separators', () => {
    expect(api.davUrl('f1', 'Movies/Dune (2021).mkv')).toBe(
      `${BASE_URL}/dav/f1/Movies/Dune%20(2021).mkv`,
    );
  });

  it('embeds Basic credentials only when explicitly asked, for the native-player handoff', () => {
    expect(api.davUrl('f1', 'a.mkv')).not.toContain('@');
    expect(
      api.davUrl('f1', 'a.mkv', { credentials: { deviceId: 'dev-1', davPassword: 'p@ss' } }),
    ).toBe('https://dev-1:p%40ss@ali-pc.tail1234.ts.net/dav/f1/a.mkv');
  });
});

describe('typed routes', () => {
  it('parses folders and returns the array', async () => {
    const { api, transport } = client(() => json(200, { folders: [folder('a'), folder('b')] }));
    const folders = await api.folders();
    expect(folders.map((f) => f.id)).toEqual(['a', 'b']);
    expect(transport.requests[0]?.url).toBe(`${BASE_URL}/api/v1/folders`);
    expect(transport.requests[0]?.headers?.['authorization']).toBe('Bearer access-1');
  });

  it('sends the paging and path parameters for a listing', async () => {
    const { api, transport } = client(() =>
      json(200, { folder: folder(), path: 'Movies', entries: [ENTRY], nextCursor: 'c2' }),
    );
    const page = await api.entries('f1', { path: 'Movies', cursor: 'c1', limit: 50 });

    expect(page.nextCursor).toBe('c2');
    expect(page.entries[0]?.browserPlayable).toBe(false);
    expect(transport.requests[0]?.url).toBe(
      `${BASE_URL}/api/v1/folders/f1/entries?path=Movies&cursor=c1&limit=50`,
    );
  });

  it('escapes the search term rather than pasting it into the URL', async () => {
    const { api, transport } = client(() => json(200, { results: [], nextCursor: null }));
    await api.search('دون & sons', { folderId: 'f1' });
    expect(transport.requests[0]?.url).toBe(
      `${BASE_URL}/api/v1/search?q=%D8%AF%D9%88%D9%86+%26+sons&folderId=f1`,
    );
  });

  it('parses file metadata', async () => {
    const { api } = client(() => json(200, ENTRY));
    await expect(api.fileMeta('e1')).resolves.toMatchObject({ id: 'e1', kind: 'video' });
  });

  it('enqueues a print job and reads job state back', async () => {
    const job = {
      id: 'j1',
      fileName: 'a.pdf',
      printerName: 'HP',
      status: 'queued',
      copies: 2,
      color: 'mono',
      errorMessage: null,
      createdAt: 1,
      finishedAt: null,
    };
    const { api, transport } = client((request) =>
      request.url.endsWith('/print') ? json(200, job) : json(200, { jobs: [job] }),
    );

    const created = await api.print({
      printerId: 'p1',
      source: { kind: 'library', fileId: 'e1' },
      copies: 2,
      color: 'mono',
      duplex: 'simplex',
    });
    expect(created.status).toBe('queued');
    expect(JSON.parse(String(transport.requests[0]?.body))).toMatchObject({ printerId: 'p1' });

    await expect(api.printJobs()).resolves.toHaveLength(1);
  });

  it('sends the upload offset explicitly so a replayed chunk is refused, not duplicated', async () => {
    const { api, transport } = client(() =>
      json(200, { id: 'u1', receivedBytes: 8, totalBytes: 16, chunkSize: 8, status: 'active' }),
    );
    await api.patchUpload('u1', 8, new Uint8Array([1, 2, 3]));

    const request = transport.requests[0];
    expect(request?.method).toBe('PATCH');
    expect(request?.headers?.['upload-offset']).toBe('8');
    expect(request?.headers?.['content-type']).toBe('application/octet-stream');
    expect(request?.body).toBeInstanceOf(Uint8Array);
  });

  it('tolerates a bodyless 204 from DELETE /uploads/:id', async () => {
    const { api } = client(() => ({ status: 204, headers: {}, body: '' }));
    await expect(api.deleteUpload('u1')).resolves.toBeUndefined();
  });
});

describe('outcome reporting', () => {
  it('counts a 403 as having reached the server, and a transport failure as not', async () => {
    const outcomes: boolean[] = [];
    const { api } = client(() => apiError(403, ErrorCode.FORBIDDEN), (reached) => outcomes.push(reached));
    await expect(api.folders()).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    expect(outcomes).toEqual([true]);

    const failing = client(
      () => Promise.reject(new Error('ECONNREFUSED')),
      (reached) => outcomes.push(reached),
    );
    await expect(failing.api.folders()).rejects.toBeInstanceOf(NetworkError);
    expect(outcomes).toEqual([true, false]);
  });
});
