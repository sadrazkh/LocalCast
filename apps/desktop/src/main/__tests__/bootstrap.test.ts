// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Starting the app must not start the sidecar.
 *
 * `netedge` is the only part of LocalCast that wants an account, and starting it unasked is
 * precisely what made the app look broken: it sat on a Tailscale sign-in screen for a feature
 * most people never use, while the library it could already have served over the Wi-Fi went
 * unserved. `remoteAccess` gates it, and this file holds that gate by watching the one thing
 * that cannot be faked — the process spawn.
 *
 * `bootstrap` is not exported: importing `../index.js` *is* running it, which is why the
 * module is re-imported per case with a fresh set of doubles. Everything Electron owns is
 * replaced; `netedge.ts`, `ipc.ts`, `appConfig.ts` and `secrets.ts` are the real thing, so the
 * gate under test is the one that ships.
 */

const h = vi.hoisted(() => {
  interface FakeStream {
    setEncoding(): void;
    on(event: string, fn: (...args: unknown[]) => void): FakeStream;
  }
  const stream = (): FakeStream => ({
    setEncoding() {},
    on() {
      return this;
    },
  });

  return {
    spawns: [] as Array<{ file: string; args: string[] }>,
    fetched: [] as string[],
    fatal: [] as string[],
    serverOptions: [] as Array<Record<string, unknown>>,
    /** Resolved when bootstrap reaches its last statement, or gives up. */
    finished: { resolve: () => {} } as { resolve: () => void },
    paths: { appData: '', appPath: '', exe: '', temp: '' },
    child: () => ({
      stdout: stream(),
      stderr: stream(),
      exitCode: null as number | null,
      on() {
        return this;
      },
      once() {
        return this;
      },
      kill() {},
      unref() {},
    }),
  };
});

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    on: (event: string) => {
      // The last thing bootstrap does. Nothing after it can spawn anything.
      if (event === 'activate') h.finished.resolve();
    },
    whenReady: () => Promise.resolve(),
    getPath: (name: string) =>
      name === 'appData' ? h.paths.appData : name === 'exe' ? h.paths.exe : h.paths.temp,
    getAppPath: () => h.paths.appPath,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    quit: () => {
      h.fatal.push('quit');
      h.finished.resolve();
    },
    exit: () => {
      h.fatal.push('exit');
      h.finished.resolve();
    },
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: {
    showErrorBox: (title: string, body: string) => h.fatal.push(`${title}: ${body}`),
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openExternal: () => Promise.resolve() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

// The spawn under observation. `netedge.ts` itself is real.
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[]) => {
    h.spawns.push({ file, args });
    return h.child();
  },
}));

vi.mock('../windows.js', () => ({
  createMainWindow: () => ({ on: () => {}, once: () => {}, show: () => {}, focus: () => {} }),
  createTrayWindow: () => ({ on: () => {}, once: () => {} }),
  createWizardWindow: () => ({ on: () => {}, once: () => {}, close: () => {} }),
}));

vi.mock('../tray.js', () => ({
  AppTray: class {
    update() {}
    destroy() {}
  },
}));

vi.mock('../preflight/ipc.js', () => ({ registerPreflightIpc: () => {} }));

vi.mock('../preflight/run.js', () => ({
  runPreflight: () =>
    Promise.resolve({ items: [], canProceed: true, allSatisfied: true, checkedAt: 0 }),
}));

// The real one boots SQLite and binds sockets; what matters here is only what it was told.
vi.mock('../serverHost.js', () => ({
  ServerNotBuilt: class ServerNotBuilt extends Error {},
  startServer: (options: Record<string, unknown>) => {
    h.serverOptions.push(options);
    return Promise.resolve({
      port: 45999,
      lanUrl: 'https://192.168.1.50:8443',
      lanFingerprint: 'AA:BB',
      setPublicHost: () => {},
      dispose: () => Promise.resolve(),
    });
  },
}));

