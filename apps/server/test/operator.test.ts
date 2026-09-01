import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bearer,
  cleanupTempDirs,
  pairDevice,
  postJson,
  startServer,
  tempDir,
  type PairedDevice,
  type TestServer,
} from './helpers.js';

/**
 * The operator API as the Windows panel actually calls it.
 *
 * `apps/desktop/src/main/ipc.ts` is the specification for this surface: every path it asks
 * for has to answer, and the last test in this file is the one that says so.
 */

// ── the fake Windows boundary ────────────────────────────────────────────────
// Printer enumeration is the print module's single PowerShell call, so it is faked where it
// meets the operating system rather than by giving the routes a "pretend" mode.
const ps = vi.hoisted(() => ({ json: '[]', fails: false, scripts: [] as string[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      ps.scripts.push(String(args[args.length - 1] ?? ''));
      queueMicrotask(() =>
        ps.fails
          ? callback(new Error('Get-Printer : The Print Spooler service is not running'), '', '')
          : callback(null, ps.json, ''),
      );
      return undefined;
    },
  };
});

const HEADSCALE = {
  mode: 'custom',
  controlUrl: 'https://headscale.example.com',
  expose: 'tailnet',
  certStrategy: 'external-proxy',
  certDomain: 'media.example.com',
  hostname: 'localcast',
} as const;

/** Stands in for what Electron's `safeStorage` hands the server: opaque base64 ciphertext. */
const CIPHERTEXT = 'v10AAAABBBCCC-dpapi-blob==';

interface StoredConfig {
  mode: string;
  hostname: string;
  certStrategy: string;
  certDomain?: string;
  hasAuthKey: boolean;
  hasDnsApiToken: boolean;
  authKey?: string;
  dnsApiToken?: string;
}

let ts: TestServer;

beforeEach(async () => {
  ps.json = '[]';
  ps.fails = false;
  ps.scripts.length = 0;
  ts = await startServer();
});

afterEach(async () => {
  await ts?.dispose();
});

afterAll(cleanupTempDirs);

function storedSecrets(): { auth_key_enc: string | null; dns_token_enc: string | null } {
  return ts.server.ctx.db
    .prepare('SELECT auth_key_enc, dns_token_enc FROM network_config WHERE id = 1')
    .get() as { auth_key_enc: string | null; dns_token_enc: string | null };
}

function addPrinter(name: string, enabled: boolean): string {
  const id = randomUUID();
  ts.server.ctx.db
    .prepare(
      `INSERT INTO printers
         (id, name, driver, is_default, color_capable, duplex_capable, status, online, enabled, last_seen_at)
       VALUES (?, ?, 'Test Driver', 0, 1, 1, 'Normal', 1, ?, ?)`,
    )
    .run(id, name, enabled ? 1 : 0, Date.now());
  return id;
}

