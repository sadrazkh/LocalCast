/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredSession } from '@localcast/client-core';
import { SecretStorageUnavailable, SessionVault } from '../tokenStore.js';
import type { SecretCodec } from '../tokenStore.js';
import { ServerRegistry, baseUrlFor, serverIdFor } from '../registry.js';
import { reversibleCodec } from './fakes.js';

/**
 * The two files this app keeps on disk: which servers exist, and the credential for each.
 *
 * They are separate on purpose — one is a bug report attachment, the other is DPAPI
 * ciphertext — and the tests below are mostly about what happens when either is damaged. A
 * hand-edited vault, a profile the ciphertext was not written under, a truncated registry:
 * none of them may stop the app from starting, and none may take a neighbouring server's
 * session down with them.
 */

let dir: string;
let vaultPath: string;
let registryPath: string;

function sessionFor(suffix: string): StoredSession {
  return {
    deviceId: `dev-${suffix}`,
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    expiresAt: 4_000_000_000_000,
    host: `${suffix}.tail1234.ts.net`,
    davPassword: `dav-${suffix}`,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lc-vault-'));
  vaultPath = join(dir, 'state', 'sessions.json');
  registryPath = join(dir, 'state', 'servers.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionVault', () => {
  it('keeps one server’s session out of another’s reach, whichever store asks', async () => {
    const vault = new SessionVault(vaultPath, reversibleCodec);
    const alpha = vault.storeFor('alpha');
    const beta = vault.storeFor('beta');

    await alpha.write(sessionFor('a'));
    await beta.write(sessionFor('b'));

    expect((await alpha.read())?.accessToken).toBe('access-a');
    expect((await beta.read())?.accessToken).toBe('access-b');
    // A store handed to one server's client cannot name another server's key: that is what
    // makes the isolation structural rather than a rule somebody has to remember.
    expect(vault.pairedServerIds().sort()).toEqual(['alpha', 'beta']);
  });

  it('leaves the neighbour alone when one server is signed out', async () => {
    const vault = new SessionVault(vaultPath, reversibleCodec);
    await vault.storeFor('alpha').write(sessionFor('a'));
    await vault.storeFor('beta').write(sessionFor('b'));

    await vault.storeFor('alpha').clear();

    expect(vault.read('alpha')).toBeNull();
    expect(vault.read('beta')?.accessToken).toBe('access-b');
    expect(vault.pairedServerIds()).toEqual(['beta']);
  });

  it('starts empty rather than throwing when the vault file has been damaged', () => {
    const first = new SessionVault(vaultPath, reversibleCodec);
    first.write('alpha', sessionFor('a'));
    writeFileSync(vaultPath, '{"version":1,"sessions":{"alpha": tru', 'utf8');

    const second = new SessionVault(vaultPath, reversibleCodec);
    // Four keystrokes to pair again is a cost; a window that will not open is not.
    expect(second.pairedServerIds()).toEqual([]);
    expect(second.read('alpha')).toBeNull();
  });

  it('reports an unreadable blob as unpaired without hiding the others', () => {
    const vault = new SessionVault(vaultPath, reversibleCodec);
    vault.write('alpha', sessionFor('a'));
    vault.write('gamma', sessionFor('g'));
    vault.write('beta', sessionFor('b'));

    const raw = JSON.parse(readFileSync(vaultPath, 'utf8')) as {
      sessions: Record<string, string>;
    };
    // What a vault copied from another Windows profile looks like: the file parses and the
    // ciphertext does not decrypt.
    raw.sessions.alpha = 'not-decryptable-under-this-profile';
    // …and what an older build's record looks like: it decrypts to valid JSON that is only
    // half a session.
    raw.sessions.gamma = Buffer.from(JSON.stringify({ deviceId: 'dev-g' }), 'utf8').toString(
      'base64',
    );
    writeFileSync(vaultPath, JSON.stringify(raw), 'utf8');

    const reopened = new SessionVault(vaultPath, {
      ...reversibleCodec,
      decrypt: (ciphertext) => {
        if (ciphertext === 'not-decryptable-under-this-profile') throw new Error('DPAPI refused');
        return reversibleCodec.decrypt(ciphertext);
      },
    });

    // `null` rather than a half-built object or a loop on a decrypt that will never work:
    // the row offers the code entry, and nothing downstream reads a token off `undefined`.
    expect(reopened.read('alpha')).toBeNull();
    expect(reopened.read('gamma')).toBeNull();
    expect(reopened.read('beta')?.accessToken).toBe('access-b');
  });

  it('refuses to write a token in the clear, and says so without quoting one', () => {
    const unavailable: SecretCodec = {
      available: () => false,
      encrypt: () => {
        throw new Error('unreachable');
      },
      decrypt: () => {
        throw new Error('unreachable');
      },
    };
    const vault = new SessionVault(vaultPath, unavailable);

    let thrown: unknown;
    try {
      vault.write('alpha', sessionFor('a'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SecretStorageUnavailable);
    // This message is shown in a dialog and pasted into bug reports.
    expect((thrown as Error).message).not.toContain('access-a');
    expect((thrown as Error).message).not.toContain('refresh-a');
  });

  it('writes ciphertext, never the token itself', () => {
    const vault = new SessionVault(vaultPath, reversibleCodec);
    vault.write('alpha', sessionFor('a'));

    const onDisk = readFileSync(vaultPath, 'utf8');
    expect(onDisk).toContain('alpha');
    expect(onDisk).not.toContain('access-a');
    expect(onDisk).not.toContain('dav-a');
  });
});

describe('ServerRegistry', () => {
  it('derives an id from the host so a rebuilt list still finds its session', () => {
    const first = new ServerRegistry(registryPath);
    const added = first.add('Alpha.Tail1234.TS.net/');

    expect(added.host).toBe('alpha.tail1234.ts.net');
    expect(added.id).toBe(serverIdFor('alpha.tail1234.ts.net'));
    expect(baseUrlFor(added.host)).toBe('https://alpha.tail1234.ts.net');

    // Delete the registry, add the same host again: a random id here would orphan a perfectly
    // good device token and make the user pair a second time for nothing.
    rmSync(registryPath, { force: true });
    expect(new ServerRegistry(registryPath).add('https://alpha.tail1234.ts.net').id).toBe(added.id);
  });

  it('does not add the same host twice, and renames it in place instead', () => {
    const registry = new ServerRegistry(registryPath);
    const first = registry.add('alpha.tail1234.ts.net');
    const again = registry.add('alpha.tail1234.ts.net', 'رایانهٔ علی');

    expect(again.id).toBe(first.id);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.label).toBe('رایانهٔ علی');
  });

  it('removes one row without disturbing the other, on disk as well as in memory', () => {
    const registry = new ServerRegistry(registryPath);
    const alpha = registry.add('alpha.tail1234.ts.net');
    const beta = registry.add('beta.tail5678.ts.net');

    registry.noteConnected(beta.id, 1_700_000_000_000);
    registry.remove(alpha.id);

    expect(registry.list().map((server) => server.id)).toEqual([beta.id]);
    const reopened = new ServerRegistry(registryPath);
    expect(reopened.list().map((server) => server.id)).toEqual([beta.id]);
    expect(reopened.get(beta.id)?.lastConnectedAt).toBe(1_700_000_000_000);
  });

  it('starts with an empty list rather than failing when the registry file is damaged', () => {
    new ServerRegistry(registryPath).add('alpha.tail1234.ts.net');
    writeFileSync(registryPath, '{"version":1,"servers":[{"id"', 'utf8');

    const reopened = new ServerRegistry(registryPath);
    expect(reopened.list()).toEqual([]);
    // …and it is still usable, so the user can type the address again.
    expect(reopened.add('alpha.tail1234.ts.net').host).toBe('alpha.tail1234.ts.net');
  });
});
