import { ErrorCode } from '@localcast/contract';
import { errorFromResponse, LocalCastError } from './errors.js';
import type { HttpTransport, TransportRequest, TransportResponse } from './ports.js';

/**
 * The `fetch` implementation of `HttpTransport`, for every platform that has one.
 *
 * It lives in its own module on purpose. Nothing here runs at import time — `fetch` is looked
 * up lazily inside the methods — so a native client that supplies its own transport pays
 * nothing for this file existing, and a bundler drops it entirely.
 */
export interface FetchTransportOptions {
  /** Injectable so a test, or a platform with a polyfill, can supply its own. */
  fetchImpl?: typeof globalThis.fetch;
  /** Sent on every request, e.g. a locale header the server uses to localise error prose. */
  defaultHeaders?: Record<string, string>;
  /** Applied when a request does not set its own. Streaming requests ignore it. */
  defaultTimeoutMs?: number;
}

export class FetchTransport implements HttpTransport {
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #defaultHeaders: Record<string, string>;
  readonly #defaultTimeoutMs: number | undefined;

  constructor(options: FetchTransportOptions = {}) {
    this.#fetch = options.fetchImpl;
    this.#defaultHeaders = options.defaultHeaders ?? {};
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    const { signal, done } = this.#signal(request.signal, timeoutMs);
    try {
      const response = await this.#call(request, signal);
      const body = await response.text();
      return { status: response.status, headers: headerRecord(response.headers), body };
    } finally {
      done();
    }
  }

  /**
   * No timeout on a stream: `GET /events` is meant to stay open indefinitely, and the 20 s
   * heartbeat is what proves it is alive.
   */
  async stream(request: TransportRequest): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#call(request, request.signal);
    if (response.status < 200 || response.status >= 300) {
      // Surface the failure as a typed error here; a caller reading an empty stream would
      // otherwise see "the server closed the connection" and retry a 401 for ever.
      const body = await response.text().catch(() => '');
      throw errorFromResponse(
        { status: response.status, headers: headerRecord(response.headers), body },
        `${request.method} ${request.url}`,
      );
    }
    if (response.body === null) {
      throw new LocalCastError(ErrorCode.INTERNAL, 'the response had no readable body');
    }
    return response.body;
  }

  async #call(request: TransportRequest, signal: AbortSignal | undefined): Promise<Response> {
    const impl = this.#fetch ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new LocalCastError(
        ErrorCode.INTERNAL,
        'no fetch available; pass fetchImpl or use a transport of your own',
      );
    }
    return impl(request.url, {
      method: request.method,
      headers: { ...this.#defaultHeaders, ...request.headers },
      body: (request.body ?? undefined) as BodyInit | undefined,
      signal,
      // The device API is bearer-authenticated; sending ambient cookies would only widen the
      // surface of a Funnel-exposed origin.
      credentials: 'omit',
      redirect: 'follow',
    });
  }

  /** Merge the caller's signal with a timeout, without leaking a timer when neither fires. */
  #signal(
    caller: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): { signal: AbortSignal | undefined; done: () => void } {
    if (timeoutMs === undefined) return { signal: caller, done: () => {} };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    caller?.addEventListener('abort', onAbort, { once: true });
    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        caller?.removeEventListener('abort', onAbort);
      },
    };
  }
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}
