// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  CommandNotAllowed,
  NETEDGE_BUILD_COMMAND,
  runAllowedCommand,
  type SpawnFn,
} from '../commands.js';

/**
 * The renderer sends back the string it displayed, and that string is a key into the table —
 * never an argument list. The assertion that matters is not just that a refusal throws, but
 * that nothing was spawned before it did.
 */

function recordingSpawn(calls: { file: string; args: readonly string[] }[], exitCode = 0): SpawnFn {
  return ((file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: null;
      stderr: null;
      kill: () => void;
    };
    child.stdout = null;
    child.stderr = null;
    child.kill = () => undefined;
    setImmediate(() => child.emit('close', exitCode));
    return child;
  }) as unknown as SpawnFn;
}

describe('runAllowedCommand', () => {
  it('refuses a command that is not on the allowlist, and spawns nothing', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];

    await expect(
      runAllowedCommand('rm -rf / --no-preserve-root', 'C:/repo', recordingSpawn(calls)),
    ).rejects.toBeInstanceOf(CommandNotAllowed);

    expect(calls).toEqual([]);
  });

  it('runs an allowlisted command from the table, not from the string it was given', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];

    const result = await runAllowedCommand(NETEDGE_BUILD_COMMAND, 'C:/repo', recordingSpawn(calls));

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ file: 'npm', args: ['run', 'netedge:build'] }]);
  });
});
