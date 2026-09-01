// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EDGE_SECRET_HEADER, type NetworkConfig } from '@localcast/contract';
import { createServer, silentLogger, type LocalCastServer } from '@localcast/server';

/**
 * Design spec 2.4: moving between Tailscale's coordination server and a personal Headscale
 * must not need a reinstall or a restart, and devices, permissions and pairings must survive
 * it.
 *
 * `netedge` owns no database, so the half of that claim about *data* is settled here. These
 * tests run the real `@localcast/server` in process against real SQLite, seed it through the
 * real pairing handshake, and then change the network configuration through the same handler
 * the settings page calls — `IPC.edgeApplyConfig`, registered by `registerIpc`. Nothing about
 * the database is stubbed: the assertions compare the actual rows, column for column,
 * including `token_version`, `refresh_hash` and `dav_password_hash`, because a switch that
 * bumped any of those would silently sign every paired device out.
 *
 * The last test spawns the real Go sidecar and switches it between two stand-in control
 * servers. It is the only place the "no restart" half can be observed from this side: the
 * proof is that `child_process.spawn` is called exactly once for the whole round trip.
 */

/**
 * This file is *about* remote access, so it runs with remote access switched on.
 *
 * `REMOTE_ACCESS_ENABLED` is false in the build as shipped, and `registerIpc` refuses every
 * edge call while it is — which would turn all of the below into one repeated "remote access
 * is switched off" and prove nothing. Overriding the flag here is what keeps this evidence
 * alive while the feature is parked: the day it is switched back on, these tests have been
 * green all along rather than being rediscovered as a wall of failures. `importOriginal` so
 * the other flags keep whatever value they really have.
 */
vi.mock('../../shared/features.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/features.js')>()),
  REMOTE_ACCESS_ENABLED: true,
}));

// ── the Electron boundary ────────────────────────────────────────────────────
// `registerIpc` talks to `ipcMain`, so the handlers are captured here and invoked directly.
// That is the point: the test drives the same function the renderer's `edge:apply-config`
// call reaches, not a re-implementation of it.
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => undefined },
  app: { getVersion: () => '0.0.0-test', getPath: () => tmpdir(), isPackaged: false },
}));

// Wrapping rather than replacing: the sidecar has to really start. Counting the calls is how
// this side proves a mode switch reconfigures the child process instead of replacing it.
const spawns = vi.hoisted(() => ({ pids: [] as Array<number | undefined> }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawns.pids.push(child.pid);
      return child;
    },
  };
});

const { registerIpc } = await import('../ipc.js');
const { OperatorClient } = await import('../operatorClient.js');
const { NetEdge } = await import('../netedge.js');
const { AppConfigStore, configPathFor } = await import('../appConfig.js');
const { IPC } = await import('../../shared/ipc.js');

// Hex, and at least 16 bytes of it: the sidecar refuses to start otherwise, and the contract
// describes this value as hex-encoded. A readable-but-invalid string here would fail as
// "control API is not up yet" several seconds later, which points nowhere near the cause.
const EDGE_SECRET = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

// ── configurations ───────────────────────────────────────────────────────────

/**
 * A self-hosted control server has to be tailnet-only with external-proxy: the contract
 * refuses Funnel and control-plane certificates there, because Headscale implements neither
 * (spec 2.3). external-proxy also keeps ACME out of these tests entirely.
 */
function headscale(controlUrl: string, overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    mode: 'custom',
    controlUrl,
    expose: 'tailnet',
    certStrategy: 'external-proxy',
    certDomain: 'media.example.test',
    hostname: 'localcast',
    ...overrides,
  } as NetworkConfig;
}

// ── stand-in control server ──────────────────────────────────────────────────

/**
 * What the sidecar's dry run and its tsnet node talk to.
 *
 * It is not a control plane. It answers the first request of the handshake and refuses it,
 * which is all `POST /edge/test` needs to call the address reachable, and all a starting node
 * needs to keep addressing the URL it was configured with.
 */
