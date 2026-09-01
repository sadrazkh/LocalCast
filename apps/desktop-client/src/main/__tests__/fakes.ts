import type {
  Clock,
  HttpTransport,
  LogLevel,
  Logger,
  TransportRequest,
  TransportResponse,
} from '@localcast/client-core';
import type { OpenedResponse } from '../transport.js';
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

// ─── the range transport, for the download queue ──────────────────────────────

export interface OpenRecord {
  url: string;
  headers: Record<string, string>;
}

/**
 * One scripted answer to `RangeTransport.open()`.
 *
 * `body` is spelled as bytes rather than as a stream so a test reads as "the server sent
 * these bytes with these headers"; `null` is the bodyless answer a 416 gives.
 */
export interface OpenScript {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string | null;
  /** Yielded a chunk at a time, so a pause can land in the middle of a transfer. */
  stream?: (signal: AbortSignal | undefined) => ReadableStream<Uint8Array>;
}

export class ScriptedRangeTransport {
  readonly opened: OpenRecord[] = [];
  readonly #script: OpenScript[];

  constructor(...script: OpenScript[]) {
    this.#script = [...script];
  }

  async open(request: {
    url: string;
    method: 'GET';
    headers: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<OpenedResponse> {
    this.opened.push({ url: request.url, headers: { ...request.headers } });
    const next = this.#script.shift();
    if (next === undefined) {
      throw new Error(`the transport was asked for ${request.url} with no answer scripted`);
    }
    const body =
      next.stream !== undefined
        ? next.stream(request.signal)
        : next.body === null || next.body === undefined
          ? null
          : streamOf(asBytes(next.body));
    return { status: next.status, headers: next.headers ?? {}, body };
  }

  /** Every `Range` header the queue sent, in order. `null` for a request that sent none. */
  ranges(): (string | null)[] {
    return this.opened.map((record) => record.headers.range ?? null);
  }
}

export function asBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

/** A stream that yields its payload in small chunks, the way a socket would. */
export function streamOf(bytes: Uint8Array, chunkSize = 8): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(sent, sent + chunkSize));
      sent += chunkSize;
    },
  });
}

/** A logger that keeps what it was told, so a test can assert what never reached it. */
export class MemoryLogger implements Logger {
  readonly lines: { level: LogLevel; message: string; fields?: Record<string, unknown> }[] = [];

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    this.lines.push(fields === undefined ? { level, message } : { level, message, fields });
  }

  /** Everything written, flattened, so a secret can be searched for in one place. */
  text(): string {
    return JSON.stringify(this.lines);
  }
}

/** Run the microtask queue until `predicate` holds, or fail loudly rather than hang. */
export async function until(predicate: () => boolean, what = 'a condition'): Promise<void> {
  for (let tick = 0; tick < 2000; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`${what} never became true`);
}
