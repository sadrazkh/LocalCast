import { describe, expect, it } from 'vitest';
import { folderSchema } from '@localcast/contract';
import { z } from 'zod';
import { NetworkError } from '../errors.js';
import { CACHE_POLICIES, evaluate, OfflineCache } from '../offline.js';
import { FakeClock, folder, MemoryCacheStore } from './fakes.js';

const foldersSchema = z.array(folderSchema);

function cache(online = true) {
  const clock = new FakeClock();
  const store = new MemoryCacheStore();
  let isOnline = online;
  return {
    clock,
    store,
    setOnline: (value: boolean) => {
      isOnline = value;
    },
    cache: new OfflineCache({ store, clock, isOnline: () => isOnline }),
  };
}

describe('cache policy', () => {
  it('serves a fresh value without asking the server', () => {
    expect(evaluate({ resource: 'folders', storedAt: 1_000, now: 2_000, online: true })).toBe('fresh');
  });

  it('serves listings and metadata stale when offline', () => {
    const now = 10 * 60_000;
    expect(evaluate({ resource: 'folders', storedAt: 0, now, online: false })).toBe('stale-ok');
    expect(evaluate({ resource: 'entries', storedAt: 0, now, online: false })).toBe('stale-ok');
    expect(evaluate({ resource: 'file-meta', storedAt: 0, now: 2 * 60 * 60_000, online: false })).toBe(
      'stale-ok',
    );
    expect(evaluate({ resource: 'me', storedAt: 0, now: 60 * 60_000, online: false })).toBe('stale-ok');
  });

  it('never serves search, printers or print jobs stale', () => {
    const now = 10 * 60_000;
    for (const resource of ['search', 'printers', 'print-jobs'] as const) {
      expect(evaluate({ resource, storedAt: 0, now, online: false })).toBe('expired');
      expect(CACHE_POLICIES[resource].staleWhileOffline).toBe(false);
    }
  });

  it('expires a copy that is older than the resource allows even when offline', () => {
    const eightDays = 8 * 24 * 60 * 60_000;
    expect(evaluate({ resource: 'folders', storedAt: 0, now: eightDays, online: false })).toBe('expired');
  });

  it('does not serve stale while the server is reachable — it refetches', () => {
    expect(evaluate({ resource: 'folders', storedAt: 0, now: 10 * 60_000, online: true })).toBe('expired');
  });

  it('reports a miss when nothing was ever stored', () => {
    expect(evaluate({ resource: 'folders', storedAt: null, now: 1, online: false })).toBe('miss');
  });
});

describe('OfflineCache', () => {
  it('fetches, caches, then serves the cached copy inside the TTL', async () => {
    const { cache: c } = cache();
    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      return foldersSchema.parse([folder()]);
    };

    const first = await c.withCache('folders', 'all', foldersSchema, fetcher);
    const second = await c.withCache('folders', 'all', foldersSchema, fetcher);

    expect(fetches).toBe(1);
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(false);
    expect(second.value[0]?.id).toBe('f1');
  });

  it('falls back to a stale copy when the server cannot be reached', async () => {
    const { cache: c, clock, setOnline } = cache();
    await c.withCache('folders', 'all', foldersSchema, async () => foldersSchema.parse([folder()]));

    clock.advance(10 * 60_000);
    setOnline(false);
    const result = await c.withCache('folders', 'all', foldersSchema, async () => {
      throw new NetworkError('offline');
    });

    expect(result.stale).toBe(true);
    expect(result.value[0]?.id).toBe('f1');
  });

  it('never papers over a server-side refusal with a cached copy', async () => {
    const { cache: c, clock } = cache();
    await c.withCache('folders', 'all', foldersSchema, async () => foldersSchema.parse([folder()]));
    clock.advance(10 * 60_000);

    // A folder an operator has just closed must disappear, not linger from the cache.
    await expect(
      c.withCache('folders', 'all', foldersSchema, async () => {
        throw new Error('403 forbidden');
      }),
    ).rejects.toThrowError('403 forbidden');
  });

  it('does not write resources whose policy forbids serving them at all', async () => {
    const { cache: c, store } = cache();
    await c.write('print-jobs', 'all', [{ id: 'j1' }]);
    expect(store.entries.size).toBe(0);
  });

  it('drops an entry written by an older build rather than handing back the wrong shape', async () => {
    const { cache: c, store, clock } = cache();
    store.entries.set('folders:all', { value: [{ id: 'f1' }], storedAt: clock.now() });

    const result = await c.read('folders', 'all', foldersSchema);

    expect(result).toBeNull();
    expect(store.entries.size).toBe(0);
  });
});
