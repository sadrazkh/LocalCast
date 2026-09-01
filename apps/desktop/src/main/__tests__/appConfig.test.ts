// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigStore, configPathFor } from '../appConfig.js';

/**
 * The two switches that decide what LocalCast is on a fresh machine.
 *
 * `shareOnLan` on and `remoteAccess` off is the whole product promise expressed as data: a
 * phone on the same Wi-Fi works immediately, and nothing talks to a coordination server until
 * somebody asks it to. Both live here as zod defaults, which means every path that produces an
 * `AppConfig` — first run, a deleted file, a file edited into nonsense — produces the same
 * answer. These tests hold that; a change to either default fails them by name.
 */

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-appconfig-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('a freshly parsed AppConfig', () => {
  it('shares on the local network and does not reach outside it', () => {
    const config = new AppConfigStore(configPathFor(freshDir())).get();

    // On: this is why signing in is optional.
    expect(config.shareOnLan).toBe(true);
    // Off: the only part of the product that needs an account, and it stays asleep until asked.
    expect(config.remoteAccess).toBe(false);
  });

  it('keeps those defaults when the file has been edited into nonsense', () => {
    const dir = freshDir();
    writeFileSync(configPathFor(dir), '{ this is not json', 'utf8');

    // A broken file must not be able to *enable* anything. Failing open towards remote access
    // would mean a corrupt config silently starts talking to a coordination server.
    const config = new AppConfigStore(configPathFor(dir)).get();
    expect(config.shareOnLan).toBe(true);
    expect(config.remoteAccess).toBe(false);
  });

  it('keeps those defaults when the file is valid but says nothing about them', () => {
    const dir = freshDir();
    writeFileSync(configPathFor(dir), JSON.stringify({ version: 1, locale: 'en' }), 'utf8');

    const config = new AppConfigStore(configPathFor(dir)).get();
    expect(config.shareOnLan).toBe(true);
    expect(config.remoteAccess).toBe(false);
  });
});

describe('turning remote access on', () => {
  it('takes an explicit write, and survives a reload', () => {
    const dir = freshDir();
    const store = new AppConfigStore(configPathFor(dir));
    expect(store.get().remoteAccess).toBe(false);

    expect(store.update({ remoteAccess: true }).remoteAccess).toBe(true);
    // Re-read from disk: the switch is a stored decision, not a per-session flag.
    expect(new AppConfigStore(configPathFor(dir)).get().remoteAccess).toBe(true);
  });

  it('does not turn local sharing off in the process', () => {
    const dir = freshDir();
    const store = new AppConfigStore(configPathFor(dir));
    // The two are independent. Reaching the machine from elsewhere must not cost the thing
    // that works without an account.
    expect(store.update({ remoteAccess: true }).shareOnLan).toBe(true);
  });
});
