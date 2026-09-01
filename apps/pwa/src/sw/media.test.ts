import { describe, expect, it, vi } from 'vitest';
import { API_PREFIX, DAV_PREFIX } from '@localcast/contract';
import {
  SW_API_PREFIX,
  SW_DAV_PREFIX,
  createTokenReader,
  fetchMedia,
  isProtectedMediaUrl,
  routeMedia,
  withBearer,
  type MediaFetchDeps,
} from './media.js';

/**
 * These tests guard the one thing that makes video work at all: `<video src>` cannot send an
 * Authorization header, so the service worker attaches it. If this file goes green while the
 * behaviour is broken, nothing plays and the failure looks like a server problem.
 */

const ORIGIN = 'https://localcast.tail1234.ts.net';

function deps(overrides: Partial<MediaFetchDeps> = {}): MediaFetchDeps {
  return {
    origin: ORIGIN,
    getToken: async () => 'token-a',
    invalidateToken: () => undefined,
    fetch: vi.fn(async () => new Response('ok', { status: 200 })),
    ...overrides,
  };
}

describe('the prefixes are copied from the contract, so they must still match it', () => {
  it('has not drifted', () => {
    // The duplication is deliberate — importing the contract would pull zod into the
    // service-worker bundle for two strings — so this is what stops it rotting.
    expect(SW_API_PREFIX).toBe(API_PREFIX);
    expect(SW_DAV_PREFIX).toBe(DAV_PREFIX);
  });
});

describe('which requests get the bearer', () => {
  it('claims the Range endpoint and the WebDAV mount', () => {
    expect(isProtectedMediaUrl(new URL(`${ORIGIN}/api/v1/files/abc/content`), ORIGIN)).toBe(true);
    expect(isProtectedMediaUrl(new URL(`${ORIGIN}/dav/folder-1/Dune.mkv`), ORIGIN)).toBe(true);
    expect(isProtectedMediaUrl(new URL(`${ORIGIN}/dav`), ORIGIN)).toBe(true);
  });

  it('leaves the rest of the API alone', () => {
    // Those calls come from the page, which sets its own header through client-core.
    expect(isProtectedMediaUrl(new URL(`${ORIGIN}/api/v1/folders`), ORIGIN)).toBe(false);
    expect(isProtectedMediaUrl(new URL(`${ORIGIN}/api/v1/files/abc/meta`), ORIGIN)).toBe(false);
    expect(isProtectedMediaUrl(new URL(`${ORIGIN}/index.html`), ORIGIN)).toBe(false);
  });

  it('never attaches the token to another origin', () => {
    // The one mistake in this module that is a security bug rather than a playback bug.
    const evil = new URL('https://attacker.example/api/v1/files/abc/content');
    expect(isProtectedMediaUrl(evil, ORIGIN)).toBe(false);
    expect(routeMedia(new Request(evil, { method: 'GET' }), deps())).toBeNull();
  });
});

