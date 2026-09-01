import { execFile } from 'node:child_process';

/**
 * The single boundary between the print subsystem and Windows.
 *
 * Everything that shells out goes through this one function type, which is what makes the
 * state machine testable: the spec calls for the PowerShell and SumatraPDF calls to be faked
 * here rather than for the queue to grow a "pretend" mode that only tests ever exercise.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  /**
   * Extra environment for the child. Used to pass printer names and job ids into PowerShell
   * without ever putting them inside the script text.
   */
  env?: NodeJS.ProcessEnv;
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export class ExecFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'ExecFailure';
  }
}

export const defaultExecFile: ExecFileFn = (file, args, options = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        windowsHide: true,
        // Never a shell. Printer names contain spaces, ampersands and Persian text, and
        // file paths come from the library; a shell string here would be a command
        // injection with the operator's own privileges.
        shell: false,
        encoding: 'utf8',
        ...(options.env ? { env: options.env } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : null;
          reject(new ExecFailure(err.message, String(stdout ?? ''), String(stderr ?? ''), code));
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });

export const POWERSHELL = 'powershell.exe';

/**
 * `-NoProfile` so an operator's profile script cannot change the output shape,
 * `-NonInteractive` so a prompt can never hang the queue behind a hidden window, and
 * `-ExecutionPolicy Bypass` because the policy applies to script files and would otherwise
 * block an inline command on a locked-down machine.
 */
export const POWERSHELL_FLAGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
] as const;

/**
 * Prefixed to every script: without it PowerShell writes the console code page, and a
 * printer named «چاپگر اداره» comes back as mojibake that no longer matches the database.
 */
const UTF8_PREAMBLE = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';

export function powershellArgs(script: string): string[] {
  return [...POWERSHELL_FLAGS, `${UTF8_PREAMBLE}${script}`];
}
