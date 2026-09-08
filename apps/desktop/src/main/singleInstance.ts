/**
 * Becoming the one running copy of LocalCast — and never dying quietly if we are not.
 *
 * ## What happened
 *
 * `if (!app.requestSingleInstanceLock()) app.quit();` — the standard Electron idiom, and it was
 * exactly wrong for a tray application that people upgrade.
 *
 * The user installed a new version while the old one was still sitting in the system tray. The new
 * one started, asked for the lock, did not get it, and quit — inside the first millisecond, with no
 * window, no dialog, no log line, nothing in Task Manager. Every fix in that release was invisible,
 * because the process running was still the old one. The report was, accurately: "it is not fixed,
 * and it does not even show up in Task Manager".
 *
 * ## What happens now
 *
 * The newcomer introduces itself when it asks for the lock — version and PID travel as the lock's
 * `additionalData`, which Electron delivers to the running instance's `second-instance` event.
 *
 *   1. A running instance that receives a hello from a **newer** version quits, so the newcomer can
 *      take the lock on its next try. Same or older version: the running one surfaces its window,
 *      as before. This is the clean path, and every version from this one on takes it.
 *   2. The newcomer retries the lock for a few seconds, which is how long the old one needs to quit.
 *   3. If the lock is still held — the old copy predates this handshake and does not know to step
 *      aside — the newcomer **asks**: a dialog naming the situation, with "close the old copy and
 *      continue" or "quit". On yes it terminates the other instance's processes and retries.
 *   4. If even that fails (another user's session, a permissions boundary) it says so, in words,
 *      and only then quits.
 *
 * Nothing on this path is silent. Every branch is logged to `main.log` as well.
 */

export interface InstanceHello {
  version: string;
  pid: number;
}

export interface SingleInstanceDeps {
  /** `app.requestSingleInstanceLock(hello)`. May be called more than once. */
  requestLock(hello: InstanceHello): boolean;
  version: string;
  pid: number;
  /** Shown only when the holder did not step aside on its own. */
  ask(): Promise<'replace' | 'quit'>;
  /** PIDs of the other instance's processes, parents first. */
  otherInstances(): Promise<number[]>;
  kill(pid: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** How long to give a cooperative holder to quit before asking the user. */
  yieldWindowMs?: number;
  retryEveryMs?: number;
}

export type InstanceOutcome = 'primary' | 'quit';

export async function acquireInstance(deps: SingleInstanceDeps): Promise<InstanceOutcome> {
  const hello: InstanceHello = { version: deps.version, pid: deps.pid };
  if (deps.requestLock(hello)) return 'primary';

  deps.log('info', `another copy of LocalCast holds the instance lock; asking it to step aside`);
  if (await retryLock(deps, hello, deps.yieldWindowMs ?? 4_000)) {
    deps.log('info', 'the running copy stepped aside; continuing as the only instance');
    return 'primary';
  }

  // Predates the handshake, or is stuck. Either way it is the user's call, and it is asked.
  deps.log('warn', 'the running copy did not step aside; asking the user whether to replace it');
  if ((await deps.ask()) === 'quit') {
    deps.log('info', 'the user chose to keep the running copy; this one is quitting');
    return 'quit';
  }

  const others = await deps.otherInstances();
  deps.log('info', `terminating the other instance: ${others.length === 0 ? '(no processes found)' : others.join(', ')}`);
  let refused = 0;
  for (const pid of others) {
    if (!(await deps.kill(pid))) refused += 1;
  }
  if (refused > 0) deps.log('warn', `${refused} process(es) could not be terminated`);

  if (await retryLock(deps, hello, 5_000)) {
    deps.log('info', 'took over from the previous copy');
    return 'primary';
  }

  deps.log('error', 'could not take over the instance lock after terminating the other copy');
  return 'quit';
}

async function retryLock(deps: SingleInstanceDeps, hello: InstanceHello, forMs: number): Promise<boolean> {
  const every = deps.retryEveryMs ?? 250;
  for (let waited = 0; waited < forMs; waited += every) {
    await deps.sleep(every);
    if (deps.requestLock(hello)) return true;
  }
  return false;
}

/**
 * `1.2.3` style comparison, numeric per segment; anything unparseable is "not newer".
 *
 * Deliberately not a full semver implementation: the only question asked is whether the copy that
 * just started should replace the one that is running, and a pre-release tag is not a reason to.
 */
export function isNewerVersion(candidate: string | undefined, current: string): boolean {
  if (typeof candidate !== 'string') return false;
  const a = segments(candidate);
  const b = segments(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function segments(version: string): number[] | null {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '';
  const parts = core.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts;
}
