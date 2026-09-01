import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { EDGE_SECRET_HEADER } from '@localcast/contract';
import { lanIpv4Addresses, type CreateServerOptions } from '../src/index.js';
import { cleanupTempDirs, startServer, tempDir, type TestServer } from './helpers.js';

/**
 * Local-network mode is what makes signing in optional, and it is encrypted.
 *
 * `netedge` exists to reach this machine from somewhere else. On the same Wi-Fi none of it is
 * needed, and the product's own design said so from the start — so the edge secret, which was
 * only ever there to stop another *local* process guessing a loopback port, cannot be
 * required when there is no edge to inject it.
 *
 * What must not change is the part that grants access, and what must never come back is the
 * plain-HTTP listener this used to be: on a shared Wi-Fi, an unencrypted origin hands every
 * bearer token and every byte of every file to whoever else is on the network. These tests
 * hold both lines.
 */

const started: TestServer[] = [];

async function lanServer(overrides: CreateServerOptions = {}): Promise<TestServer> {
  const ts = await startServer({ lan: true, ...overrides });
  started.push(ts);
  return ts;
}

interface TlsResponse {
  status: number;
  body: string;
  /** Uppercase colon-separated hex, as `X509Certificate.fingerprint256` spells it. */
  peerFingerprint: string;
  peerCertificatePem: string;
}

/**
 * An HTTPS request that accepts the server's self-signed certificate.
 *
 * `rejectUnauthorized: false` is set **in this test only**, and it is safe here for exactly
 * one reason: the certificate is then compared against the one the server says it is serving,
 * so nothing is trusted blindly — the check is stricter than the default, not weaker. No
 * shipping code in this repository disables verification; the desktop client pins this
 * fingerprint instead.
 */
function tlsRequest(
  port: number,
  path: string,
  init: { headers?: Record<string, string>; host?: string } = {},
): Promise<TlsResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: init.host ?? '127.0.0.1',
        port,
        path,
        method: 'GET',
        rejectUnauthorized: false,
        headers: init.headers ?? {},
      },
      (res) => {
        const socket = res.socket as TLSSocket;
        const der = socket.getPeerCertificate().raw;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            peerFingerprint: new X509Certificate(der).fingerprint256,
            peerCertificatePem: new X509Certificate(der).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function lanPortOf(ts: TestServer): number {
  const address = ts.server.lanAddress();
  if (address === null) throw new Error('the LAN listener is not bound');
  return address.port;
}

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

describe('sharing over the local network', () => {
  it('speaks TLS on the local-network listener', async () => {
    const ts = await lanServer();
    const res = await tlsRequest(lanPortOf(ts), '/api/v1/folders');

    // Unauthenticated, not unauthorised-by-edge: the device token is still required, which is
    // the whole point — one credential was dropped, not all of them.
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).not.toBe('forbidden');

    // The certificate on the wire is the one the server reports, so the fingerprint it
    // publishes in the QR code is the one a device will actually be shown.
    expect(res.peerFingerprint).toBe(ts.server.lanCertificate()?.fingerprint256);
  });

  it('does not answer plain HTTP on the local-network listener', async () => {
    const ts = await lanServer();
    // A TLS server handed a plain-HTTP request does not reply with an HTTP error; it fails
    // the handshake and drops the socket. Anything that resolved here would mean an
    // unencrypted door had been left next to the encrypted one.
    await expect(fetch(`http://127.0.0.1:${lanPortOf(ts)}/api/v1/folders`)).rejects.toThrow();
  });

  it('puts this machine’s LAN address and hostname in the certificate', async () => {
    const ts = await lanServer({ lanHosts: ['192.168.77.5'] });
    const cert = ts.server.lanCertificate();
    expect(cert).not.toBeNull();

    const parsed = new X509Certificate(cert!.certPem);
    // The address a phone types has to be inside the SAN, or the phone gets a name-mismatch
    // error on top of the untrusted-issuer one — two warnings instead of one, and the second
    // is the kind browsers refuse to let you click through.
    expect(parsed.checkIP('192.168.77.5')).toBeDefined();
    expect(parsed.checkIP('127.0.0.1')).toBeDefined();
    expect(parsed.checkHost('localhost')).toBeDefined();

    // Whatever address the server publishes must be covered too, whichever interface it came
    // from on the machine running this suite.
    const published = cert!.publishHost;
    if (published !== null) {
      const covered = /^\d/.test(published)
        ? parsed.checkIP(published)
        : parsed.checkHost(published);
      expect(covered).toBeDefined();
    }
  });

  it('keeps loopback on plain HTTP for netedge', async () => {
    const ts = await lanServer();
    // `netedge` terminates its own TLS and proxies here. A second TLS hop between two
    // processes on one machine would encrypt nothing and would ask the sidecar to trust a
    // certificate no public root signed.
    expect(ts.server.address()?.address).toBe('127.0.0.1');
    const res = await ts.fetch('/api/v1/folders');
    expect(res.status).toBe(401);
    expect(ts.server.lanAddress()?.address).toBe('0.0.0.0');
  });

  it('still demands the edge secret on loopback, even while LAN sharing is on', async () => {
    const ts = await lanServer();
    // The waiver belongs to the LAN listener, not to the process. Turning on local sharing
    // must not let another program on this machine reach the API by guessing the port.
    const res = await fetch(`${ts.base}/api/v1/folders`);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/edge credentials/i);
  });

  it('serves the device API over TLS without the edge secret', async () => {
    const ts = await lanServer();
    // No edge header at all: a phone on the same Wi-Fi has no way to know it.
    const res = await tlsRequest(lanPortOf(ts), '/api/v1/folders');
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.message).not.toMatch(/edge credentials/i);
  });

  it('still refuses the device API without the edge secret when LAN mode is off', async () => {
    const ts = await startServer();
    started.push(ts);
    const res = await fetch(`${ts.base}/api/v1/folders`);
    expect(res.status).toBe(401);
  });

  it('keeps the operator API off the local-network listener, loopback address included', async () => {
    const ts = await lanServer();

    /**
     * The address alone is not the guard.
     *
     * This listener binds `0.0.0.0`, which includes `127.0.0.1`, so a caller that connects to
     * it over loopback presents a loopback `remoteAddress` *and* gets the edge secret waived
     * because the request arrived on the LAN listener. Two guards, each correct on its own,
     * adding up to none — and reachable by any web page in any browser on this machine, since
     * sending a cross-origin POST needs nobody's permission. So the operator API refuses
     * anything that came in on a network-facing listener, whatever address it claims.
     */
    const viaLoopback = await tlsRequest(lanPortOf(ts), '/operator/folders');
    expect(viaLoopback.status).toBe(404);

    const lan = lanIpv4Addresses()[0];
    // The rest of this needs a real network address; a machine with none cannot answer it.
    if (lan === undefined) return;
    // Over TLS, from the network, carrying the edge secret — the strongest a caller on the
    // Wi-Fi could ever be — and it still must not answer. The operator API is the surface
    // that grants access, so opening the LAN listener must not open it too.
    const res = await tlsRequest(lanPortOf(ts), '/operator/folders', {
      host: lan,
      headers: { [EDGE_SECRET_HEADER]: ts.edgeSecret },
    });
    expect(res.status).toBe(404);

    // …while the device API on that same socket does answer, so the 404 above is the guard
    // and not simply a listener that ignores everything from the network.
    const device = await tlsRequest(lanPortOf(ts), '/api/v1/folders', { host: lan });
    expect(device.status).toBe(401);
  });

  it('does not bind beyond loopback by default', async () => {
    const ts = await startServer();
    started.push(ts);
    expect(ts.server.address()?.address).toBe('127.0.0.1');
    expect(ts.server.lanAddress()).toBeNull();
    expect(ts.server.lanCertificate()).toBeNull();
  });
});

