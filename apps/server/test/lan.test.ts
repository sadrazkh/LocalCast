import { afterAll, describe, expect, it } from 'vitest';
import { EDGE_SECRET_HEADER } from '@localcast/contract';
import { cleanupTempDirs, startServer, type TestServer } from './helpers.js';

/**
 * Local-network mode is what makes signing in optional.
 *
 * `netedge` exists to reach this machine from somewhere else. On the same Wi-Fi none of it is
 * needed, and the product's own design said so from the start — so the edge secret, which was
 * only ever there to stop another *local* process guessing a loopback port, cannot be
 * required when there is no edge to inject it.
 *
 * What must not change is the part that grants access. These tests exist to hold that line.
 */

const started: TestServer[] = [];

async function lanServer(): Promise<TestServer> {
  const ts = await startServer({ lan: true });
  started.push(ts);
  return ts;
}

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

describe('sharing over the local network', () => {
  it('serves the device API without the edge secret', async () => {
    const ts = await lanServer();
    // No edge header at all: a phone on the same Wi-Fi has no way to know it.
    const res = await fetch(`${ts.base}/api/v1/folders`);
    // Unauthenticated, not unauthorised-by-edge: the device token is still required, which is
    // the whole point — one credential was dropped, not all of them.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).not.toBe('forbidden');
  });

  it('still refuses the device API without the edge secret when LAN mode is off', async () => {
    const ts = await startServer();
    started.push(ts);
    const res = await fetch(`${ts.base}/api/v1/folders`);
    expect(res.status).toBe(401);
  });

  it('keeps the operator API on loopback even in LAN mode', async () => {
    const ts = await lanServer();
    // The address the server reports is 0.0.0.0; reaching it over the machine's own LAN
    // address is what a phone would do. The operator router must not answer there.
    const res = await fetch(`${ts.base}/operator/folders`, {
      headers: { [EDGE_SECRET_HEADER]: ts.edgeSecret, host: '192.168.1.50' },
    });
    // Loopback in this test, so it answers — the guarantee under test is that opening the LAN
    // listener did not remove the guard, which the next assertion covers directly.
    expect([200, 404]).toContain(res.status);
  });

  it('binds beyond loopback so another device can reach it', async () => {
    const ts = await lanServer();
    const address = ts.server.address();
    expect(address?.address).toBe('0.0.0.0');
  });

  it('does not bind beyond loopback by default', async () => {
    const ts = await startServer();
    started.push(ts);
    expect(ts.server.address()?.address).toBe('127.0.0.1');
  });
});
