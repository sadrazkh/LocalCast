import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@localcast/contract';
import { LocalCastError, NetworkError } from '../errors.js';
import { OriginFailoverTransport } from '../origin-failover.js';
import type { HttpTransport, TransportRequest, TransportResponse } from '../ports.js';
import { json } from './fakes.js';

/**
 * A phone must survive the laptop's address changing.
 *
 * The session holds `https://192.168.8.92:8420`. The lease moves. Every request goes to an
 * address nothing answers at, and the app said «قطع» until somebody paired it again — while
 * the server answered at `https://sadra.local:8420` the whole time.
 */

const IP = 'https://192.168.8.92:8420';
const NAME = 'https://sadra.local:8420';
const NEW_IP = 'https://192.168.8.140:8420';

/** An inner transport where some origins are dead and the rest answer. */
function inner(alive: Set<string>, answer: (request: TransportRequest) => TransportResponse = () => json(200, {})) {
  const seen: string[] = [];
  const transport: HttpTransport = {
    async request(request) {
      seen.push(request.url);
      const origin = new URL(request.url).origin;
      if (!alive.has(origin)) throw new TypeError('Failed to fetch');
      return answer(request);
    },
    async stream(request) {
      seen.push(request.url);
      const origin = new URL(request.url).origin;
      if (!alive.has(origin)) throw new TypeError('Failed to fetch');
      return new ReadableStream<Uint8Array>();
    },
  };
  return { transport, seen };
}

describe('following the server to another address', () => {
  it('goes where it was told first, and stays there while it answers', async () => {
    const { transport, seen } = inner(new Set([IP]));
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });

    await failover.request({ url: `${IP}/api/v1/folders`, method: 'GET' });
    expect(seen).toEqual([`${IP}/api/v1/folders`]);
    expect(failover.activeOrigin()).toBe(IP);
  });

  it('tries the alternates when the address stops answering, and adopts the one that does', async () => {
    const { transport, seen } = inner(new Set([NAME]));
    const changes: string[] = [];
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });
    failover.events.on('change', ({ origin }) => changes.push(origin));

    const res = await failover.request({ url: `${IP}/api/v1/folders`, method: 'GET' });
    expect(res.status).toBe(200);
    // Rewritten to the name, path intact.
    expect(seen).toEqual([`${IP}/api/v1/folders`, `${NAME}/api/v1/folders`]);
    expect(failover.activeOrigin()).toBe(NAME);
    expect(changes).toEqual([NAME]);

    // The next request goes straight to the address that worked. No detour through the dead one.
    seen.length = 0;
    await failover.request({ url: `${IP}/api/v1/me`, method: 'GET' });
    expect(seen).toEqual([`${NAME}/api/v1/me`]);
  });

  it('reads the alternates afresh on each failure, so a list refreshed by /me is the list used', async () => {
    const { transport } = inner(new Set([NEW_IP]));
    let alternates: string[] = [];
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => alternates });

    await expect(failover.request({ url: `${IP}/x`, method: 'GET' })).rejects.toBeInstanceOf(TypeError);
    alternates = [NAME, NEW_IP];
    await expect(failover.request({ url: `${IP}/x`, method: 'GET' })).resolves.toMatchObject({ status: 200 });
    expect(failover.activeOrigin()).toBe(NEW_IP);
  });

  it('does not retry an answer, whatever its status', async () => {
    // A 401 is a fact about the token, not the address. Retrying it elsewhere would burn a
    // refresh token on a second origin for nothing.
    const { transport, seen } = inner(new Set([IP]), () => json(401, { error: { code: 'unauthenticated' } }));
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });

    const res = await failover.request({ url: `${IP}/api/v1/folders`, method: 'GET' });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it('does not retry when the caller itself cancelled', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const transport: HttpTransport = {
      async request(request) {
        seen.push(request.url);
        controller.abort();
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    };
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });

    await expect(
      failover.request({ url: `${IP}/api/v1/folders`, method: 'GET', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
  });

  it('treats a timeout as no answer', async () => {
    let calls = 0;
    const transport: HttpTransport = {
      async request(request) {
        calls += 1;
        if (new URL(request.url).origin === IP) {
          const error = new Error('timed out');
          error.name = 'AbortError';
          throw error;
        }
        return json(200, {});
      },
    };
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });
    await expect(failover.request({ url: `${IP}/x`, method: 'GET' })).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
  });

  it('rethrows a typed client error untouched', async () => {
    const transport: HttpTransport = {
      async request() {
        throw new LocalCastError(ErrorCode.INTERNAL, 'no fetch available');
      },
    };
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });
    await expect(failover.request({ url: `${IP}/x`, method: 'GET' })).rejects.toThrow('no fetch available');
  });

  it('accepts a NetworkError from a wrapping transport as no answer', async () => {
    let calls = 0;
    const transport: HttpTransport = {
      async request(request) {
        calls += 1;
        if (new URL(request.url).origin === IP) throw new NetworkError('connection refused');
        return json(200, {});
      },
    };
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });
    await failover.request({ url: `${IP}/x`, method: 'GET' });
    expect(calls).toBe(2);
    expect(failover.activeOrigin()).toBe(NAME);
  });

  it('leaves a request to some other host alone', async () => {
    const { transport, seen } = inner(new Set(['https://example.com']));
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });
    await failover.request({ url: 'https://example.com/thing', method: 'GET' });
    expect(seen).toEqual(['https://example.com/thing']);
  });

  it('fails over the event stream too', async () => {
    const { transport, seen } = inner(new Set([NAME]));
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });
    await failover.stream({ url: `${IP}/api/v1/events`, method: 'GET' });
    expect(seen).toEqual([`${IP}/api/v1/events`, `${NAME}/api/v1/events`]);
  });

  it('comes back to the primary when nothing else answers and it does again', async () => {
    const alive = new Set([NAME]);
    const { transport } = inner(alive);
    const failover = new OriginFailoverTransport({ inner: transport, primary: IP, alternates: () => [NAME] });
    await failover.request({ url: `${IP}/x`, method: 'GET' });
    expect(failover.activeOrigin()).toBe(NAME);

    alive.delete(NAME);
    alive.add(IP);
    await failover.request({ url: `${IP}/x`, method: 'GET' });
    expect(failover.activeOrigin()).toBe(IP);
  });
});
