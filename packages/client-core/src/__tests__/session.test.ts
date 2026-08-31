import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@localcast/contract';
import { ApiClient } from '../api.js';
import { LocalCastError } from '../errors.js';
import { REFRESH_SKEW_MS, SessionManager } from '../session.js';
import type { TransportRequest } from '../ports.js';
import {
  apiError,
  BASE_URL,
  bearerOf,
  FakeClock,
  FakeTransport,
  folder,
  json,
  MemoryTokenStore,
  session,
} from './fakes.js';

function refreshTokenOf(request: TransportRequest): string {
  return (JSON.parse(String(request.body)) as { refreshToken: string }).refreshToken;
}

/**
 * Builds a server that hands out `access-N`/`refresh-N` pairs and rejects any bearer that is
 * not the newest one, which is what makes a lost refresh race visible rather than benign.
 */
function rotatingServer() {
  let issued = 1;
  // Nothing is accepted until a refresh has issued a token: `access-1` is already dead
  // server-side while the stored session still thinks it has an hour of life left.
  let current: string | null = null;
  const seenRefreshTokens: string[] = [];

  const handler = (request: TransportRequest) => {
    if (request.url.includes('/token/refresh')) {
      seenRefreshTokens.push(refreshTokenOf(request));
      issued += 1;
      current = `access-${issued}`;
      return json(200, {
        accessToken: current,
        refreshToken: `refresh-${issued}`,
        expiresAt: 1_700_000_000_000 + 3_600_000,
      });
    }
    if (bearerOf(request) !== current) {
      return apiError(401, ErrorCode.TOKEN_EXPIRED, 'access token expired');
    }
    return json(200, { folders: [folder()] });
  };

  return { handler, seenRefreshTokens };
}

function harness(handler: (request: TransportRequest) => ReturnType<typeof json>) {
  const clock = new FakeClock();
  const store = new MemoryTokenStore(session());
  const transport = new FakeTransport(handler);
  const sessions = new SessionManager({ transport, tokenStore: store, clock, baseUrl: BASE_URL });
  const api = new ApiClient({ transport, session: sessions, baseUrl: BASE_URL });
  return { clock, store, transport, sessions, api };
}