describe('GET/POST /operator/network-config', () => {
  it('answers with the seeded row and reports no secrets on a fresh install', async () => {
    const config = await ts.json<StoredConfig>('/operator/network-config');
    expect(config).toMatchObject({
      mode: 'default',
      certStrategy: 'control-plane',
      hostname: 'localcast',
      hasAuthKey: false,
      hasDnsApiToken: false,
    });
    // Absent, not null: the panel hands this object straight back to POST, and the contract
    // schema accepts a missing optional field but not a null one.
    expect('controlUrl' in config).toBe(false);
  });

  it('round-trips a configuration and never hands the ciphertext back', async () => {
    const saved = await ts.fetch(
      '/operator/network-config',
      postJson({ ...HEADSCALE, authKey: CIPHERTEXT }),
    );
    expect(saved.status).toBe(200);
    const body = await saved.text();
    expect(body).not.toContain(CIPHERTEXT);
    expect(JSON.parse(body)).toMatchObject({ mode: 'custom', hasAuthKey: true });

    // Stored verbatim: the server holds DPAPI ciphertext it cannot read and must not alter.
    expect(storedSecrets().auth_key_enc).toBe(CIPHERTEXT);

    const reread = await ts.json<StoredConfig>('/operator/network-config');
    expect(reread).toMatchObject({ controlUrl: HEADSCALE.controlUrl, hasAuthKey: true });
    expect(reread.authKey).toBeUndefined();
  });

  it('keeps the stored key when a save omits the secret the user did not retype', async () => {
    await ts.fetch('/operator/network-config', postJson({ ...HEADSCALE, authKey: CIPHERTEXT }));

    // Exactly what the settings screen sends when only the hostname changed: the masked
    // secret field is left out. Wiping it here would silently unpair the user's Headscale.
    const res = await ts.fetch(
      '/operator/network-config',
      postJson({ ...HEADSCALE, hostname: 'mediabox' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hostname: 'mediabox', hasAuthKey: true });
    expect(storedSecrets().auth_key_enc).toBe(CIPHERTEXT);
  });

  it('refuses a Headscale that asks the control plane for certificates', async () => {
    const res = await ts.fetch(
      '/operator/network-config',
      postJson({ ...HEADSCALE, certStrategy: 'control-plane' }),
    );

    expect(res.status).toBe(400);
    const error = (await res.json()) as {
      error: { code: string; detail?: { issues: { path: string }[] } };
    };
    expect(error.error.code).toBe('bad_request');
    expect(error.error.detail?.issues.map((issue) => issue.path)).toContain('certStrategy');

    // Nothing was written: a rejected configuration must not half-apply.
    const config = await ts.json<StoredConfig>('/operator/network-config');
    expect(config.mode).toBe('default');
  });
});

describe('the operator printer list', () => {
  let device: PairedDevice;

  beforeEach(async () => {
    device = await pairDevice(ts);
  });

  it('shows a hidden printer that the device API does not', async () => {
    addPrinter('Office Laser', true);
    const hidden = addPrinter('Hidden Plotter', false);

    const operator = await ts.json<{ printers: { id: string; enabled: boolean }[] }>(
      '/operator/printers',
    );
    expect(operator.printers.map((p) => p.enabled)).toEqual([false, true]);
    expect(operator.printers.some((p) => p.id === hidden)).toBe(true);

    const client = await ts.json<{ printers: { name: string }[] }>('/api/v1/printers', {
      headers: bearer(device.accessToken),
    });
    expect(client.printers.map((p) => p.name)).toEqual(['Office Laser']);
    // The seeded rows are fresh, so nothing shelled out to Windows on either read.
    expect(ps.scripts).toEqual([]);
  });

  it('re-enumerates on demand and leaves the operator hide flag alone', async () => {
    const hidden = addPrinter('Hidden Plotter', false);
    ps.json = JSON.stringify([
      { Name: 'Hidden Plotter', Driver: 'HP Universal', Status: 'Normal', Online: true },
      { Name: 'New Printer', Driver: 'Brother', Status: 'Normal', Online: true },
    ]);

    const res = await ts.fetch('/operator/printers/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const { printers } = (await res.json()) as {
      printers: { id: string; name: string; driver: string | null; enabled: boolean }[];
    };

    expect(printers.map((p) => p.name)).toEqual(['Hidden Plotter', 'New Printer']);
    expect(printers.find((p) => p.id === hidden)).toMatchObject({
      driver: 'HP Universal',
      enabled: false,
    });
    expect(ps.scripts.some((script) => script.includes('Get-Printer'))).toBe(true);
  });

  it('hides a printer from the device API when the operator switches it off', async () => {
    const id = addPrinter('Office Laser', true);

    const patched = await ts.fetch(`/operator/printers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ enabled: false });

    const client = await ts.json<{ printers: unknown[] }>('/api/v1/printers', {
      headers: bearer(device.accessToken),
    });
    expect(client.printers).toEqual([]);
  });
});

describe('every path the Windows panel calls', () => {
  it('resolves to a route instead of a 404', async () => {
    // Transcribed from `apps/desktop/src/main/ipc.ts`, in an order that keeps every target
    // alive until the call that needs it: the device is approved and renamed before it is
    // rejected, and the folder is deleted last.
    const device = await pairDevice(ts);
    const printerId = addPrinter('Office Laser', true);
    const folderPath = tempDir('lc-op-');

    const created = await ts.fetch('/operator/folders', postJson({ path: folderPath, label: 'Sweep' }));
    const folderId = ((await created.json()) as { id: string }).id;

    const json = (body: unknown, method = 'POST'): RequestInit => ({
      method,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });

    const calls: Array<[string, RequestInit]> = [
      ['/operator/network-config', {}],
      ['/operator/network-config', json({ mode: 'default', expose: 'tailnet', certStrategy: 'control-plane', hostname: 'localcast' })],
      ['/operator/folders', {}],
      [`/operator/folders/${folderId}`, json({ label: 'Sweep II' }, 'PATCH')],
      [`/operator/folders/${folderId}/reindex`, { method: 'POST' }],
      ['/operator/folders/reindex', { method: 'POST' }],
      ['/operator/devices', {}],
      [`/operator/devices/${device.deviceId}/approve`, { method: 'POST' }],
      [`/operator/devices/${device.deviceId}`, json({ name: 'Ali Phone' }, 'PATCH')],
      [
        `/operator/devices/${device.deviceId}/permissions`,
        json({ deviceId: device.deviceId, permissions: [{ folderId, mode: 'stream' }] }),
      ],
      [`/operator/devices/${device.deviceId}/reject`, { method: 'POST' }],
      [`/operator/devices/${device.deviceId}/revoke`, { method: 'POST' }],
      ['/operator/pairing', json({ defaultPermissions: [] })],
      ['/operator/printers', {}],
      ['/operator/printers/refresh', { method: 'POST' }],
      [`/operator/printers/${printerId}`, json({ enabled: true }, 'PATCH')],
      ['/operator/activity?limit=100', {}],
      // Removing the folder is last, so the calls above still had one to work on.
      [`/operator/folders/${folderId}`, { method: 'DELETE' }],
    ];

    const missing: string[] = [];
    for (const [url, init] of calls) {
      const res = await ts.fetch(url, init);
      if (res.status === 404) missing.push(`${init.method ?? 'GET'} ${url}`);
    }
    expect(missing).toEqual([]);
  });
});