describe('the certificate a device is asked to trust', () => {
  it('is the same one after a restart, so the warning is seen once', async () => {
    const dataDir = tempDir('lc-tls-stable-');

    const first = await startServer({ lan: true, dataDir, lanHosts: ['192.168.55.5'] });
    const before = first.server.lanCertificate()?.fingerprint256;
    await first.dispose();

    const second = await startServer({ lan: true, dataDir, lanHosts: ['192.168.55.5'] });
    started.push(second);

    // A certificate regenerated on every launch means a browser warning on every launch, and
    // a warning people see daily is a warning they stop reading.
    expect(before).toBeDefined();
    expect(second.server.lanCertificate()?.fingerprint256).toBe(before);
  });

  it('is replaced when the machine is no longer at the address it covers', async () => {
    const dataDir = tempDir('lc-tls-moved-');

    const first = await startServer({ lan: true, dataDir, lanHosts: ['10.10.10.10'] });
    const before = first.server.lanCertificate()?.fingerprint256;
    await first.dispose();

    // A DHCP lease moving is enough to do this in the field. Reusing the old certificate
    // would leave the phone with a name mismatch it cannot dismiss.
    const second = await startServer({ lan: true, dataDir, lanHosts: ['10.10.10.11'] });
    started.push(second);
    const after = second.server.lanCertificate();

    expect(after?.fingerprint256).not.toBe(before);
    expect(new X509Certificate(after!.certPem).checkIP('10.10.10.11')).toBeDefined();
  });

  it('is published in the QR payload alongside an https origin', async () => {
    const ts = await lanServer({ lanHosts: ['192.168.44.4'] });
    const minted = await ts.json<{ qr: { url?: string; fp?: string; host: string } }>(
      '/operator/pairing',
      { method: 'POST', body: JSON.stringify({ ttlSeconds: 300 }), headers: { 'content-type': 'application/json' } },
    );

    const endpoint = ts.server.lanEndpoint();
    expect(endpoint).not.toBeNull();
    expect(minted.qr.url).toBe(endpoint?.url);
    expect(minted.qr.url).toMatch(/^https:\/\//);
    // The port is load-bearing: the LAN listener is on its own ephemeral port, not 443.
    expect(minted.qr.url).toMatch(new RegExp(`:${lanPortOf(ts)}$`));
    expect(minted.qr.fp).toBe(ts.server.lanCertificate()?.fingerprint256);
  });

  it('publishes nothing to pin when LAN sharing is off', async () => {
    const ts = await startServer();
    started.push(ts);
    const minted = await ts.json<{ qr: { url?: string; fp?: string } }>('/operator/pairing', {
      method: 'POST',
      body: JSON.stringify({ ttlSeconds: 300 }),
      headers: { 'content-type': 'application/json' },
    });
    // Absent, not empty: a client must read a missing `fp` as "this is an ordinary public
    // certificate, verify it normally", never as "skip verification".
    expect(minted.qr.url).toBeUndefined();
    expect(minted.qr.fp).toBeUndefined();
  });
});
