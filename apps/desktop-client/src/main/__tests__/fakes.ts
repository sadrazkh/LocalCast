import type { Clock, HttpTransport, TransportRequest, TransportResponse } from '@localcast/client-core';
import type { SecretCodec } from '../tokenStore.js';

/**
 * Test doubles for the main-process suites.
 *
 * They exist so nothing under test has to import `electron`: `SessionVault` takes a
 * `SecretCodec`, `ClientHub` takes an `HttpTransport` and a `Clock`. If a future change makes
 * one of these classes reach for `safeStorage` or `app` directly, these fakes stop compiling,
 * which is the point.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type Responder = (request: TransportRequest) => TransportResponse | undefined;

export class RecordingTransport implements HttpTransport {
  readonly sent: RecordedRequest[] = [];
  readonly #responders: Responder[];

  constructor(...responders: Responder[]) {
    this.#responders = responders;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.sent.push({
      url: request.url,
      method: request.method,
      headers: { ...(request.headers ?? {}) },
      body: typeof request.body === 'string' ? request.body : null,
    });
    for (const responder of this.#responders) {
      const answer = responder(request);
      if (answer !== undefined) return answer;
    }
    return json(404, { error: { code: 'not_found', message: `no fake for ${request.url}` } });
  }

  /**
   * A stream that never yields and closes only when the caller aborts.
   *
   * `createClient` wires the SSE client to the transport, and `ClientHub.pair` starts it. A
   * transport with no `stream` would make the event client throw, back off and retry for the
   * life of the test process; this keeps it parked until `stopAll()`.
   */
  async stream(request: TransportRequest): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        request.signal?.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // Already closed by a previous abort; nothing to do.
          }
        });
      },
    });
  }

  /** Every authorization header this transport was asked to send to a given origin. */
  bearersFor(origin: string): string[] {
    return this.sent
      .filter((request) => request.url.startsWith(origin))
      .map((request) => request.headers.authorization)
      .filter((value): value is string => value !== undefined);
  }
}

export function json(status: number, body: unknown): TransportResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** A `Clock` the test moves by hand. */
export class FakeClock implements Clock {
  constructor(public value = 1_700_000_000_000) {}
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

/**
 * A codec that is honest about being reversible.
 *
 * Base64 is not encryption and this is not pretending otherwise — it exists so the vault's
 * behaviour (per-server keys, atomic writes, tolerance of an unreadable blob) can be
 * exercised without DPAPI. The real one is `electronSecretCodec`.
 */
export const reversibleCodec: SecretCodec = {
  available: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, 'utf8').toString('base64'),
  decrypt: (ciphertext) => Buffer.from(ciphertext, 'base64').toString('utf8'),
};