describe('token lifecycle', () => {
  it('makes exactly one refresh call when five concurrent requests hit an expired token', async () => {
    const server = rotatingServer();
    // The stored token has already gone stale server-side while the client still believes it
    // has an hour left — the ordinary case after a laptop sleeps.
    const { api, transport } = harness(server.handler);

    const results = await Promise.all([
      api.folders(),
      api.folders(),
      api.folders(),
      api.folders(),
      api.folders(),
    ]);

    expect(transport.countMatching('/token/refresh')).toBe(1);
    expect(server.seenRefreshTokens).toEqual(['refresh-1']);
    for (const folders of results) {
      expect(folders).toHaveLength(1);
      expect(folders[0]?.id).toBe('f1');
    }
  });

  it('single-flights the proactive refresh inside the five-minute skew window', async () => {
    const server = rotatingServer();
    const clock = new FakeClock();
    const store = new MemoryTokenStore(
      // One minute of life left: inside the skew, so every caller wants a refresh at once.
      session({ expiresAt: clock.now() + REFRESH_SKEW_MS - 60_000 }),
    );
    const transport = new FakeTransport(server.handler);
    const sessions = new SessionManager({ transport, tokenStore: store, clock, baseUrl: BASE_URL });
    const api = new ApiClient({ transport, session: sessions, baseUrl: BASE_URL });

    await Promise.all([api.folders(), api.folders(), api.folders(), api.folders(), api.folders()]);

    expect(transport.countMatching('/token/refresh')).toBe(1);
    // Nobody ever sent the stale bearer, because the refresh happened before the request.
    expect(transport.matching('/folders').every((r) => bearerOf(r) === 'access-2')).toBe(true);
  });

  it('discards the old refresh token: rotation is persisted and the dead one is never resent', async () => {
    const server = rotatingServer();
    const { api, transport, store, sessions } = harness(server.handler);

    await api.folders();
    expect(store.peek()?.refreshToken).toBe('refresh-2');
    expect(store.peek()?.accessToken).toBe('access-2');

    // Force a second rotation; it must present the token issued by the first one.
    await sessions.refreshAfter('access-2');
    expect(server.seenRefreshTokens).toEqual(['refresh-1', 'refresh-2']);
    expect(store.peek()?.refreshToken).toBe('refresh-3');
    expect(transport.countMatching('/token/refresh')).toBe(2);
  });

  it('refreshAfter is a no-op once another caller has already rotated the token', async () => {
    const server = rotatingServer();
    const { sessions, transport } = harness(server.handler);

    const first = await sessions.refreshAfter('access-1');
    expect(first?.accessToken).toBe('access-2');

    // A request that was in flight during the rotation comes back 401 holding `access-1`.
    const second = await sessions.refreshAfter('access-1');
    expect(second?.accessToken).toBe('access-2');
    expect(transport.countMatching('/token/refresh')).toBe(1);
  });

  it.each([ErrorCode.TOKEN_REVOKED, ErrorCode.DEVICE_REVOKED])(
    'clears the session and emits signed-out on %s, without retrying',
    async (code) => {
      const status = code === ErrorCode.TOKEN_REVOKED ? 401 : 403;
      const { api, transport, store, sessions } = harness(() => apiError(status, code, 'closed'));

      const emitted: Array<{ code: string }> = [];
      sessions.events.on('signed-out', (payload) => emitted.push(payload));

      await expect(api.folders()).rejects.toMatchObject({ code });

      expect(store.clears).toBe(1);
      expect(store.peek()).toBeNull();
      expect(emitted.map((e) => e.code)).toEqual([code]);
      // No refresh was attempted, and the failed request was not retried.
      expect(transport.countMatching('/token/refresh')).toBe(0);
      expect(transport.countMatching('/folders')).toBe(1);
    },
  );

  it('signs out when the refresh endpoint itself rejects the refresh token', async () => {
    const { api, store, sessions } = harness((request) =>
      request.url.includes('/token/refresh')
        ? apiError(401, ErrorCode.UNAUTHENTICATED, 'unknown refresh token')
        : apiError(401, ErrorCode.TOKEN_EXPIRED, 'expired'),
    );

    const emitted: string[] = [];
    sessions.events.on('signed-out', (payload) => emitted.push(payload.code));

    await expect(api.folders()).rejects.toBeInstanceOf(LocalCastError);
    expect(emitted).toEqual([ErrorCode.UNAUTHENTICATED]);
    expect(store.clears).toBe(1);
  });

  it('retries a refreshable 401 exactly once and does not loop', async () => {
    let folders = 0;
    const { api, transport } = harness((request) => {
      if (request.url.includes('/token/refresh')) {
        return json(200, {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: 1_700_000_000_000 + 3_600_000,
        });
      }
      folders += 1;
      return apiError(401, ErrorCode.TOKEN_EXPIRED, 'still expired');
    });

    await expect(api.folders()).rejects.toMatchObject({ code: ErrorCode.TOKEN_EXPIRED });
    expect(folders).toBe(2);
    expect(transport.countMatching('/token/refresh')).toBe(1);
  });

  it('refuses to send a request at all when the device has never been paired', async () => {
    const clock = new FakeClock();
    const store = new MemoryTokenStore(null);
    const transport = new FakeTransport(() => json(200, { folders: [] }));
    const sessions = new SessionManager({ transport, tokenStore: store, clock, baseUrl: BASE_URL });
    const api = new ApiClient({ transport, session: sessions, baseUrl: BASE_URL });

    await expect(api.folders()).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
    expect(transport.requests).toHaveLength(0);
  });
});
