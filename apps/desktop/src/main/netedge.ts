import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  EDGE_ROUTES,
  edgeStatusSchema,
  edgeStdoutEventSchema,
  edgeTestResultSchema,
  type EdgeStatus,
  type EdgeTestResult,
  type NetworkConfig,
} from '@localcast/contract';

/**
 * Supervises the `netedge` Go sidecar: spawns it, reads its newline-delimited JSON status
 * stream, and talks to its loopback control API.
 *
 * It is a plain child process, not a Windows service and not an installer step, because the
 * whole point of embedding tsnet is that the user never sees a UAC prompt or installs a
 * network driver.
 */

const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface NetEdgeOptions {
  /** Where `netedge` keeps its tsnet state. Survives restarts and mode switches. */
  stateDir: string;
  configPath: string;
  /** The loopback address of the Node app server that netedge proxies to. */
  upstream: string;
  sharedSecret: string;
  /** Overridden in development, where the binary sits in the source tree. */
  binaryPath?: string;
}

export class NetEdgeBinaryMissing extends Error {
  constructor(readonly searched: string[]) {
    super(
      'The netedge binary was not found. Build it with `npm run netedge:build` (requires Go ' +
        `1.23+). Searched: ${searched.join(', ')}`,
    );
    this.name = 'NetEdgeBinaryMissing';
  }
}

