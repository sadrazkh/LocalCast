import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { EDGE_SECRET_HEADER } from '@localcast/contract';
import { buildLanAccess, type CreateServerOptions, type LanCertificate } from '../src/index.js';
import { cleanupTempDirs, startServer, tempDir, type TestServer } from './helpers.js';

/**
 * The unencrypted fallback listener.
 *
 * It exists for one case only: a device whose browser will not get past the certificate
 * interstitial at all. It is **not** a repair for the offline library — `http://` is not a
 * secure context anywhere except loopback, so a device on this listener has no service worker
 * and no camera, which is strictly less than the HTTPS listener offers with an accepted
 * warning. See `src/net/plaintext.ts`.
 *
 * Because it contradicts "every connection is encrypted", the tests that matter are the ones
 * that hold it in its box: it does not exist unless somebody asked for it, it does not change
 * the encrypted listener, and it cannot reach the API that grants access.
 */

const started: TestServer[] = [];

async function server(overrides: CreateServerOptions = {}): Promise<TestServer> {
  const ts = await startServer({ lan: true, ...overrides });
  started.push(ts);
  return ts;
}

/** A webRoot with a shell in it, so "serves the same app" can be asserted rather than assumed. */
function webRootWithShell(): string {
  const root = tempDir('lc-plain-web-');
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>LocalCast</title>');
  return root;
}

function plainPortOf(ts: TestServer): number {
  const address = ts.server.lanPlaintextAddress();
  if (address === null) throw new Error('the plaintext listener is not bound');
  return address.port;
}

function lanPortOf(ts: TestServer): number {
  const address = ts.server.lanAddress();
  if (address === null) throw new Error('the LAN listener is not bound');
  return address.port;
}

/** Same accept-and-then-verify shape as `lan.test.ts`; see the note there on why it is safe. */
function tlsRequest(
  port: number,
  urlPath: string,
  init: { headers?: Record<string, string>; host?: string } = {},
): Promise<{ status: number; body: string; peerFingerprint: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: init.host ?? '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        rejectUnauthorized: false,
        headers: init.headers ?? {},
      },
      (res) => {
        const der = (res.socket as TLSSocket).getPeerCertificate().raw;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            peerFingerprint: new X509Certificate(der).fingerprint256,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

describe('the unencrypted listener is off unless it is asked for', () => {
  it('does not exist when local sharing is on and nothing asked for plaintext', async () => {
    const ts = await server();
    expect(ts.server.lanPlaintextAddress()).toBeNull();
    expect(ts.server.lanAccess().plaintext).toEqual([]);
  });

  it('does not exist when local sharing itself is off', async () => {
    // An unencrypted door onto a network we are not otherwise sharing on would be a way to
    // start sharing without ever choosing to.
    const ts = await server({ lan: false, lanPlaintext: true });
    expect(ts.server.lanPlaintextAddress()).toBeNull();
    expect(ts.server.lanAddress()).toBeNull();
  });

  it('binds only when asked, and says so as a warning in the log', async () => {
    const lines: Array<{ level: string; msg: string }> = [];
    const ts = await server({
      lanPlaintext: true,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: (msg) => lines.push({ level: 'warn', msg }),
        error: (msg) => lines.push({ level: 'error', msg }),
      },
    });

    expect(ts.server.lanPlaintextAddress()?.address).toBe('0.0.0.0');
    // The line is a warning, not an info: this listener is a deliberate exception to the
    // product's own claim that every connection is encrypted, and the log should read that way.
    const warned = lines.find((line) => line.msg.includes('unencrypted'));
    expect(warned?.level).toBe('warn');
  });
});

