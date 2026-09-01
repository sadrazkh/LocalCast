import { spawn } from 'node:child_process';
import type { PrerequisiteId } from '../../shared/preflight.js';

/**
 * The only commands preflight will ever run.
 *
 * The renderer sends back the exact string it displayed on the button. That string is a **key
 * into this table**, never an argument list and never something handed to a shell: the
 * executable and every argument below are literals in this file. A remedy the user did not
 * see, or a string a compromised renderer made up, finds no entry and is refused.
 */

export const NETEDGE_BUILD_COMMAND = 'npm run netedge:build';
export const ELECTRON_REBUILD_COMMAND = 'npx @electron/rebuild -f -w better-sqlite3';
export const NPM_INSTALL_COMMAND = 'npm install';

interface AllowedCommand {
  /** Which prerequisite this repairs, so progress can be attributed to it. */
  id: PrerequisiteId;
  file: string;
  args: readonly string[];
  timeoutMs: number;
}

const ALLOWED = new Map<string, AllowedCommand>([
  [
    NETEDGE_BUILD_COMMAND,
    { id: 'netedge', file: 'npm', args: ['run', 'netedge:build'], timeoutMs: 10 * 60_000 },
  ],
  [
    ELECTRON_REBUILD_COMMAND,
    {
      id: 'native-modules',
      file: 'npx',
      args: ['@electron/rebuild', '-f', '-w', 'better-sqlite3'],
      timeoutMs: 20 * 60_000,
    },
  ],
  [
    NPM_INSTALL_COMMAND,
    { id: 'native-modules', file: 'npm', args: ['install'], timeoutMs: 20 * 60_000 },
  ],
]);

export class CommandNotAllowed extends Error {
  constructor(readonly attempted: string) {
    super(
      'Refusing to run a command that is not on the preflight allowlist. ' +
        `Allowed: ${[...ALLOWED.keys()].join(', ')}`,
    );
    this.name = 'CommandNotAllowed';
  }
}

export function prerequisiteForCommand(display: string): PrerequisiteId | null {
  return ALLOWED.get(display)?.id ?? null;
}

export interface CommandResult {
  ok: boolean;
  /** `null` when the process was killed rather than exiting on its own. */
  code: number | null;
  /** Combined stdout and stderr, tail-truncated. The end is where the error is. */
  output: string;
}

/** Injected by the tests so a refusal can be shown to have run nothing at all. */
export type SpawnFn = typeof spawn;

const OUTPUT_LIMIT = 8_000;

export async function runAllowedCommand(
  display: string,
  cwd: string,
  spawnImpl: SpawnFn = spawn,
): Promise<CommandResult> {
  const entry = ALLOWED.get(display);
  if (!entry) throw new CommandNotAllowed(display);

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawnImpl(entry.file, [...entry.args], {
      cwd,
      windowsHide: true,
      // `npm` and `npx` are `.cmd` shims on Windows, which Node refuses to spawn without a
      // shell since the argument-injection fix in 18.20/20.12/22. Using one is safe here for
      // the reason the table exists: the executable and its arguments are literals above, and
      // nothing from the renderer reaches this call.
      shell: process.platform === 'win32',
    });

    let output = '';
    const collect = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    // A build that hangs must fail rather than leave the wizard waiting on a spinner for ever.
    const timer = setTimeout(() => {
      child.kill();
      output = `${output}\n[preflight] ${display} was still running after ${Math.round(entry.timeoutMs / 1000)}s and was stopped.`;
    }, entry.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: output.trim() });
    });
  });
}
