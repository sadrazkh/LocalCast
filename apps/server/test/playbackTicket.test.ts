import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/tokens.js';
import { addFolder, bearer, cleanupTempDirs, pairDevice, startServer, tempDir, type TestServer } from './helpers.js';

/**
 * A URL the media element can open on its own.
 *
 * `<video src>` cannot send a header, so the bearer reached the media endpoint only through the
 * service worker — every byte of every film went through the worker, and on a browser that refuses
 * to register one on this origin, nothing played. The ticket is the bearer exchanged for a grant a
 * URL can carry: one file, one device, a few hours, bound to the device's `token_version` so that
 * closing the device in the panel kills it on the next request.
 */

const started: TestServer[] = [];

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

async function library(mode: 'full' | 'stream' = 'full') {
  const ts = await startServer();
  started.push(ts);
  const share = tempDir('lc-ticket-');
  await fs.writeFile(path.join(share, 'film.mp4'), Buffer.alloc(64 * 1024, 5));
  await fs.writeFile(path.join(share, 'other.mp4'), Buffer.alloc(1024, 6));
  const folderId = await addFolder(ts, { path: share, label: 'Films' });
  const device = await pairDevice(ts, [{ folderId, mode }]);
  const listing = await ts.json<{ entries: { id: string; name: string }[] }>(
    `/api/v1/folders/${folderId}/entries`,
    { headers: bearer(device.accessToken) },
  );
  const idOf = (name: string): string => listing.entries.find((e) => e.name === name)!.id;
  const issue = (fileId: string) =>
    ts.json<{ url: string; expiresAt: number }>(`/api/v1/files/${fileId}/playback-url`, {
      method: 'POST',
      headers: bearer(device.accessToken),
    });
  return { ts, device, folderId, film: idOf('film.mp4'), other: idOf('other.mp4'), issue };
}

describe('a playback ticket', () => {
  it('plays the file with no bearer at all, ranges included', async () => {
    const { ts, film, issue } = await library();
    const { url, expiresAt } = await issue(film);
    expect(url).toMatch(/^\/api\/v1\/files\/.+\/content\?pt=/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const res = await ts.fetch(url, { headers: { range: 'bytes=0-1023' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-1023/65536');
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  });

  it('is good for that file and no other', async () => {
    const { ts, film, other, issue } = await library();
    const { url } = await issue(film);
    const ticket = new URL(url, 'http://x').searchParams.get('pt')!;
    const res = await ts.fetch(`/api/v1/files/${other}/content?pt=${encodeURIComponent(ticket)}`, {
      headers: { range: 'bytes=0-1' },
    });
    expect(res.status).toBe(401);
  });

  it('buys the bytes of one file and nothing else on the API', async () => {
    const { ts, folderId, film, issue } = await library();
    const { url } = await issue(film);
    const ticket = new URL(url, 'http://x').searchParams.get('pt')!;
    // The listing demands the bearer as it always did; a ticket in the query string is ignored.
    const res = await ts.fetch(`/api/v1/folders/${folderId}/entries?pt=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(401);
  });

  it('dies the moment the device is closed in the panel', async () => {
    const { ts, device, film, issue } = await library();
    const { url } = await issue(film);
    expect((await ts.fetch(url, { headers: { range: 'bytes=0-1' } })).status).toBe(206);

    await ts.fetch(`/operator/devices/${device.deviceId}/revoke`, { method: 'POST' });
    // Not merely refused: refused for the right reason, so the player can say «دسترسی بسته شد».
    const after = await ts.fetch(url, { headers: { range: 'bytes=0-1' } });
    expect(after.status).toBe(403);
  });

  it('refuses a forged signature and an expired ticket', async () => {
    const { ts, device, film } = await library();
    const forged = `${device.deviceId}.${Date.now() + 60_000}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect((await ts.fetch(`/api/v1/files/${film}/content?pt=${forged}`)).status).toBe(401);

    const row = ts.server.ctx.db.prepare('SELECT id, token_version FROM devices WHERE id = ?').get(device.deviceId) as {
      id: string;
      token_version: number;
    };
    // Issued through the real signing path, with a TTL already in the past.
    const expiredTicket = issueExpired(ts, row, film);
    const res = await ts.fetch(`/api/v1/files/${film}/content?pt=${encodeURIComponent(expiredTicket)}`);
    expect(res.status).toBe(401);
  });

  it('still honours the folder’s mode — a stream-only folder refuses a full download by ticket too', async () => {
    const { ts, film, issue } = await library('stream');
    const { url } = await issue(film);
    // Ranged: playback, allowed.
    expect((await ts.fetch(url, { headers: { range: 'bytes=0-1' } })).status).toBe(206);
    // Unranged: a download, refused — the ticket does not widen what the device may do.
    expect((await ts.fetch(url)).status).toBe(403);
  });
});

/**
 * A ticket with a negative TTL, through the same signing path that issues real ones.
 *
 * The service is not exposed on the server instance; a second one over the same database and
 * the same secret (`helpers.ts` signs with this string) produces byte-identical signatures.
 */
function issueExpired(ts: TestServer, device: { id: string; token_version: number }, fileId: string): string {
  const tokens = new TokenService(ts.server.ctx.db, Buffer.from('unit-test-signing-key-not-a-real-one', 'utf8'), {
    accessTokenTtlMs: 1,
    refreshTokenTtlMs: 1,
  });
  return tokens.issuePlaybackTicket(device, fileId, -1_000).ticket;
}