const OFFLINE_STATUS: EdgeStatus = {
  state: 'stopped',
  host: null,
  funnelUrl: null,
  loginUrl: null,
  errorCode: null,
  errorMessage: null,
  certExpiresAt: null,
  peers: 0,
  updatedAt: 0,
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

export declare interface NetEdge {
  on(event: 'status', listener: (status: EdgeStatus) => void): this;
  on(event: 'log', listener: (level: string, message: string) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
}

export class NetEdge extends EventEmitter {
  // stdin is `ignore`: the sidecar is configured over its control API and its config file,
  // never by writing to it, so leaving a pipe open would only be a handle to leak.
  #child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  #controlPort: number | null = null;
  #status: EdgeStatus = { ...OFFLINE_STATUS };
  #stdoutBuffer = '';
  #restartAttempt = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #stopping = false;

  constructor(private readonly opts: NetEdgeOptions) {
    super();
  }

  get status(): EdgeStatus {
    return this.#status;
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  /**
   * Locates the sidecar. In a packaged build it is unpacked next to the app; in development
   * it is whatever `npm run netedge:build` produced in the source tree.
   */
  static resolveBinary(appRoot: string, resourcesPath: string, override?: string): string {
    const candidates = [
      ...(override ? [override] : []),
      join(resourcesPath, 'netedge.exe'),
      join(resourcesPath, 'bin', 'netedge.exe'),
      join(appRoot, 'native', 'netedge', 'netedge.exe'),
      join(appRoot, '..', '..', 'native', 'netedge', 'netedge.exe'),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new NetEdgeBinaryMissing(candidates);
    return found;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.#stopping = false;

    const binary = this.opts.binaryPath ?? '';
    if (!binary || !existsSync(binary)) throw new NetEdgeBinaryMissing([binary || '(unset)']);

    const controlPort = await freePort();
    this.#controlPort = controlPort;

    const child = spawn(
      binary,
      [
        '--config', this.opts.configPath,
        '--control-port', String(controlPort),
        '--upstream', this.opts.upstream,
        '--shared-secret', this.opts.sharedSecret,
        '--state-dir', this.opts.stateDir,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    this.#child = child;
    this.#setStatus({ ...OFFLINE_STATUS, state: 'starting', updatedAt: Date.now() });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#consumeStdout(chunk));

    // The sidecar writes only diagnostics to stderr. It is surfaced as log events rather
    // than swallowed, because a tsnet failure here is otherwise invisible.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.emit('log', 'error', line.trim());
      }
    });

    child.on('exit', (code) => {
      this.#child = null;
      this.#controlPort = null;
      this.emit('exit', code);
      if (this.#stopping) {
        this.#setStatus({ ...OFFLINE_STATUS, updatedAt: Date.now() });
        return;
      }
      this.#setStatus({
        ...this.#status,
        state: 'error',
        errorCode: 'edge_not_ready',
        errorMessage: `netedge exited with code ${code ?? 'unknown'}`,
        updatedAt: Date.now(),
      });
      this.#scheduleRestart();
    });
  }

  #scheduleRestart(): void {
    if (this.#restartTimer) return;
    const delay = RESTART_BACKOFF_MS[Math.min(this.#restartAttempt, RESTART_BACKOFF_MS.length - 1)]!;
    this.#restartAttempt += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.start().catch((err: unknown) => {
        this.emit('log', 'error', err instanceof Error ? err.message : String(err));
        this.#scheduleRestart();
      });
    }, delay);
  }

  #consumeStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let index = this.#stdoutBuffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#stdoutBuffer.slice(0, index).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      if (line) this.#handleLine(line);
      index = this.#stdoutBuffer.indexOf('\n');
    }
    // A sidecar that goes mad and writes an unbounded line without a newline must not be
    // able to grow this process's memory without limit.
    if (this.#stdoutBuffer.length > 1_000_000) this.#stdoutBuffer = '';
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit('log', 'warn', `unparseable line from netedge: ${line.slice(0, 200)}`);
      return;
    }
    const event = edgeStdoutEventSchema.safeParse(parsed);
    if (!event.success) {
      this.emit('log', 'warn', `unexpected event shape from netedge: ${line.slice(0, 200)}`);
      return;
    }
    switch (event.data.type) {
      case 'ready':
        this.#controlPort = event.data.controlPort;
        this.#restartAttempt = 0;
        break;
      case 'status':
        this.#setStatus(event.data.status);
        break;
      case 'log':
        this.emit('log', event.data.level, event.data.message);
        break;
    }
  }

  #setStatus(status: EdgeStatus): void {
    this.#status = status;
    this.emit('status', status);
  }

  async #control<T>(route: string, init: RequestInit, parse: (raw: unknown) => T): Promise<T> {
    if (this.#controlPort === null) throw new Error('netedge control API is not up yet');
    const res = await fetch(`http://127.0.0.1:${this.#controlPort}${route}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-lc-edge-secret': this.opts.sharedSecret,
        ...(init.headers ?? {}),
      },
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
      throw new Error(`netedge ${route} failed: ${message}`);
    }
    return parse(body);
  }

  async refreshStatus(): Promise<EdgeStatus> {
    const status = await this.#control(EDGE_ROUTES.status, { method: 'GET' }, (raw) =>
      edgeStatusSchema.parse(raw),
    );
    this.#setStatus(status);
    return status;
  }

  /**
   * A dry run. The settings page calls this before it is allowed to save, so a configuration
   * that cannot work — a self-hosted control server asked to issue its own certificate, say —
   * is refused while the user is still looking at the form rather than becoming a permanent
   * "connecting…" spinner.
   */
  test(config: NetworkConfig): Promise<EdgeTestResult> {
    return this.#control(EDGE_ROUTES.test, { method: 'POST', body: JSON.stringify(config) }, (raw) =>
      edgeTestResultSchema.parse(raw),
    );
  }

  /**
   * Applies a new configuration. The sidecar tears down and rebuilds its tsnet node in place
   * without exiting, so switching between the default coordination server and a personal
   * Headscale never touches SQLite: devices, permissions and pairings all survive.
   */
  async applyConfig(config: NetworkConfig): Promise<EdgeStatus> {
    await this.#control(EDGE_ROUTES.config, { method: 'PUT', body: JSON.stringify(config) }, () => null);
    return this.refreshStatus();
  }

  /** Returns the interactive login URL; the caller opens it in the user's browser. */
  async requestLogin(): Promise<string> {
    const { loginUrl } = await this.#control(EDGE_ROUTES.login, { method: 'POST' }, (raw) => {
      const parsed = raw as { loginUrl?: unknown };
      if (typeof parsed?.loginUrl !== 'string') throw new Error('netedge did not return a login URL');
      return { loginUrl: parsed.loginUrl };
    });
    return loginUrl;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (!child) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
