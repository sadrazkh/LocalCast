import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { StoredNetworkConfig } from '../src/http/routes/operatorNetwork.js';
import {
  addFolder,
  bearer,
  cleanupTempDirs,
  pairDevice,
  postJson,
  startServer,
  type TestServer,
} from './helpers.js';

/**
 * The two halves of the promise that live in this package.
 *
 * **Local by default.** `ServerConfig.lan` is off, so the core opens nothing but loopback
 * unless it is told to. The desktop is what tells it, from a preference the user can see;
 * nothing here reads the environment or guesses.
 *
 * **A mode switch is not a reinstall.** Moving between the default coordination server and a
 * personal Headscale replaces the tailnet node in place. In this package that means the
 * network configuration is one row, and changing it touches nothing else: the same devices,
 * the same pairings, the same permissions and the same signing key on both sides of the
 * switch — so a token minted before it still works after it.
 */

const started: TestServer[] = [];

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

async function serve(overrides: Parameters<typeof startServer>[0] = {}): Promise<TestServer> {
  const ts = await startServer(overrides);
  started.push(ts);
  return ts;
}

describe('the default server configuration', () => {
  it('does not share on the local network unless it is asked to', () => {
    const config = loadConfig();

    // The single most load-bearing default in the package. A `true` here would put the whole
    // API on the Wi-Fi for every embedder — the CLI, a test, anything that calls loadConfig —
    // rather than only for a desktop whose owner turned the switch on.
    expect(config.lan).toBe(false);
    expect(config.lanPort).toBe(0);
    expect(config.lanHosts).toEqual([]);
    // And the listener that does exist stays on loopback, where `netedge` is the only caller.
    expect(config.host).toBe('127.0.0.1');
  });

  it('opens the local network only through the explicit flag', () => {
    expect(loadConfig({ lan: true }).lan).toBe(true);
  });
});

interface Snapshot {
  devices: unknown[];
  permissions: unknown[];
  pairings: unknown[];
  folders: unknown[];
}

/** Every row a mode switch is forbidden to disturb. */
function snapshot(ts: TestServer): Snapshot {
  const { db } = ts.server.ctx;
  return {
    devices: db.prepare('SELECT * FROM devices ORDER BY id').all(),
    permissions: db
      .prepare('SELECT * FROM folder_permissions ORDER BY device_id, folder_id')
      .all(),
    pairings: db.prepare('SELECT * FROM pairing_tokens ORDER BY code').all(),
    folders: db.prepare('SELECT * FROM shared_folders ORDER BY id').all(),
  };
}

const HEADSCALE = {
  mode: 'custom',
  controlUrl: 'https://headscale.example.com',
  expose: 'tailnet',
  certStrategy: 'external-proxy',
  certDomain: 'localcast.example.com',
  hostname: 'localcast',
};

const TAILSCALE = {
  mode: 'default',
  expose: 'tailnet',
  certStrategy: 'control-plane',
  hostname: 'localcast',
};

describe('moving between the default coordination server and a personal Headscale', () => {
  it('leaves every device, pairing and permission exactly as it was', async () => {
    const ts = await serve();
    const folderId = await addFolder(ts, { path: ts.root, label: 'Media' });
    const device = await pairDevice(ts, [{ folderId, mode: 'full' }]);

    const before = snapshot(ts);

    const toHeadscale = await ts.json<StoredNetworkConfig>(
      '/operator/network-config',
      postJson(HEADSCALE),
    );
    // Proof the switch actually happened. Without this the equality below could pass because
    // nothing changed at all, which is the vacuous version of this test.
    expect(toHeadscale.mode).toBe('custom');
    expect(toHeadscale.controlUrl).toBe(HEADSCALE.controlUrl);

    const andBack = await ts.json<StoredNetworkConfig>(
      '/operator/network-config',
      postJson(TAILSCALE),
    );
    expect(andBack.mode).toBe('default');

    // The whole promise of spec 2.4, expressed as rows: switching control planes is a
    // configuration change, never a re-pairing.
    expect(snapshot(ts)).toEqual(before);

    // And the credential a phone is holding is still the same credential. Regenerating the
    // signing key would sign every paired device out — the failure this is here to catch.
    const me = await ts.fetch('/api/v1/me', { headers: bearer(device.accessToken) });
    expect(me.status).toBe(200);
    expect((await me.json()).device.id).toBe(device.deviceId);
  });

  it('publishes the new hostname on the next QR code without a restart', async () => {
    const ts = await serve();

    // What the sidecar does after a switch: the tailnet node comes back under a different
    // MagicDNS name and hands it over. Pairing reads the value at mint time, so the next code
    // carries it — the server is never rebuilt and no listener is rebound.
    ts.server.config.publicHost = 'localcast.headscale.example.com';

    const minted = await ts.json<{ qr: { host: string } }>(
      '/operator/pairing',
      postJson({ ttlSeconds: 300 }),
    );
    expect(minted.qr.host).toBe('localcast.headscale.example.com');
  });
});
