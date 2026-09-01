// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ELECTRON_REBUILD_COMMAND } from '../commands.js';
import { detectNativeModules, diagnoseNativeModuleError } from '../detect.js';

/**
 * The ABI mismatch is the one prerequisite failure that looks like something else. The module
 * is installed and the file is intact, so "missing" would send the user off to reinstall a
 * package that is already there. Both version numbers have to survive into the message: that
 * sentence is the difference between one command and an hour.
 */

const ABI_ERROR = Object.assign(
  new Error(
    "The module '\\\\?\\C:\\LocalCast\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node' " +
      'was compiled against a different Node.js version using NODE_MODULE_VERSION 127. ' +
      'This version of Node.js requires NODE_MODULE_VERSION 130. Please try re-compiling or ' +
      're-installing the module (for instance, using `npm rebuild` or `npm install`).',
  ),
  { code: 'ERR_DLOPEN_FAILED' },
);

describe('native module diagnosis', () => {
  it('classifies an ABI mismatch as broken and extracts both versions', () => {
    const diagnosis = diagnoseNativeModuleError(ABI_ERROR);

    expect(diagnosis.state).toBe('broken');
    expect(diagnosis.builtFor).toBe(127);
    expect(diagnosis.required).toBe(130);
    expect(diagnosis.detail).toContain('Node.js');
    expect(diagnosis.detail).toContain('Electron');
  });

  it('offers the electron-rebuild command for a mismatched module', () => {
    const status = detectNativeModules('', () => {
      throw ABI_ERROR;
    });

    expect(status.state).toBe('broken');
    expect(status.severity).toBe('blocking');
    expect(status.detail).toMatch(/127/);
    expect(status.detail).toMatch(/130/);
    expect(status.remedies.map((remedy) => remedy.command)).toEqual([ELECTRON_REBUILD_COMMAND]);
  });

  it('classifies a module that is not installed as missing, not broken', () => {
    const status = detectNativeModules('', () => {
      throw Object.assign(new Error("Cannot find module 'better-sqlite3'"), {
        code: 'MODULE_NOT_FOUND',
      });
    });

    expect(status.state).toBe('missing');
  });
});
