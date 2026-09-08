// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { acquireInstance, isNewerVersion, type SingleInstanceDeps } from '../singleInstance.js';
import { foreignInstances, type ProcessInfo } from '../processes.js';

/**
 * A second copy of LocalCast must never die quietly.
 *
 * The failure this replaces: the user installed a new version while the old one sat in the tray.
 * The new one asked for the single-instance lock, did not get it, and quit inside the first
 * millisecond — no window, no dialog, no log line, nothing in Task Manager. Every fix in that
 * release was invisible because the process running was still the old one.
 */

interface World {
  /** Whether the lock is currently held by somebody else. Tests flip this to simulate yielding. */
  held: boolean;
  lockAttempts: number;
  asked: number;
  answer: 'replace' | 'quit';
  others: number[];
  killed: number[];
  refuse: Set<number>;
  log: string[];
  /** Called on every sleep, so a test can make the holder step aside after N ticks. */
  onSleep?: (tick: number) => void;
}

function deps(world: World): SingleInstanceDeps {
  let tick = 0;
  return {
    requestLock: () => {
      world.lockAttempts += 1;
      return !world.held;
    },
    version: '0.6.1',
    pid: 4242,
    ask: () => {
      world.asked += 1;
      return Promise.resolve(world.answer);
    },
    otherInstances: () => Promise.resolve(world.others),
    kill: (pid) => {
      if (world.refuse.has(pid)) return Promise.resolve(false);
      world.killed.push(pid);
      return Promise.resolve(true);
    },
    sleep: () => {
      tick += 1;
      world.onSleep?.(tick);
      return Promise.resolve();
    },
    log: (level, message) => world.log.push(`${level}: ${message}`),
    yieldWindowMs: 1_000,
    retryEveryMs: 250,
  };
}

function world(overrides: Partial<World> = {}): World {
  return {
    held: false,
    lockAttempts: 0,
    asked: 0,
    answer: 'quit',
    others: [],
    killed: [],
    refuse: new Set(),
    log: [],
    ...overrides,
  };
}

describe('becoming the only running copy', () => {
  it('is simply primary when nothing else is running', async () => {
    const w = world();
    expect(await acquireInstance(deps(w))).toBe('primary');
    expect(w.lockAttempts).toBe(1);
    expect(w.asked).toBe(0);
  });

  it('waits for a cooperative holder to step aside, and never bothers the user', async () => {
    // The clean path: the running copy understood the hello, saw a newer version, and quit. All
    // the newcomer has to do is not give up in the first millisecond.
    const w = world({ held: true, onSleep: (tick) => { if (tick === 2) w.held = false; } });
    expect(await acquireInstance(deps(w))).toBe('primary');
    expect(w.asked).toBe(0);
    expect(w.killed).toEqual([]);
    expect(w.log.some((l) => l.includes('stepped aside'))).toBe(true);
  });

  it('asks the user when the holder does not step aside, and quits if they say so', async () => {
    const w = world({ held: true, answer: 'quit' });
    expect(await acquireInstance(deps(w))).toBe('quit');
    expect(w.asked).toBe(1);
    expect(w.killed).toEqual([]);
    // The reason is on record either way. The point of this whole module is that nothing here
    // happens without a line saying it did.
    expect(w.log.some((l) => l.includes('did not step aside'))).toBe(true);
    expect(w.log.some((l) => l.includes('quitting'))).toBe(true);
  });

  it('replaces the old copy when asked to: terminates it, then takes the lock', async () => {
    const w = world({
      held: true,
      answer: 'replace',
      others: [1000, 1001, 1002],
      // Held until the other instance is gone, then free — which is what a real kill does.
      onSleep: () => { if (w.killed.length === 3) w.held = false; },
    });
    expect(await acquireInstance(deps(w))).toBe('primary');
    expect(w.killed).toEqual([1000, 1001, 1002]);
    expect(w.log.some((l) => l.includes('took over'))).toBe(true);
  });

  it('gives up in words when the other copy cannot be terminated', async () => {
    // Another user's session, or a permissions boundary. Access denied is not a reason to hang
    // and it is not a reason to pretend; it is a reason to say what happened and stop.
    const w = world({ held: true, answer: 'replace', others: [1000], refuse: new Set([1000]) });
    expect(await acquireInstance(deps(w))).toBe('quit');
    expect(w.log.some((l) => l.includes('could not be terminated'))).toBe(true);
    expect(w.log.some((l) => l.startsWith('error:'))).toBe(true);
  });
});

describe('deciding whether a newcomer outranks the running copy', () => {
  it.each([
    ['0.6.1', '0.6.0', true],
    ['0.7.0', '0.6.9', true],
    ['1.0.0', '0.99.99', true],
    ['v0.6.1', '0.6.0', true],
    ['0.6.0', '0.6.0', false],
    ['0.5.1', '0.6.0', false],
    ['0.6.1-beta.1', '0.6.0', true],
    [undefined, '0.6.0', false],
    ['garbage', '0.6.0', false],
  ])('%s newer than %s → %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate as string | undefined, current)).toBe(expected);
  });
});

describe('telling our processes from theirs', () => {
  const proc = (pid: number, ppid: number, name = 'LocalCast.exe'): ProcessInfo => ({
    pid,
    ppid,
    name,
    path: null,
  });

  it('excludes this process, its launcher, and its own Electron children', () => {
    // A portable build: the self-extracting launcher (ppid) started us (pid), and we have spawned
    // a GPU and a renderer helper. None of these may be killed — the launcher least of all, since
    // it is the exe the user just double-clicked.
    const all = [
      proc(23272, 1, 'LocalCast-Portable-0.5.1.exe'), // the OLD launcher
      proc(2708, 23272), // the OLD app
      proc(37740, 2708), // OLD helper
      proc(32444, 2708), // OLD helper
      proc(9000, 1, 'LocalCast-Portable-0.6.1.exe'), // OUR launcher
      proc(9001, 9000), // us
      proc(9002, 9001), // our GPU helper
      proc(9003, 9001), // our renderer
    ];
    const foreign = foreignInstances(all, { pid: 9001, ppid: 9000 });
    expect(foreign.map((p) => p.pid)).toEqual([23272, 2708, 32444, 37740]);
  });

  it('puts parents before children, so a killed helper is not respawned by a parent still alive', () => {
    const all = [proc(300, 200), proc(200, 100), proc(100, 1, 'LocalCast-Portable-0.5.1.exe')];
    const foreign = foreignInstances(all, { pid: 9001, ppid: 9000 });
    expect(foreign[0]?.pid).toBe(100);
  });

  it('returns nothing when we are the only tree', () => {
    const all = [proc(9001, 9000), proc(9002, 9001)];
    expect(foreignInstances(all, { pid: 9001, ppid: 9000 })).toEqual([]);
  });
});
