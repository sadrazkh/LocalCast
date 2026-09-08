import https from 'node:https';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ApiClient,
  FetchTransport,
  SessionManager,
  runPairing,
  systemClock,
  type StoredSession,
} from '@localcast/client-core';
import { cleanupTempDirs, startServer, type TestServer } from './helpers.js';

/**
 * The whole pairing journey, through the real client, against a real server.
 *
 * Every unit on either side of this passed while pairing was completely broken, because the break
 * was in the seam: the panel minted a link, and the client refused it. `runPairing` ran
 * `isPairableHost(payload.host)` unconditionally, that function refuses a bare IP — correctly, for
 * the MagicDNS name it was written for — and a local-network payload puts the address it was opened
 * at in `host`. So every scanned link died before the claim was even sent, the pairing screen fell
 * back to the four-character form, and the user's report was that scanning "does nothing, you have
 * to type the code anyway".
 *
 * This test is the one that would have caught it: it uses `runPairing` and `ApiClient` exactly as
 * the PWA does, over the encrypted listener, on this machine's own address.
 */

const started: TestServer[] = [];

/**
 * A `fetch` that accepts the server's self-signed certificate, for this test only.
 *
 * Written on `node:https` rather than by setting `NODE_TLS_REJECT_UNAUTHORIZED`, which would
 * disable verification for the whole worker and everything else that happens to run in it. This
 * is a phone accepting the warning, in one function, and nothing outside these requests is
 * affected. No shipping code in this repository disables verification; the desktop client pins
 * the fingerprint instead.
 */
function selfSignedFetch(): typeof globalThis.fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          host: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                headers: Object.entries(res.headers).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.join(', ') : (value ?? ''),
                ]) as [string, string][],
              }),
            ),
          );
        },
      );
      req.on('error', reject);
      if (typeof init?.body === 'string') req.write(init.body);
      req.end();
    });
  }) as typeof globalThis.fetch;
}

/** A client built the way the PWA builds one, pointed at a pairing link's origin. */
function clientFor(baseUrl: string): { api: ApiClient; session: SessionManager } {
  const transport = new FetchTransport({
    fetchImpl: baseUrl.startsWith('https:') ? selfSignedFetch() : undefined,
  });
  const session = new SessionManager({
    transport,
    tokenStore: { read: async () => null, write: async () => undefined, clear: async () => undefined },
    clock: systemClock,
    baseUrl,
  });
  return { api: new ApiClient({ transport, session, baseUrl }), session };
}

interface Minted {
  code: string;
  link: string | null;
}

async function mint(ts: TestServer): Promise<Minted> {
  return ts.json<Minted>('/operator/pairing', {
    method: 'POST',
    body: JSON.stringify({ ttlSeconds: 300 }),
    headers: { 'content-type': 'application/json' },
  });
}

/** The operator API answers with an envelope, not a bare array. */
async function waitingDevices(ts: TestServer): Promise<{ id: string; name: string; status: string }[]> {
  return (await ts.json<{ devices: { id: string; name: string; status: string }[] }>('/operator/devices'))
    .devices;
}

/** The operator's side, which the desktop now does from a dialog. */
async function approveTheWaitingDevice(ts: TestServer): Promise<string> {
  const pending = (await waitingDevices(ts)).find((device) => device.status === 'pending');
  expect(pending, 'a device should be waiting for approval').toBeDefined();
  await ts.fetch(`/operator/devices/${pending!.id}/approve`, { method: 'POST' });
  return pending!.id;
}

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

describe('pairing a phone from a scanned link', () => {
  it('claims, waits for the operator, and comes back with a usable session', async () => {
    const ts = await startServer({ lan: true });
    started.push(ts);

    const minted = await mint(ts);
    // A URL, because a phone's camera can open one. The QR used to carry a JSON blob, which no
    // camera app can do anything with at all.
    expect(minted.link).toMatch(/^https:\/\//);
    expect(minted.link).toContain(`#p=${minted.code}.`);

    const baseUrl = new URL(minted.link!).origin;
    const { api, session: sessions } = clientFor(baseUrl);
    const phases: string[] = [];
    const pairing: Promise<StoredSession> = runPairing({
      api,
      clock: systemClock,
      // The scanned string, unmodified. This is the exact value the QR image encodes.
      qr: minted.link!,
      deviceName: 'iPhone',
      platform: 'ios-pwa',
      onPhase: (phase) => phases.push(phase),
    });

    // Wait for the claim to land before approving, so this exercises the poll rather than a race
    // where approval happens to be in place before the first status request.
    await vi.waitFor(async () => {
      expect((await waitingDevices(ts)).some((d) => d.status === 'pending')).toBe(true);
    });
    const deviceId = await approveTheWaitingDevice(ts);

    const session = await pairing;
    expect(session.deviceId).toBe(deviceId);
    expect(session.accessToken).toBeTruthy();
    // The origin travels into the session, so a reconnect goes back to the same address and port
    // rather than guessing `https://<host>` and landing on 443.
    expect(session.baseUrl).toBe(baseUrl);
    expect(phases).toEqual(['claiming', 'waiting-for-approval']);

    // And the token opens the door. A well-formed session that cannot fetch anything is what the
    // phone would experience as pairing "succeeding" and then showing an empty library.
    await sessions.adopt(session);
    await expect(api.folders()).resolves.toBeInstanceOf(Array);
  });

  it('serves that address on the certificate it publishes the fingerprint of', async () => {
    const ts = await startServer({ lan: true });
    started.push(ts);

    const status = ts.server.lanStatus();
    expect(status.encrypted).toBe(true);
    expect(status.url).toMatch(/^https:\/\//);
    // The fingerprint in the QR payload is the one a pinning client will be shown. If these two
    // ever disagree, a native client refuses the connection and a browser shows a second warning.
    expect(status.fingerprint256).toBe(ts.server.lanCertificate()?.fingerprint256);
  });

  it('also pairs over the unencrypted fallback, for a device that cannot accept the certificate', async () => {
    // The fallback has to actually work, or it is not a fallback. Same client, same code path;
    // only the scheme differs, and `isUsableOrigin` allows `http://` for a local address alone.
    const ts = await startServer({ lan: true, lanPlaintext: true });
    started.push(ts);

    const minted = await mint(ts);
    expect(minted.link).toMatch(/^http:\/\//);

    const pairing = runPairing({
      api: clientFor(new URL(minted.link!).origin).api,
      clock: systemClock,
      qr: minted.link!,
      deviceName: 'Old TV',
      platform: 'android-pwa',
    });

    await vi.waitFor(async () => {
      expect((await waitingDevices(ts)).some((d) => d.status === 'pending')).toBe(true);
    });
    await approveTheWaitingDevice(ts);

    await expect(pairing).resolves.toMatchObject({ accessToken: expect.any(String) });
  });
});