async function startFakeControl(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: HttpServer = createHttpServer((_req, res) => {
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

// ── the database, as the user's data ─────────────────────────────────────────

interface Snapshot {
  devices: unknown[];
  permissions: unknown[];
  pairings: unknown[];
  folders: unknown[];
}

/**
 * `SELECT *`, deliberately. Naming the columns would let a schema change quietly drop the one
 * that mattered, and the columns that matter most here are the ones nobody thinks to assert
 * on: `token_version` invalidates every access token when it moves, `refresh_hash` and
 * `dav_password_hash` are what a device signs in with.
 */
function snapshot(server: LocalCastServer): Snapshot {
  const { db } = server.ctx;
  return {
    devices: db.prepare('SELECT * FROM devices ORDER BY id').all(),
    permissions: db
      .prepare('SELECT * FROM folder_permissions ORDER BY device_id, folder_id')
      .all(),
    pairings: db.prepare('SELECT * FROM pairing_tokens ORDER BY id').all(),
    folders: db.prepare('SELECT * FROM shared_folders ORDER BY id').all(),
  };
}

function storedNetworkConfig(server: LocalCastServer): Record<string, unknown> {
  return server.ctx.db.prepare('SELECT * FROM network_config WHERE id = 1').get() as Record<
    string,
    unknown
  >;
}

// ── harness ──────────────────────────────────────────────────────────────────

interface Harness {
  server: LocalCastServer;
  base: string;
  port: number;
  dataDir: string;
  apply: (config: NetworkConfig) => Promise<unknown>;
  restarts: NetworkConfig[];
  dispose: () => Promise<void>;
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-modeswitch-'));
  tempDirs.push(dir);
  return dir;
}

/** Adds the edge secret to every call, exactly as the sidecar does when it proxies. */
function edgeFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(EDGE_SECRET_HEADER, EDGE_SECRET);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return fetch(base + path, { ...init, headers });
}

/**
 * `edge()` as `registerIpc` sees it. `test` and `applyConfig` are the only two methods the
 * apply path touches; everything else on NetEdge is out of scope for the data question and is
 * covered by the sidecar-backed test at the end of this file.
 */
interface EdgeStub {
  test: (config: NetworkConfig) => Promise<{ ok: boolean; messages: Array<{ level: string; text: string }> }>;
  applyConfig: (config: NetworkConfig) => Promise<unknown>;
  status: unknown;
}

async function startHarness(edge: EdgeStub): Promise<Harness> {
  const dataDir = tempDir();
  const server = await createServer({
    dataDir,
    edgeSecret: EDGE_SECRET,
    jwtSecret: 'mode-switch-signing-key-not-a-real-one',
    log: silentLogger,
    logLevel: 'silent',
    indexOnStart: false,
    lan: false,
    publicHost: 'test.localcast.example',
  });
  const addr = await server.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;

  const restarts: NetworkConfig[] = [];
  electron.handlers.clear();
  registerIpc({
    edge: () => edge as never,
    operator: () => new OperatorClient(addr.port, EDGE_SECRET),
    appConfig: new AppConfigStore(configPathFor(dataDir)),
    version: '0.0.0-test',
    serverPort: () => addr.port,
    lanEndpoint: () => ({ url: null, fingerprint: null }),
    // Wired exactly as apps/desktop/src/main/index.ts wires it.
    restartEdge: async (config: NetworkConfig) => {
      restarts.push(config);
      return edge.applyConfig(config) as never;
    },
  });

  const apply = (config: NetworkConfig): Promise<unknown> => {
    const handler = electron.handlers.get(IPC.edgeApplyConfig);
    if (!handler) throw new Error('edge:apply-config was never registered');
    return Promise.resolve(handler({}, config));
  };

  return {
    server,
    base,
    port: addr.port,
    dataDir,
    apply,
    restarts,
    dispose: () => server.dispose(),
  };
}

/** An edge that agrees to everything, so the apply path is exercised end to end. */
function agreeableEdge(): EdgeStub {
  return {
    test: async () => ({ ok: true, messages: [] }),
    applyConfig: async () => ({ state: 'starting' }),
    status: { state: 'starting' },
  };
}

// ── seeding: the things a user would lose ────────────────────────────────────

interface Seeded {
  deviceId: string;
  folderId: string;
  outstandingPairing: string;
}

/**
 * Runs the real pairing handshake — mint, claim, approve, poll — and grants a permission
 * through the real operator route, so what the switch is asked to preserve is what the
 * product actually produces rather than rows written by the test.
 */
async function seed(h: Harness): Promise<Seeded> {
  const folderDir = tempDir();
  const folderRes = await edgeFetch(h.base, '/operator/folders', {
    method: 'POST',
    body: JSON.stringify({ path: folderDir, label: 'Films', writable: false }),
  });
  expect(folderRes.status).toBe(201);
  const folder = (await folderRes.json()) as { id: string };

  const mintRes = await edgeFetch(h.base, '/operator/pairing', {
    method: 'POST',
    body: JSON.stringify({ defaultPermissions: [{ folderId: folder.id, mode: 'stream' }], ttlSeconds: 600 }),
  });
  expect(mintRes.status).toBe(201);
  const minted = (await mintRes.json()) as { code: string; qr: { secret: string } };

  const claimRes = await edgeFetch(h.base, '/api/v1/pair/claim', {
    method: 'POST',
    body: JSON.stringify({
      code: minted.code,
      secret: minted.qr.secret,
      deviceName: 'Ali Phone',
      platform: 'ios-pwa',
    }),
  });
  expect(claimRes.status).toBe(201);
  const claim = (await claimRes.json()) as { deviceId: string; claimTicket: string };

  const approveRes = await edgeFetch(h.base, `/operator/devices/${claim.deviceId}/approve`, {
    method: 'POST',
  });
  expect(approveRes.ok).toBe(true);

  const pollRes = await edgeFetch(
    h.base,
    `/api/v1/pair/status/${claim.deviceId}?ticket=${encodeURIComponent(claim.claimTicket)}`,
  );
  expect(((await pollRes.json()) as { status: string }).status).toBe('approved');

  // Through the panel's own IPC handler, so the permission row is written by the code the
  // user's click reaches.
  const setPermissions = electron.handlers.get(IPC.devicePermissions);
  if (!setPermissions) throw new Error('device:permissions was never registered');
  await setPermissions({}, claim.deviceId, [{ folderId: folder.id, mode: 'full' }]);

  // A second, unconsumed invitation: a code the user has handed out but nobody has scanned
  // yet is exactly the kind of thing a restart would quietly destroy.
  const outstandingRes = await edgeFetch(h.base, '/operator/pairing', {
    method: 'POST',
    body: JSON.stringify({ defaultPermissions: [], ttlSeconds: 600 }),
  });
  expect(outstandingRes.status).toBe(201);

  return {
    deviceId: claim.deviceId,
    folderId: folder.id,
    outstandingPairing: ((await outstandingRes.json()) as { code: string }).code,
  };
}

// ── suite ────────────────────────────────────────────────────────────────────

const controls: Array<{ close: () => Promise<void> }> = [];
let controlA: { url: string; close: () => Promise<void> };
let controlB: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  controlA = await startFakeControl();
  controlB = await startFakeControl();
  controls.push(controlA, controlB);
});

