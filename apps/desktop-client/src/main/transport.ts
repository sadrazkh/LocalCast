import { ErrorCode } from '@localcast/contract';
import { FetchTransport, LocalCastError } from '@localcast/client-core';
import type { TransportRequest } from '@localcast/client-core';

/**
 * Contribution #2 of two: the transport that runs in the **main** process.
 *
 * It extends `client-core`'s `FetchTransport` rather than reimplementing it. Everything the
 * shared package already gets right — header normalisation, the timeout/abort merge, the
 * typed error a non-2xx stream must throw instead of an empty body — is inherited unchanged.
 * What is added is one method the shared port does not have and does not need:
 *
 *   `open()` — a request whose *status, headers and byte stream* are all returned together.
 *
 * The `HttpTransport` port deliberately returns `body: string`, because the device API speaks
 * JSON and file bytes are supposed to reach a player as a URL, not as a buffer. A download to
 * disk is the one case that is neither: it needs the `Content-Range` and `Content-Length`
 * headers to decide whether a resume was honoured, and it needs the bytes as a stream so an
 * 18 GB film is never held in memory. Doing it here, in the main process, is why a download
 * never crosses the context bridge at all.
 */

export interface OpenedResponse {
  status: number;
  /** Lower-cased, matching the port's convention. */
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

export class MainHttpTransport extends FetchTransport {
  /**
   * A request whose body is consumed as a stream by the caller.
   *
   * No timeout is applied: a multi-gigabyte download on a slow tailnet link is a long
   * request, not a stuck one. Cancellation is the caller's `AbortSignal`.
   */
  async open(request: TransportRequest): Promise<OpenedResponse> {
    const impl = globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new LocalCastError(ErrorCode.INTERNAL, 'no fetch available in the main process');
    }
    const response = await impl(request.url, {
      method: request.method,
      headers: { ...request.headers },
      // No cast: `TransportRequest.body` is already `string | Uint8Array | null`, both of
      // which Node's fetch accepts. `BodyInit` is a DOM name and this project has no DOM lib
      // — it runs in the Electron main process, not a renderer.
      body: request.body ?? undefined,
      signal: request.signal,
      // Bearer-authenticated, exactly like every other call this app makes; ambient cookies
      // would only widen the surface of a Funnel-exposed origin.
      credentials: 'omit',
      redirect: 'follow',
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: response.body };
  }
}
