import https from 'node:https';
import { afterAll, describe, expect, it } from 'vitest';
import { EDGE_SECRET_HEADER } from '@localcast/contract';
import type { CreateServerOptions } from '../src/index.js';
import { bearer, cleanupTempDirs, pairDevice, postJson, startServer, type TestServer } from './helpers.js';

/**
 * What a device says its browser actually granted it.
 *
 * This is the endpoint that turns acceptance item E2 from a guess into a reading. Nothing on
 * the developer's machine can decide whether a browser will register a service worker on an
 * origin carrying a certificate it does not trust — so the app stops deciding, asks the
 * device, and shows the answer in the panel.
 *
 * These tests hold three lines: the answer survives the round trip unchanged, the transport is
 * observed by the server rather than claimed by the client, and the panel's half of the
 * endpoint stays where every other operator route is — on loopback only.
 */

const started: TestServer[] = [];

async function server(overrides: CreateServerOptions = {}): Promise<TestServer> {
  const ts = await startServer(overrides);
  started.push(ts);
  return ts;
}

/** The report a phone sends when everything worked. */
const HEALTHY = {
  secureContext: true,
  serviceWorker: 'registered',
  camera: 'available',
  storage: 'indexeddb',
  standalone: true,
} as const;

/**
 * The report a phone sends when the browser held the line E2 is about: the origin loaded, the
 * certificate warning was accepted, and `register()` still threw.
 */
const REFUSED = {
  secureContext: true,
  serviceWorker: 'refused',
  serviceWorkerError: 'SecurityError',
  camera: 'available',
  storage: 'indexeddb',
  standalone: true,
} as const;

interface Report {
  deviceId: string;
  deviceName: string | null;
  listener: string;
  secureContext: boolean;
  serviceWorker: string;
  serviceWorkerError?: string;
  camera: string;
  storage: string;
  standalone: boolean;
  at: number;
}

function reports(ts: TestServer): Promise<{ reports: Report[] }> {
  return ts.json<{ reports: Report[] }>('/operator/capabilities');
}

/** A POST over TLS that accepts the self-signed certificate. See `lan.test.ts` on why. */
function tlsPost(
  port: number,
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

describe('a device reporting what it can do', () => {
  it('answers E2 in words the panel can print', async () => {
    const ts = await server();
    const device = await pairDevice(ts, [], 'Ali’s iPhone');

    const res = await ts.fetch(
      '/api/v1/capabilities',
      postJson(REFUSED, { headers: bearer(device.accessToken) }),
    );
    expect(res.status).toBe(204);

    const { reports: list } = await reports(ts);
    expect(list).toHaveLength(1);
    // Every field of the answer, not a boolean summary: "could not install the offline
    // library" and "the browser refused with a SecurityError" are different sentences and the
    // panel should be able to say either.
    expect(list[0]).toMatchObject({
      deviceId: device.deviceId,
      deviceName: 'Ali’s iPhone',
      platform: 'ios-pwa',
      secureContext: true,
      serviceWorker: 'refused',
      serviceWorkerError: 'SecurityError',
      camera: 'available',
      storage: 'indexeddb',
      standalone: true,
    });
  });

  it('replaces the previous answer rather than accumulating one row per launch', async () => {
    const ts = await server();
    const device = await pairDevice(ts);

    await ts.fetch('/api/v1/capabilities', postJson(REFUSED, { headers: bearer(device.accessToken) }));
    await ts.fetch('/api/v1/capabilities', postJson(HEALTHY, { headers: bearer(device.accessToken) }));

    const { reports: list } = await reports(ts);
    expect(list).toHaveLength(1);
    // A phone that has since accepted the certificate, or been updated, is a phone whose old
    // answer is wrong. The newest reading is the only one worth showing.
    expect(list[0]?.serviceWorker).toBe('registered');
    expect(list[0]?.serviceWorkerError).toBeUndefined();
  });

  it('refuses a report from something with no device token', async () => {
    const ts = await server();
    const res = await ts.fetch('/api/v1/capabilities', postJson(HEALTHY));
    expect(res.status).toBe(401);
    expect((await reports(ts)).reports).toHaveLength(0);
  });

  it('refuses a report it cannot read, rather than storing a shape nobody validated', async () => {
    const ts = await server();
    const device = await pairDevice(ts);
    const res = await ts.fetch(
      '/api/v1/capabilities',
      postJson(
        { ...HEALTHY, serviceWorker: 'probably-fine' },
        { headers: bearer(device.accessToken) },
      ),
    );
    expect(res.status).toBe(400);
    expect((await reports(ts)).reports).toHaveLength(0);
  });

  it('drops a deleted device’s report with the device', async () => {
    const ts = await server();
    const device = await pairDevice(ts);
    await ts.fetch('/api/v1/capabilities', postJson(HEALTHY, { headers: bearer(device.accessToken) }));

    await ts.fetch(`/operator/devices/${device.deviceId}`, { method: 'DELETE' });
    // Otherwise the panel keeps saying something about a phone that is no longer in the list.
    expect((await reports(ts)).reports).toHaveLength(0);
  });
});

describe('the transport is observed here, not claimed there', () => {
  it('records which listener the report arrived on', async () => {
    const ts = await server({ lan: true, lanPlaintext: true });
    const device = await pairDevice(ts);

    const lanPort = ts.server.lanAddress()?.port;
    const plainPort = ts.server.lanPlaintextAddress()?.port;
    expect(lanPort).toBeDefined();
    expect(plainPort).toBeDefined();

    // Loopback.
    await ts.fetch('/api/v1/capabilities', postJson(HEALTHY, { headers: bearer(device.accessToken) }));
    expect((await reports(ts)).reports[0]?.listener).toBe('loopback');

    // The encrypted local-network listener. No edge secret: a phone cannot know it.
    const tls = await tlsPost(lanPort as number, '/api/v1/capabilities', HEALTHY, {
      authorization: `Bearer ${device.accessToken}`,
    });
    expect(tls.status).toBe(204);
    expect((await reports(ts)).reports[0]?.listener).toBe('lan-tls');

    // The unencrypted one. The body is byte-identical to the two above — a device has no field
    // with which to say where it is, precisely because that is the one field it would have a
    // reason to be wrong about.
    const plain = await fetch(`http://127.0.0.1:${plainPort as number}/api/v1/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(device.accessToken) },
      body: JSON.stringify(HEALTHY),
    });
    expect(plain.status).toBe(204);
    expect((await reports(ts)).reports[0]?.listener).toBe('lan-plaintext');
  });

  it('keeps the panel’s half of the endpoint on loopback', async () => {
    const ts = await server({ lan: true, lanPlaintext: true });
    const plainPort = ts.server.lanPlaintextAddress()?.port;

    // The reports name devices and say what their browsers do. That is the operator's view of
    // the household, and it belongs on the same side of the wall as every other operator route.
    const res = await fetch(`http://127.0.0.1:${plainPort as number}/operator/capabilities`, {
      headers: { [EDGE_SECRET_HEADER]: ts.edgeSecret },
    });
    expect(res.status).toBe(404);
  });
});
