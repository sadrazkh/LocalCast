import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A file the main process writes everything it says into.
 *
 * ## Why
 *
 * In a packaged Electron app the main process's `console` goes nowhere. Every `console.error` in
 * `bootstrap`, every line the in-process server logs, every "startup failed" — all of it is
 * written to a stream nobody can see. So when the app dies before a window opens, the only report
 * a user can make is the one this was added in response to: "it does not even appear in Task
 * Manager". No cause, no way to find one.
 *
 * With this, the same report arrives with the answer attached: `%APPDATA%\LocalCast\logs\main.log`
 * ends with the line that explains it.
 *
 * ## What it is not
 *
 * Not a logging framework. The server has its own logger with its own redaction, and it writes to
 * `console` — which is exactly why hooking `console` here catches its output too, redaction already
 * applied. This file adds a timestamp and a level, tees to the original console so a development
 * run still sees everything in the terminal, and rotates once so it cannot grow without bound.
 */

const MAX_BYTES = 2 * 1024 * 1024;

export interface MainLog {
  path: string;
  /** Write a line directly, for the few places that should not go through `console`. */
  line(level: 'info' | 'warn' | 'error', message: string): void;
}

export function installMainLog(dataDir: string): MainLog {
  const dir = join(dataDir, 'logs');
  const path = join(dir, 'main.log');

  try {
    mkdirSync(dir, { recursive: true });
    rotateIfLarge(path);
  } catch {
    // A data directory that cannot be written is reported elsewhere, at boot, with its own cause.
    // Logging must never be the thing that stops the app from starting.
  }

  const write = (level: string, parts: unknown[]): void => {
    const text = parts.map(render).join(' ');
    try {
      appendFileSync(path, `${new Date().toISOString()} ${level.padEnd(5)} ${text}\n`, 'utf8');
    } catch {
      // Same rule.
    }
  };

  // Tee, not replace: a development run still wants the terminal.
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => {
    write('info', args);
    original.log.apply(console, args);
  };
  console.info = (...args: unknown[]) => {
    write('info', args);
    original.info.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    write('warn', args);
    original.warn.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    write('error', args);
    original.error.apply(console, args);
  };

  // The two ways a process dies without saying why. Recorded, not handled — `index.ts` decides
  // what to do about them; this only makes sure the file says they happened.
  process.on('unhandledRejection', (reason) => write('error', ['unhandled rejection:', reason]));
  process.on('exit', (code) => write('info', [`process exiting with code ${code}`]));

  return { path, line: (level, message) => write(level, [message]) };
}

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One generation kept. A log that grows for ever is a log somebody eventually deletes in anger. */
function rotateIfLarge(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size < MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}
