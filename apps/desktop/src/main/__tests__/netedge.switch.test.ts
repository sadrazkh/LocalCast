// @vitest-environment node
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDGE_ROUTES, type EdgeStatus, type NetworkConfig } from '@localcast/contract';

/**
 * Switching between the default coordination server and a personal Headscale is a
 * configuration change, not a reinstall and not even a restart.
 *
 * The Go side does the real work: `Edge.Apply` tears the tsnet node down and builds another
 * one *inside the running process*, which is why the state directory, the pairing records and
 * the whole database survive a switch. From this side the observable form of that promise is
 * narrow and exact: `applyConfig` talks to the sidecar's control API, and the sidecar is the
 * same operating-system process before and after. If that ever became a stop/start, every
 * device would be waiting on a node that had gone away and come back under a new name.
 *
 * So this watches the spawn count. One process, two configurations.
 */

const h = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[] }>,
  kills: 0,
  child: null as null | (EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    kill(): void;
  }),
}));

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      kill() {
        h.kills += 1;
        // A real sidecar exits when it is killed, and it does so after the caller has had a
        // chance to listen. Modelling both matters: without it a regression that *did* restart
        // the process would fail here as a five-second timeout rather than as an assertion
        // naming the second spawn.
        setImmediate(() => {
          child.exitCode = 0;
          child.emit('exit', 0);
        });
      },
    });
    h.spawns.push({ file, args });
    h.child = child;
    return child;
  },
}));

const { NetEdge } = await import('../netedge.js');

const CONNECTED: EdgeStatus = {
  state: 'connected',
  host: 'localcast.tail1234.ts.net',
  funnelUrl: null,
  loginUrl: null,
  errorCode: null,
  errorMessage: null,
  certExpiresAt: null,
  peers: 1,
  updatedAt: 1,
};

const TAILSCALE: NetworkConfig = {
  mode: 'default',
  expose: 'tailnet',
  certStrategy: 'control-plane',
  hostname: 'localcast',
};

const HEADSCALE: NetworkConfig = {
  mode: 'custom',
  controlUrl: 'https://headscale.example.com',
  expose: 'tailnet',
  certStrategy: 'external-proxy',
  certDomain: 'localcast.example.com',
  hostname: 'localcast',
};

interface Control {
  server: Server;
  port: number;
  /** Every config the sidecar was handed, in order. */
  applied: NetworkConfig[];
  /** What `GET /edge/status` answers next. */
  status: EdgeStatus;
  secrets: string[];
}

/** Stands in for `netedge`'s loopback control API — the only thing `applyConfig` talks to. */
async function startControl(): Promise<Control> {
  const state: Partial<Control> = { applied: [], status: { ...CONNECTED }, secrets: [] };

  const server = createServer((req, res) => {
    state.secrets!.push(req.headers['x-lc-edge-secret'] as string);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'PUT' && req.url === EDGE_ROUTES.config) {
        const config = JSON.parse(body) as NetworkConfig;
        state.applied!.push(config);
        // What the Go side does on a switch: the node comes back under a name that belongs to
        // the new control plane, without the process going anywhere.
        state.status = {
          ...CONNECTED,
          host: config.mode === 'custom' ? 'localcast.example.com' : CONNECTED.host,
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (req.method === 'GET' && req.url === EDGE_ROUTES.status) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state.status));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return Object.assign(state as Control, {
    server,
    port: (server.address() as AddressInfo).port,
  });
}

const dirs: string[] = [];
let control: Control;

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-netedge-'));
  dirs.push(dir);
  return dir;
}

beforeEach(async () => {
  h.spawns.length = 0;
  h.kills = 0;
  h.child = null;
  control = await startControl();
});

afterEach(async () => {
  await new Promise<void>((done) => {
    control.server.closeAllConnections();
    control.server.close(() => done());
  });
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Brings a NetEdge up against the fake control API and waits for it to be reachable. */
async function runningEdge() {
  const root = freshDir();
  const binaryPath = join(root, 'netedge.exe');
  writeFileSync(binaryPath, 'not a real binary', 'utf8');

  const edge = new NetEdge({
    stateDir: join(root, 'tsnet'),
    configPath: join(root, 'netedge.json'),
    upstream: '127.0.0.1:45999',
    sharedSecret: 'shared-secret-for-the-test',
    binaryPath,
  });

  await edge.start();
  // The sidecar announces its control port on stdout; this is how the supervisor learns where
  // to send `PUT /edge/config`.
  h.child!.stdout.write(`${JSON.stringify({ type: 'ready', controlPort: control.port })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  return edge;
}

describe('applying a new network configuration', () => {
  it('reconfigures the running sidecar instead of restarting it', async () => {
    const edge = await runningEdge();
    expect(h.spawns).toHaveLength(1);
    const childBefore = h.child;

    // Caught rather than awaited bare, so that a regression which restarts the sidecar fails
    // on the spawn count below — the thing this test is about — instead of on the first call
    // that lands on the dead control port.
    const status = (await edge.applyConfig(HEADSCALE).catch((err: unknown) => err)) as EdgeStatus;

    // The whole point. A second entry here would mean the sidecar was stopped and started,
    // which is a new tsnet node, a new identity and every connected device dropped.
    expect(h.spawns).toHaveLength(1);
    expect(h.kills).toBe(0);
    expect(h.child).toBe(childBefore);
    expect(edge.running).toBe(true);

    // …and the switch really happened, so the assertions above are not about a no-op.
    expect(control.applied).toHaveLength(1);
    expect(control.applied[0]?.mode).toBe('custom');
    expect(control.applied[0]?.controlUrl).toBe(HEADSCALE.controlUrl);
    expect(status.host).toBe('localcast.example.com');
  });

  it('switches back the same way', async () => {
    const edge = await runningEdge();

    await edge.applyConfig(HEADSCALE).catch((err: unknown) => err);
    const back = (await edge.applyConfig(TAILSCALE).catch((err: unknown) => err)) as EdgeStatus;

    // Two switches, still one process. Changing your mind is not a reinstall either.
    expect(h.spawns).toHaveLength(1);
    expect(h.kills).toBe(0);
    expect(control.applied.map((c) => c.mode)).toEqual(['custom', 'default']);
    expect(back.host).toBe(CONNECTED.host);
  });

  it('does not go through start or stop to do it', async () => {
    const edge = await runningEdge();
    const start = vi.spyOn(edge, 'start');
    const stop = vi.spyOn(edge, 'stop');

    await edge.applyConfig(HEADSCALE).catch((err: unknown) => err);

    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('proves the spawn counter can move', async () => {
    // The control for the three assertions above: a genuine restart *does* show up as a
    // second spawn, so `toHaveLength(1)` is a fact about `applyConfig` and not about a
    // counter that never increments.
    const edge = await runningEdge();
    h.child!.exitCode = 1;
    await edge.start();

    expect(h.spawns).toHaveLength(2);
  });
});