describe('rebuilding the request', () => {
  it('copies the incoming headers verbatim and adds the bearer', async () => {
    // Typed with the argument, so `mock.calls[0][0]` is a Request rather than an empty tuple.
    const fetchSpy = vi.fn(async (_input: Request) => new Response(null, { status: 206 }));
    const request = new Request(`${ORIGIN}/api/v1/files/abc/content`, {
      headers: { 'x-passthrough': 'kept', accept: 'video/mp4' },
    });

    await routeMedia(request, deps({ fetch: fetchSpy as unknown as typeof globalThis.fetch }));

    const sent = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(sent.headers.get('x-passthrough')).toBe('kept');
    expect(sent.headers.get('accept')).toBe('video/mp4');
    expect(sent.headers.get('authorization')).toBe('Bearer token-a');
    expect(sent.url).toBe(`${ORIGIN}/api/v1/files/abc/content`);
    expect(sent.method).toBe('GET');
  });

  it('documents why Range is not asserted here', () => {
    // jsdom's Headers still enforces an outdated forbidden-header list and silently drops
    // `Range` on `set()`, so a Range assertion in this environment fails against correct
    // code. Verified in Chromium 148: `new Headers().set('range', …)` keeps the value and it
    // survives into a constructed Request, which is exactly what `withBearer` relies on.
    //
    // This test pins the quirk so nobody "fixes" withBearer to satisfy jsdom. The real
    // behaviour — seeking a multi-gigabyte file over cellular — is item 1 of
    // docs/acceptance-checklist.md, because only a device can prove it.
    const headers = new Headers();
    headers.set('range', 'bytes=0-1');
    const droppedByJsdom = headers.get('range') === null;
    expect(droppedByJsdom).toBe(true);
  });

  it('is same-origin rather than no-cors, or the header would be silently dropped', () => {
    const rebuilt = withBearer(new Request(`${ORIGIN}/dav/f/x.mp4`), 'token-a');
    expect(rebuilt.mode).toBe('same-origin');
    expect(rebuilt.credentials).toBe('omit');
  });

  it('sends no authorization header at all when the device is unpaired', () => {
    expect(withBearer(new Request(`${ORIGIN}/dav/f/x.mp4`), null).headers.has('authorization')).toBe(
      false,
    );
  });

  it('ignores methods the Range endpoint does not serve', () => {
    const post = new Request(`${ORIGIN}/api/v1/files/abc/content`, { method: 'POST' });
    expect(routeMedia(post, deps())).toBeNull();
  });
});

describe('a token that moves underneath a playing film', () => {
  it('re-reads the store once on a 401 and retries', async () => {
    let token = 'stale';
    const fetchSpy = vi.fn(async (req: Request) =>
      req.headers.get('authorization') === 'Bearer fresh'
        ? new Response('ok', { status: 206 })
        : new Response('no', { status: 401 }),
    );

    const response = await fetchMedia(
      new Request(`${ORIGIN}/api/v1/files/abc/content`),
      deps({
        fetch: fetchSpy as unknown as typeof globalThis.fetch,
        getToken: async () => token,
        invalidateToken: () => {
          token = 'fresh';
        },
      }),
    );

    expect(response.status).toBe(206);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up after one retry, because a second 401 means revoked', async () => {
    const fetchSpy = vi.fn(async () => new Response('no', { status: 401 }));
    let reads = 0;

    const response = await fetchMedia(
      new Request(`${ORIGIN}/api/v1/files/abc/content`),
      deps({
        fetch: fetchSpy as unknown as typeof globalThis.fetch,
        getToken: async () => `token-${(reads += 1)}`,
        invalidateToken: () => undefined,
      }),
    );

    expect(response.status).toBe(401);
    // Retrying for ever would hide «دسترسی بسته شد» behind an endless spinner.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry when re-reading produced the same token', async () => {
    const fetchSpy = vi.fn(async () => new Response('no', { status: 401 }));
    await fetchMedia(
      new Request(`${ORIGIN}/api/v1/files/abc/content`),
      deps({ fetch: fetchSpy as unknown as typeof globalThis.fetch, getToken: async () => 'same' }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('the token reader', () => {
  it('collapses a burst of range requests into one store read', async () => {
    const read = vi.fn(async () => ({ accessToken: 'token-a' }));
    const reader = createTokenReader(read, () => 0);

    // A seek fires a handful of range requests within a few hundred milliseconds.
    await Promise.all(Array.from({ length: 8 }, () => reader.getToken()));

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the memo expires', async () => {
    const read = vi.fn(async () => ({ accessToken: 'token-a' }));
    let now = 0;
    const reader = createTokenReader(read, () => now, 2_000);

    await reader.getToken();
    now = 2_500;
    await reader.getToken();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('re-reads immediately once invalidated', async () => {
    const read = vi.fn(async () => ({ accessToken: 'token-a' }));
    const reader = createTokenReader(read, () => 0);

    await reader.getToken();
    reader.invalidateToken();
    await reader.getToken();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports an unpaired device as null rather than throwing', async () => {
    const reader = createTokenReader(async () => null, () => 0);
    await expect(reader.getToken()).resolves.toBeNull();
  });
});
