// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Starting the app must not start the sidecar.
 *
 * `netedge` is the only part of LocalCast that wants an account, and starting it unasked is
 * precisely what made the app look broken: it sat on a Tailscale sign-in screen for a feature
 * most people never use, while the library it could already have served over the Wi-Fi went
 * unserved. Two gates now stand in front of it and this file holds both, by watching the one
 * thing that cannot be faked — the process spawn:
 *
 *   1. `REMOTE_ACCESS_ENABLED` in `shared/features.ts`, the build switch, which is false
 *      today and overrides everything below it;
 *   2. the user's stored `remoteAccess` preference, which is what decides once the feature is
 *      switched back on.
 *
 * Both flag states are exercised, because a suite that only ever ran with the feature off
 * would assert an absence that nothing could ever contradict — and would tell the person who
 * switches the feature back on nothing about whether it still works. `boot` takes the flag
 * and installs it as a module mock before `../index.js` is imported.
 *
 * `bootstrap` is not exported: importing `../index.js` *is* running it, which is why the
 * module is re-imported per case with a fresh set of doubles. Everything Electron owns is
 * replaced; `netedge.ts`, `ipc.ts`, `appConfig.ts` and `secrets.ts` are the real thing, so the
 * gate under test is the one that ships.
 */

import { REMOTE_ACCESS_ENABLED } from '../../shared/features.js';

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
 *
 * `feature` is the build switch. It defaults to whatever ships, so a case that does not
 * mention it is a statement about the real build; passing `true` is how the tests for the
 * switched-on behaviour stay runnable while the switch is off.
 */
async function boot(
  patch: Record<string, unknown>,
  { feature = REMOTE_ACCESS_ENABLED }: { feature?: boolean } = {},
): Promise<void> {
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
  // `doMock`, not `mock`: this has to run *after* the reset and *before* the import, so each
  // case gets a fresh `index.js` compiled against the flag that case is about.
  vi.doMock('../../shared/features.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../shared/features.js')>()),
    REMOTE_ACCESS_ENABLED: feature,
  }));
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

describe('bootstrap in the build as shipped', () => {
  it('does not spawn the sidecar', async () => {
    await boot({ remoteAccess: false });

    expect(h.fatal).toEqual([]);
    // Not a log line, not a status field: the process was never created.
    expect(h.spawns).toEqual([]);
  });

  /**
   * The switch, stated as the only thing that separates this case from the one below it in
   * "bootstrap with the remote-access feature switched on": the same planted binary and the
   * same stored preference asking for remote access, and still no process.
   */
  it.skipIf(REMOTE_ACCESS_ENABLED)(
    'does not spawn it even when the stored preference asks for it',
    async () => {
      await boot({ remoteAccess: true });

      expect(h.fatal).toEqual([]);
      expect(h.spawns).toEqual([]);
      // The preference itself is untouched — the switch overrides it, it does not rewrite it,
      // which is what makes turning the feature back on a no-op for the user.
      const stored = JSON.parse(
        readFileSync(join(dirs[dirs.length - 1] as string, 'LocalCast', 'config.json'), 'utf8'),
      ) as { remoteAccess?: boolean };
      expect(stored.remoteAccess).toBe(true);
    },
  );

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

/**
 * The feature as it will be when it is switched back on.
 *
 * This is the control for everything above: the same code, the same planted binary, the same
 * stored preference — only the build switch differs, and the process appears. Without it the
 * empty-`spawns` assertions would be satisfied by a bootstrap that had stopped working
 * entirely, and switching the feature on would be an unrehearsed change.
 */
describe('bootstrap with the remote-access feature switched on', () => {
  it('spawns the sidecar when the user has asked for it', async () => {
    await boot({ remoteAccess: true }, { feature: true });

    expect(h.fatal).toEqual([]);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]?.file).toMatch(/netedge\.exe$/);
    // Pointed at the loopback server, carrying the shared secret — not at anything public.
    expect(h.spawns[0]?.args).toContain('--upstream');
    expect(h.spawns[0]?.args).toContain('127.0.0.1:45999');
  });

  it('still does not spawn it when the user has not asked for it', async () => {
    // The second gate on its own: with the feature available, the preference is what decides.
    await boot({ remoteAccess: false }, { feature: true });
    expect(h.spawns).toEqual([]);
  });

  it('does not turn off local sharing to do it', async () => {
    await boot({ remoteAccess: true }, { feature: true });
    expect(h.serverOptions[0]?.['lan']).toBe(true);
  });
});
