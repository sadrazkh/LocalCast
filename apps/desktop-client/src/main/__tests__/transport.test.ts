/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@localcast/contract';
import { LocalCastError } from '@localcast/client-core';
import { MainHttpTransport } from '../transport.js';

/**
 * The main-process transport, driven through a stubbed global `fetch`.
 *
 * Two questions are worth asking of this file and no others: does `open()` hand back enough
 * for the download queue to decide what happened (status, headers, a stream), and does the
 * inherited behaviour that turns a proxy's HTML error page into a typed error still apply
 * here rather than having been quietly reimplemented?
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(response: Response | (() => Response)): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : response;
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

describe('MainHttpTransport.open', () => {
  it('returns status, lower-cased headers and the byte stream together', async () => {
    stubFetch(
      new Response('abcdef', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-5/12', 'Content-Length': '6' },
      }),
    );

    const opened = await new MainHttpTransport().open({
      url: 'https://alpha.tail1234.ts.net/api/v1/files/f1/content',
      method: 'GET',
      headers: { range: 'bytes=0-' },
    });

    expect(opened.status).toBe(206);
    // Lower-cased to match the port's convention: the download queue reads
    // `headers['content-range']` and would silently see `undefined` otherwise, which is how a
    // 206 ends up mistaken for a whole file.
    expect(opened.headers['content-range']).toBe('bytes 0-5/12');
    expect(opened.headers['content-length']).toBe('6');
    expect(opened.body).not.toBeNull();
    expect(await new Response(opened.body).text()).toBe('abcdef');
  });

  it('applies no timeout of its own and passes the caller’s signal straight through', async () => {
    const calls = stubFetch(new Response('x', { status: 200 }));
    const controller = new AbortController();

    // A default timeout is configured, exactly as `index.ts` configures it for the JSON
    // routes. An 18 GB film on a slow tailnet link is a long request, not a stuck one, so it
    // must not inherit that 20-second budget.
    await new MainHttpTransport({ defaultTimeoutMs: 20_000 }).open({
      url: 'https://alpha.tail1234.ts.net/api/v1/files/f1/content',
      method: 'GET',
      headers: { range: 'bytes=100-' },
      signal: controller.signal,
    });

    const init = calls[0]!.init;
    expect(init.signal).toBe(controller.signal);
    expect(init.credentials).toBe('omit');
    expect(init.headers).toMatchObject({ range: 'bytes=100-' });
  });

  it('does not throw on a non-2xx: the caller needs the status and the body to type it', async () => {
    stubFetch(
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const opened = await new MainHttpTransport().open({
      url: 'https://alpha.tail1234.ts.net/api/v1/files/f1/content',
      method: 'GET',
      headers: {},
    });

    // `open()` reports; it does not judge. A 416 is a normal answer to a resume and would be
    // unreachable if this threw, and the download queue is the thing that knows the
    // difference between that and a gateway page.
    expect(opened.status).toBe(502);
    expect(await new Response(opened.body).text()).toContain('502 Bad Gateway');
  });

  it('reports a missing fetch as a typed error rather than a TypeError', async () => {
    (globalThis as { fetch?: unknown }).fetch = undefined;

    await expect(
      new MainHttpTransport().open({
        url: 'https://alpha.tail1234.ts.net/api/v1/files/f1/content',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toMatchObject({ name: 'LocalCastError', code: ErrorCode.INTERNAL });
  });
});

describe('MainHttpTransport — what it inherits', () => {
  it('turns a captive-portal HTML page on a stream into a typed error, not a SyntaxError', async () => {
    stubFetch(
      new Response('<html><head><title>Sign in to this network</title></head></html>', {
        status: 511,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const error = await new MainHttpTransport()
      .stream({
        url: 'https://alpha.tail1234.ts.net/api/v1/events',
        method: 'GET',
        headers: {},
      })
      .catch((cause: unknown) => cause);

    // Inherited from `FetchTransport`, and asserted here because the class overrides a
    // neighbouring method: a copy of `stream()` in this file that forgot the non-2xx branch
    // would leave the SSE client retrying a sign-in page for ever.
    expect(error).toBeInstanceOf(LocalCastError);
    expect((error as LocalCastError).code).toBe(ErrorCode.INTERNAL);
    expect((error as LocalCastError).status).toBe(511);
  });
});