afterAll(async () => {
  for (const c of controls) await c.close();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A Windows handle held open by a just-closed database is not worth failing on.
    }
  }
});

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
  spawns.pids.length = 0;
});

describe('switching control servers', () => {
  it('leaves every device, permission and pairing row untouched', async () => {
    harness = await startHarness(agreeableEdge());
    const seeded = await seed(harness);

    const before = snapshot(harness.server);
    expect(before.devices).toHaveLength(1);
    expect(before.permissions).toHaveLength(1);
    expect(before.pairings).toHaveLength(2);

    await harness.apply(headscale(controlA.url, { authKey: 'dpapi-ciphertext-for-the-preauth-key' }));

    const after = snapshot(harness.server);
    expect(after).toEqual(before);

    // And the switch did happen: the assertion above would also pass if nothing had.
    const stored = storedNetworkConfig(harness.server);
    expect(stored['mode']).toBe('custom');
    expect(stored['control_url']).toBe(controlA.url);
    expect(harness.restarts).toHaveLength(1);
    expect(harness.restarts[0]?.controlUrl).toBe(controlA.url);

    // The device is still usable, not merely still on disk: the operator API answers for it
    // and its permission is still readable through the panel's own handler.
    const devices = (await edgeFetch(harness.base, '/operator/devices').then((r) => r.json())) as {
      devices: Array<{ id: string; status: string }>;
    };
    expect(devices.devices.find((d) => d.id === seeded.deviceId)?.status).toBe('active');
  });

  it('restores the first configuration when the user switches back', async () => {
    harness = await startHarness(agreeableEdge());
    await seed(harness);

    const original = storedNetworkConfig(harness.server);
    const before = snapshot(harness.server);

    await harness.apply(headscale(controlA.url, { authKey: 'dpapi-ciphertext' }));
    await harness.apply({
      mode: 'default',
      expose: 'tailnet',
      certStrategy: 'control-plane',
      hostname: 'localcast',
    } as NetworkConfig);

    const restored = storedNetworkConfig(harness.server);
    expect(restored['mode']).toBe(original['mode']);
    expect(restored['expose']).toBe(original['expose']);
    expect(restored['cert_strategy']).toBe(original['cert_strategy']);
    expect(restored['hostname']).toBe(original['hostname']);

    // The Headscale pre-authentication key is still on file. Losing it on the way back would
    // mean retyping it to switch again, which is the same friction as a reinstall.
    expect(restored['auth_key_enc']).toBe('dpapi-ciphertext');

    expect(snapshot(harness.server)).toEqual(before);
    expect(harness.restarts).toHaveLength(2);
  });

  it('re-applying the same configuration changes nothing a user can see', async () => {
    harness = await startHarness(agreeableEdge());
    await seed(harness);

    const config = headscale(controlA.url, { authKey: 'dpapi-ciphertext' });
    await harness.apply(config);

    const before = snapshot(harness.server);
    const storedBefore = storedNetworkConfig(harness.server);

    await harness.apply(config);
    await harness.apply(config);

    expect(snapshot(harness.server)).toEqual(before);
    const storedAfter = storedNetworkConfig(harness.server);
    // Everything but the timestamp: `updated_at` is stamped on every write by design.
    expect({ ...storedAfter, updated_at: 0 }).toEqual({ ...storedBefore, updated_at: 0 });
    // Each save is still a real restart of the node. That is deliberate — re-saving is also
    // how a user retries a configuration that failed to come up — so it is asserted rather
    // than left to be discovered.
    expect(harness.restarts).toHaveLength(3);
  });

  it('stores nothing when the sidecar says the configuration cannot work', async () => {
    const refusing: EdgeStub = {
      ...agreeableEdge(),
      test: async () => ({
        ok: false,
        messages: [{ level: 'error', text: 'Headscale cannot issue a certificate.' }],
      }),
    };
    harness = await startHarness(refusing);
    await seed(harness);

    const before = snapshot(harness.server);
    const storedBefore = storedNetworkConfig(harness.server);

    await expect(
      harness.apply(headscale(controlA.url, { certStrategy: 'control-plane' } as Partial<NetworkConfig>)),
    ).rejects.toThrow(/certificate/i);

    expect(snapshot(harness.server)).toEqual(before);
    expect(storedNetworkConfig(harness.server)).toEqual(storedBefore);
    expect(harness.restarts).toHaveLength(0);
  });
});