describe('what the unencrypted listener will and will not serve', () => {
  it('serves the same app and the same device API', async () => {
    const ts = await server({ lanPlaintext: true, webRoot: webRootWithShell() });
    const base = `http://127.0.0.1:${plainPortOf(ts)}`;

    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('LocalCast');

    // Unauthenticated rather than refused-by-edge: the device token is still the credential
    // that matters. Dropping TLS drops TLS and nothing else.
    const api = await fetch(`${base}/api/v1/folders`);
    expect(api.status).toBe(401);
    expect((await api.json()).error.message).not.toMatch(/edge credentials/i);
  });

  it('refuses the operator API, even from 127.0.0.1 and even carrying the edge secret', async () => {
    const ts = await server({ lanPlaintext: true });
    const base = `http://127.0.0.1:${plainPortOf(ts)}`;

    // This is the case the address check alone cannot catch: the listener binds 0.0.0.0, which
    // includes loopback, so `req.socket.remoteAddress` really is 127.0.0.1. Any web page in any
    // browser on this machine can POST here without asking anyone's permission.
    for (const headers of [{}, { [EDGE_SECRET_HEADER]: ts.edgeSecret }]) {
      const res = await fetch(`${base}/operator/folders`, { headers });
      expect(res.status).toBe(404);
    }

    const create = await fetch(`${base}/operator/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'C:\\', label: 'everything' }),
    });
    expect(create.status).toBe(404);

    // …while the loopback listener still answers, so the 404 above is the guard rather than a
    // router that lost its routes.
    const real = await ts.fetch('/operator/folders');
    expect(real.status).toBe(200);
  });
});

describe('turning it on changes nothing about the encrypted listener', () => {
  it('leaves the HTTPS listener speaking TLS on the same certificate', async () => {
    const dataDir = tempDir('lc-plain-cert-');
    const before = await startServer({ lan: true, dataDir, lanHosts: ['192.168.66.6'] });
    const fingerprint = before.server.lanCertificate()?.fingerprint256;
    await before.dispose();

    const ts = await server({ lanPlaintext: true, dataDir, lanHosts: ['192.168.66.6'] });
    const res = await tlsRequest(lanPortOf(ts), '/api/v1/folders');

    expect(res.status).toBe(401);
    expect(res.peerFingerprint).toBe(fingerprint);
  });

  it('keeps the HTTPS listener refusing plain HTTP', async () => {
    const ts = await server({ lanPlaintext: true });
    // Two doors, not one door that now accepts both. A TLS server handed a plain request fails
    // the handshake and drops the socket.
    await expect(fetch(`http://127.0.0.1:${lanPortOf(ts)}/api/v1/folders`)).rejects.toThrow();
  });

  it('keeps loopback demanding the edge secret', async () => {
    const ts = await server({ lanPlaintext: true });
    const res = await fetch(`${ts.base}/api/v1/folders`);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/edge credentials/i);
  });

  it('publishes the unencrypted address once it is turned on, because otherwise the link is a dead end', async () => {
    const ts = await server({ lanPlaintext: true, lanHosts: ['192.168.88.8'] });
    const minted = await ts.json<{ qr: { url?: string }; link: string | null }>(
      '/operator/pairing',
      {
        method: 'POST',
        body: JSON.stringify({ ttlSeconds: 300 }),
        headers: { 'content-type': 'application/json' },
      },
    );

    /**
     * This assertion used to say the opposite, and reversing it was the point.
     *
     * Publishing the encrypted address kept the downgrade a deliberate act — a person had to
     * read an address off the panel and type it. But a QR pointing at a self-signed origin
     * leads a phone to a certificate interstitial, and an interstitial is not the app: the
     * scanned link stops there and never becomes a paired device. A switch whose published
     * address cannot complete the flow it exists to enable is not a safeguard.
     *
     * So when this listener is on it is the one advertised, and the panel says what it costs.
     * `lanPlaintext` is still off by default and still nothing derives it from `lan`.
     */
    expect(minted.link).toMatch(/^http:\/\//);
    expect(minted.link).toContain(String(plainPortOf(ts)));
    expect(minted.qr.url).toBe(ts.server.lanEndpoint()?.url);

    // The encrypted listener is untouched and still bound on its own port.
    expect(ts.server.lanAddress()?.port).not.toBe(plainPortOf(ts));
  });
});

describe('the addresses the panel is given', () => {
  const certificate = {
    hosts: ['localhost', '127.0.0.1', 'ali-pc', 'ali-pc.local', '192.168.1.50'],
    publishHost: '192.168.1.50',
    fingerprint256: 'AA:BB',
  } as unknown as LanCertificate;

  it('offers the IP and the .local name for the encrypted listener', () => {
    const access = buildLanAccess({ certificate, tlsPort: 8443, plaintextPort: null });
    expect(access.secure.map((a) => a.url)).toEqual([
      'https://192.168.1.50:8443',
      'https://ali-pc.local:8443',
    ]);
    // The name is worth publishing because it survives a DHCP lease — the address changing is
    // what forces a new certificate and therefore a second browser warning. It buys nothing
    // about trust: a self-signed certificate for a name is as untrusted as one for an IP.
    expect(access.secure[1]?.kind).toBe('name');
    expect(access.plaintext).toEqual([]);
  });

  it('marks the plaintext addresses as unencrypted and keeps them separate', () => {
    const access = buildLanAccess({ certificate, tlsPort: 8443, plaintextPort: 8081 });
    expect(access.plaintext.map((a) => a.url)).toEqual([
      'http://192.168.1.50:8081',
      'http://ali-pc.local:8081',
    ]);
    expect(access.plaintext.every((a) => !a.encrypted)).toBe(true);
    expect(access.secure.every((a) => a.encrypted)).toBe(true);
  });

  it('has nothing to offer when local sharing is off', () => {
    const access = buildLanAccess({ certificate: null, tlsPort: null, plaintextPort: null });
    expect(access).toEqual({ secure: [], plaintext: [], fingerprint256: null });
  });
});
