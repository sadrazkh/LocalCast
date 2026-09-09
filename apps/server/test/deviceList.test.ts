import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, startServer, type TestServer } from './helpers.js';

/**
 * The device list has to be the list that is true.
 *
 * It used to grow and only grow: every phone arrived as «آیفون», rejected phones stayed as
 * «بسته‌شده» rows for ever, abandoned scans stayed «در انتظار تأیید» for ever, and a grant made
 * in the panel reached the phone only when somebody reloaded it by hand.
 */

const started: TestServer[] = [];

interface Device {
  id: string;
  name: string;
  status: string;
}

async function mint(ts: TestServer): Promise<string> {
  const minted = await ts.json<{ code: string }>('/operator/pairing', {
    method: 'POST',
    body: JSON.stringify({ ttlSeconds: 300 }),
    headers: { 'content-type': 'application/json' },
  });
  return minted.code;
}

/** What a phone does: claim the code under a name. */
async function claim(ts: TestServer, name: string): Promise<{ deviceId: string; claimTicket: string }> {
  const code = await mint(ts);
  return ts.json('/api/v1/pair/claim', {
    method: 'POST',
    body: JSON.stringify({ code, deviceName: name, platform: 'ios-pwa' }),
    headers: { 'content-type': 'application/json' },
  });
}

async function devices(ts: TestServer): Promise<Device[]> {
  return (await ts.json<{ devices: Device[] }>('/operator/devices')).devices;
}

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

describe('names in the device list', () => {
  it('gives two devices that arrive under the same name different names', async () => {
    const ts = await startServer();
    started.push(ts);

    await claim(ts, 'iPhone · Safari · 14:32');
    await claim(ts, 'iPhone · Safari · 14:32');
    await claim(ts, 'iPhone · Safari · 14:32');

    const names = (await devices(ts)).map((d) => d.name).sort();
    // Three rows the operator can tell apart, rather than three identical ones.
    expect(names).toEqual(['iPhone · Safari · 14:32', 'iPhone · Safari · 14:32 (2)', 'iPhone · Safari · 14:32 (3)']);
  });

  it('lets a revoked device’s name be used again', async () => {
    // A phone that was closed and pairs again should get its own name back, not «(2)».
    const ts = await startServer();
    started.push(ts);

    const first = await claim(ts, 'Pixel 8 · Chrome · 09:00');
    await ts.fetch(`/operator/devices/${first.deviceId}/approve`, { method: 'POST' });
    await ts.fetch(`/operator/devices/${first.deviceId}/revoke`, { method: 'POST' });

    const second = await claim(ts, 'Pixel 8 · Chrome · 09:00');
    const rows = await devices(ts);
    expect(rows.find((d) => d.id === second.deviceId)?.name).toBe('Pixel 8 · Chrome · 09:00');
  });
});

describe('what stays in the list', () => {
  it('drops a rejected device instead of keeping it as revoked', async () => {
    const ts = await startServer();
    started.push(ts);

    const { deviceId, claimTicket } = await claim(ts, 'Stranger');
    const res = await ts.fetch(`/operator/devices/${deviceId}/reject`, { method: 'POST' });
    expect(res.status).toBe(204);

    // Gone from the list — it never had access, so there is nothing to show as closed.
    expect((await devices(ts)).some((d) => d.id === deviceId)).toBe(false);
    // And the phone, still polling, is told in words rather than answered 404: the row is kept
    // out of sight for that, and pruned once the phone has certainly given up.
    const poll = await ts.json<{ status: string }>(
      `/api/v1/pair/status/${deviceId}?ticket=${encodeURIComponent(claimTicket)}`,
    );
    expect(poll.status).toBe('rejected');

    ts.server.ctx.db
      .prepare('UPDATE devices SET created_at = ? WHERE id = ?')
      .run(Date.now() - 60 * 60 * 1000, deviceId);
    await devices(ts);
    expect(ts.server.ctx.db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId)).toBeUndefined();
  });

  it('drops a pending device nobody ever answered, once it is long past any code’s life', async () => {
    const ts = await startServer();
    started.push(ts);

    const { deviceId } = await claim(ts, 'Abandoned');
    // Age the row past the cut-off, the way a day of nobody clicking would.
    ts.server.ctx.db
      .prepare('UPDATE devices SET created_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60 * 1000, deviceId);

    expect((await devices(ts)).some((d) => d.id === deviceId)).toBe(false);
  });

  it('keeps a fresh pending device — the operator has not had a chance yet', async () => {
    const ts = await startServer();
    started.push(ts);
    const { deviceId } = await claim(ts, 'Just now');
    expect((await devices(ts)).find((d) => d.id === deviceId)?.status).toBe('pending');
  });

  it('removes a revoked device on request, and only then', async () => {
    const ts = await startServer();
    started.push(ts);

    const { deviceId } = await claim(ts, 'Old laptop');
    await ts.fetch(`/operator/devices/${deviceId}/approve`, { method: 'POST' });
    await ts.fetch(`/operator/devices/${deviceId}/revoke`, { method: 'POST' });
    expect((await devices(ts)).find((d) => d.id === deviceId)?.status).toBe('revoked');

    const res = await ts.fetch(`/operator/devices/${deviceId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await devices(ts)).some((d) => d.id === deviceId)).toBe(false);
  });
});

describe('a grant reaching the phone', () => {
  it('publishes a permissions event the device can hear, and nobody else can', async () => {
    const ts = await startServer();
    started.push(ts);

    const mine = await claim(ts, 'Mine');
    const other = await claim(ts, 'Other');
    await ts.fetch(`/operator/devices/${mine.deviceId}/approve`, { method: 'POST' });
    await ts.fetch(`/operator/devices/${other.deviceId}/approve`, { method: 'POST' });

    const heard: { by: string; type: string }[] = [];
    const offMine = ts.server.ctx.events.subscribe(mine.deviceId, (event) =>
      heard.push({ by: 'mine', type: event.type }),
    );
    const offOther = ts.server.ctx.events.subscribe(other.deviceId, (event) =>
      heard.push({ by: 'other', type: event.type }),
    );

    const folder = await ts.json<{ id: string }>('/operator/folders', {
      method: 'POST',
      body: JSON.stringify({ path: ts.root, label: 'Root', kind: 'mixed' }),
      headers: { 'content-type': 'application/json' },
    });
    await ts.fetch(`/operator/devices/${mine.deviceId}/permissions`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: mine.deviceId, permissions: [{ folderId: folder.id, mode: 'full' }] }),
      headers: { 'content-type': 'application/json' },
    });

    offMine();
    offOther();
    expect(heard.filter((h) => h.type === 'permissions')).toEqual([{ by: 'mine', type: 'permissions' }]);
  });
});