const dirs: string[] = [];
let realFetch: typeof globalThis.fetch;

function writeConfig(dataDir: string, patch: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({ version: 1, setupComplete: true, startMinimised: true, ...patch }),
    'utf8',
  );
}

/**
 * Runs one full bootstrap against a data directory whose `config.json` says `patch`, and
 * resolves once bootstrap has finished. `netedge.exe` is planted where the resolver looks, so
 * "the sidecar was not started" can never be an accident of it not being installed.
 */
async function boot(patch: Record<string, unknown>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lc-bootstrap-'));
  dirs.push(root);
  const resources = join(root, 'resources');
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, 'netedge.exe'), 'not a real binary', 'utf8');

  h.paths.appData = root;
  h.paths.appPath = join(root, 'app');
  h.paths.exe = join(root, 'app', 'LocalCast.exe');
  h.paths.temp = join(root, 'os-temp');
  mkdirSync(h.paths.appPath, { recursive: true });
  mkdirSync(h.paths.temp, { recursive: true });
  writeConfig(join(root, 'LocalCast'), patch);

  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });

  const done = new Promise<void>((resolve) => {
    h.finished.resolve = resolve;
  });
  vi.resetModules();
  await import('../index.js');
  await done;
  // `edge.start()` is fired and not awaited, so give the spawn every chance to happen before
  // concluding that it did not. A negative assertion taken too early proves nothing.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

beforeEach(() => {
  h.spawns.length = 0;
  h.fetched.length = 0;
  h.fatal.length = 0;
  h.serverOptions.length = 0;
  realFetch = globalThis.fetch;
  type FetchArgs = Parameters<typeof globalThis.fetch>;
  globalThis.fetch = ((input: FetchArgs[0], init?: FetchArgs[1]) => {
    h.fetched.push(
      typeof input === 'string' ? input : String((input as { url?: string }).url ?? input),
    );
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('bootstrap with remote access off — the default', () => {
  it('does not spawn the sidecar', async () => {
    await boot({ remoteAccess: false });

    expect(h.fatal).toEqual([]);
    // Not a log line, not a status field: the process was never created.
    expect(h.spawns).toEqual([]);
  });

  it('still tells the server to share on the local network', async () => {
    await boot({ remoteAccess: false });

    // The other half of the default. The server ships with `lan: false` and does not decide
    // for itself; the desktop passes the user's preference, and that preference is on.
    expect(h.serverOptions).toHaveLength(1);
    expect(h.serverOptions[0]?.['lan']).toBe(true);
  });

  it('contacts nothing on the internet while starting', async () => {
    await boot({ remoteAccess: false });

    // There is an update checker in `updates.ts` that asks GitHub. It is registered as an IPC
    // handler here — `ipc.ts` is not mocked — so this asserts something real: it is reachable,
    // and it does not fire by itself at boot.
    const offMachine = h.fetched.filter((url) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url));
    expect(offMachine).toEqual([]);
  });

  it('leaves local sharing on when the user has only refused remote access', async () => {
    await boot({ remoteAccess: false, shareOnLan: true });
    expect(h.spawns).toEqual([]);
    expect(h.serverOptions[0]?.['lan']).toBe(true);
  });
});

describe('bootstrap with remote access on', () => {
  it('spawns the sidecar', async () => {
    await boot({ remoteAccess: true });

    // The control case, and the reason the assertions above are not vacuous: the same code
    // path, the same planted binary, one flag different.
    expect(h.fatal).toEqual([]);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]?.file).toMatch(/netedge\.exe$/);
    // Pointed at the loopback server, carrying the shared secret — not at anything public.
    expect(h.spawns[0]?.args).toContain('--upstream');
    expect(h.spawns[0]?.args).toContain('127.0.0.1:45999');
  });

  it('does not turn off local sharing to do it', async () => {
    await boot({ remoteAccess: true });
    expect(h.serverOptions[0]?.['lan']).toBe(true);
  });
});