// ── the real sidecar ─────────────────────────────────────────────────────────

const sidecar = resolve(import.meta.dirname, '../../../../../native/netedge/netedge.exe');
const haveSidecar = existsSync(sidecar);

describe.skipIf(!haveSidecar)('switching the real sidecar', () => {
  /**
   * The end-to-end version: the real Go binary, the real control API, a real tsnet node moved
   * between two stand-in coordination servers — and the real database underneath it all.
   *
   * `spawn` is counted because that is the only way this side can see the difference between
   * "reconfigured in place" and "restarted". One call for the whole round trip is the claim.
   *
   * Skipped when `netedge.exe` has not been built (`npm run netedge:build`). A skip is not a
   * pass: the four tests above still settle the data question without it.
   */
  it('reconfigures in place, without respawning the process or touching the database', async () => {
    const stateDir = tempDir();
    const edge = new NetEdge({
      stateDir,
      configPath: join(stateDir, 'netedge.json'),
      upstream: '127.0.0.1:1', // never dialled: nothing proxies through the node in this test
      sharedSecret: EDGE_SECRET,
      binaryPath: sidecar,
    });

    const exits: Array<number | null> = [];
    edge.on('exit', (code) => exits.push(code));
    // Kept so a sidecar that refuses to start says why, instead of surfacing several seconds
    // later as "the control API is not up yet".
    const complaints: string[] = [];
    edge.on('log', (level, message) => {
      if (level === 'error' || level === 'warn') complaints.push(`${level}: ${message}`);
    });

    harness = await startHarness(edge as unknown as EdgeStub);
    const seeded = await seed(harness);
    const before = snapshot(harness.server);

    await edge.start();
    // The `ready` event carries the control port; nothing can be asked of the sidecar before
    // it arrives.
    try {
      await vi.waitFor(
        async () => {
          await edge.refreshStatus();
        },
        { timeout: 15_000, interval: 100 },
      );
    } catch (err) {
      throw new Error(
        `the sidecar never answered its control API. It said: ${complaints.join(' | ') || '(nothing)'}`,
        { cause: err },
      );
    }

    try {
      await harness.apply(headscale(controlA.url));
      expect(edge.status.state).not.toBe('stopped');
      const firstConfig = storedNetworkConfig(harness.server);
      expect(firstConfig['control_url']).toBe(controlA.url);

      await harness.apply(headscale(controlB.url));
      await harness.apply(headscale(controlA.url));

      // One spawn for the whole round trip: the sidecar was reconfigured, never replaced.
      expect(spawns.pids).toHaveLength(1);
      expect(exits).toHaveLength(0);
      expect(edge.running).toBe(true);

      // Back on the first control server, in the sidecar's own record of it as well as the
      // database's — switching away and back is not a one-way door. The sidecar writes this
      // file only after Apply has succeeded, so its contents are the node's own account of
      // what it is running, and what it would come back up on after a restart.
      const persisted = JSON.parse(
        readFileSync(join(stateDir, 'netedge.json'), 'utf8'),
      ) as { network: { controlUrl?: string; authKey?: string } };
      expect(persisted.network.controlUrl).toBe(controlA.url);
      // The pre-authentication key is never written to disk by the sidecar; DPAPI holds it.
      expect(persisted.network.authKey).toBeUndefined();
      expect(storedNetworkConfig(harness.server)['control_url']).toBe(controlA.url);

      // And the database is where it was before any of it started.
      expect(snapshot(harness.server)).toEqual(before);
      const devices = (await edgeFetch(harness.base, '/operator/devices').then((r) => r.json())) as {
        devices: Array<{ id: string; status: string }>;
      };
      expect(devices.devices.find((d) => d.id === seeded.deviceId)?.status).toBe('active');
    } finally {
      await edge.stop();
    }
  }, 60_000);
});
