import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, startServer, type TestServer } from './helpers.js';

/**
 * A phone must be able to find the server again after the laptop's address changes.
 *
 * Two halves on the server. `/me` reports every local-network origin the server answers on,
 * so the phone can keep a fallback list. And a request from one of those origins to another —
 * which is what a failover from the installed app looks like to a browser — has to be allowed
 * by CORS, while a request from anywhere else stays refused. The allow-list is the certificate's
 * SAN: exactly the names this machine has claimed to be.
 */

const started: TestServer[] = [];

async function pairedDevice(ts: TestServer): Promise<{ token: string }> {
  const minted = await ts.json<{ code: string }>('/operator/pairing', {
    method: 'POST',
    body: JSON.stringify({ ttlSeconds: 300 }),
    headers: { 'content-type': 'application/json' },
  });
  const claim = await ts.json<{ deviceId: string; claimTicket: string }>('/api/v1/pair/claim', {
    method: 'POST',
    body: JSON.stringify({ code: minted.code, deviceName: 'Phone', platform: 'ios-pwa' }),
    headers: { 'content-type': 'application/json' },
  });
  await ts.fetch(`/operator/devices/${claim.deviceId}/approve`, { method: 'POST' });
  const status = await ts.json<{ accessToken: string }>(
    `/api/v1/pair/status/${claim.deviceId}?ticket=${encodeURIComponent(claim.claimTicket)}`,
  );
  return { token: status.accessToken };
}

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

describe('the addresses a phone is told about', () => {
  it('lists the published origin first, then the .local name on the same port', async () => {
    const ts = await startServer({ lan: true, lanHosts: ['192.168.77.5'] });
    started.push(ts);
    const { token } = await pairedDevice(ts);

    const me = await ts.json<{ server: { addresses: string[] } }>('/api/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    const port = ts.server.lanAddress()?.port;
    expect(me.server.addresses[0]).toBe(ts.server.lanEndpoint()?.url);
    // The name that survives a DHCP lease, on the same encrypted listener.
    expect(me.server.addresses.some((a) => /^https:\/\/[a-z0-9-]+\.local:\d+$/.test(a) && a.endsWith(`:${port}`))).toBe(true);
    // Every entry is somewhere this server actually answers.
    for (const origin of me.server.addresses) expect(() => new URL(origin)).not.toThrow();
  });

  it('reports nothing when local sharing is off', async () => {
    const ts = await startServer();
    started.push(ts);
    const { token } = await pairedDevice(ts);
    const me = await ts.json<{ server: { addresses: string[] } }>('/api/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.server.addresses).toEqual([]);
  });
});

describe('cross-origin requests between this machine’s own addresses', () => {
  it('allows an origin that is in the certificate, and answers its preflight', async () => {
    const ts = await startServer({ lan: true, lanHosts: ['192.168.77.5'] });
    started.push(ts);
    const port = ts.server.lanAddress()?.port;
    const own = `https://192.168.77.5:${port}`;

    const preflight = await ts.fetch('/api/v1/me', {
      method: 'OPTIONS',
      headers: { origin: own, 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(own);
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/range/i);

    const real = await ts.fetch('/api/v1/folders', { headers: { origin: own } });
    expect(real.headers.get('access-control-allow-origin')).toBe(own);
    // `Vary: Origin`, or a cache in between could hand one origin's answer to another.
    expect(real.headers.get('vary')).toMatch(/origin/i);
  });

  it('refuses an origin that is not one of this machine’s names', async () => {
    // The whole point of the allow-list. A page on the internet must not be able to make a
    // signed-in phone's browser call this server on its behalf.
    const ts = await startServer({ lan: true, lanHosts: ['192.168.77.5'] });
    started.push(ts);

    for (const foreign of ['https://evil.example.com', 'http://192.168.77.5:1', 'https://192.168.77.6:8420']) {
      const res = await ts.fetch('/api/v1/folders', { headers: { origin: foreign } });
      expect(res.headers.get('access-control-allow-origin'), foreign).toBeNull();
      const pre = await ts.fetch('/api/v1/folders', {
        method: 'OPTIONS',
        headers: { origin: foreign, 'access-control-request-method': 'GET' },
      });
      expect(pre.headers.get('access-control-allow-origin'), foreign).toBeNull();
    }
  });
});
