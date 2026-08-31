import { API_PREFIX, ErrorCode, serverEventSchema } from '@localcast/contract';
import type { ServerEvent } from '@localcast/contract';
import type { BackoffOptions, Sleep } from './backoff.js';
import { backoffDelay, SSE_BACKOFF, systemSleep } from './backoff.js';
import { Emitter } from './emitter.js';
import type { Unsubscribe } from './emitter.js';
import { isCancelled, LocalCastError, SchemaDriftError, tryParseJson } from './errors.js';
import { normaliseBaseUrl } from './http.js';
import type { HttpTransport, Logger } from './ports.js';
import { SseDecoder } from './sse.js';
import type { SseFrame } from './sse.js';

/**
 * One SSE connection attempt. A channel resolves when the stream ends cleanly and rejects
 * when it fails; either way the `EventClient` above it decides when to try again. Keeping
 * the reconnect policy out here is what lets a native client swap in its own transport
 * without re-implementing backoff, jitter and `Last-Event-ID`.
 */
export interface SseOpenRequest {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  onFrame(frame: SseFrame): void;
  /** Fired once bytes are flowing. */
  onOpen?(): void;
  /** The server sent a `retry:` field; it becomes the base of the backoff ladder. */
  onRetryHint?(ms: number): void;
}

export interface SseChannel {
  open(request: SseOpenRequest): Promise<void>;
}

/** The default channel: reads the event stream off the `HttpTransport` port. */
export class TransportSseChannel implements SseChannel {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.#transport = transport;
  }

  async open(request: SseOpenRequest): Promise<void> {
    const stream = this.#transport.stream;
    if (stream === undefined) {
      throw new LocalCastError(
        ErrorCode.INTERNAL,
        'this transport cannot stream; supply an SseChannel of your own',
      );
    }
    const body = await stream.call(this.#transport, {
      url: request.url,
      method: 'GET',
      headers: { ...request.headers, accept: 'text/event-stream' },
      signal: request.signal,
    });

    request.onOpen?.();

    const reader = body.getReader();
    const decoder = new SseDecoder();
    const text = new TextDecoder();
    let lastRetryHint: number | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        // `stream: true` matters: a UTF-8 sequence can straddle two network reads, and a
        // folder named in Persian will do exactly that.
        for (const frame of decoder.push(text.decode(value, { stream: true }))) {
          request.onFrame(frame);
        }
        const retry = decoder.retryMs;
        if (retry !== null && retry !== lastRetryHint) {
          lastRetryHint = retry;
          request.onRetryHint?.(retry);
        }
      }
    } finally {
      // Release the lock even when the caller aborted mid-read, or the next attempt cannot
      // touch the body at all.
      reader.releaseLock();
      decoder.reset();
    }
  }
}

/** Payload type per contract event type, so `on('print-job', …)` is typed end to end. */
export type ServerEventMap = { [K in ServerEvent['type']]: Extract<ServerEvent, { type: K }> };

export interface EventStreamLifecycle {
  open: { attempt: number };
  /** The stream ended; `delayMs` is how long until the next attempt. */
  closed: { attempt: number; delayMs: number };
  error: { error: unknown };
  /** A frame arrived that the contract does not describe. Visible, but not fatal. */
  drift: { error: SchemaDriftError };
}

export interface EventClientOptions {
  channel: SseChannel;
  baseUrl: string;
  /** Produces the headers for each attempt — normally the bearer, refreshed if it had aged. */
  authorize?: () => Promise<Record<string, string>>;
  logger?: Logger;
  backoff?: BackoffOptions;
  random?: () => number;
  sleep?: Sleep;
  /**
   * Stop after this many connection attempts. Left undefined the client reconnects for ever,
   * which is what a running app wants; a bounded run is used by tests and by a one-shot probe.
   */
  maxAttempts?: number;
}

/**
 * `GET /api/v1/events`, with the reconnection behaviour the spec's failure table promises.
 *
 * Three things it must get right, all of them invisible when they work:
 *   - back off exponentially with jitter and a ~30 s cap, so a sleeping Windows machine does
 *     not get hammered by every paired device in lockstep when it wakes;
 *   - send `Last-Event-ID` on every reconnect, so a print job that finished while the phone
 *     was in a lift is still delivered rather than silently lost;
 *   - reset the backoff only once a frame has actually arrived. A server that accepts the
 *     connection and immediately drops it would otherwise be retried at full speed for ever.
 */
export class EventClient {
  readonly #events = new Emitter<ServerEventMap>();
  readonly lifecycle: Emitter<EventStreamLifecycle>;

  readonly #channel: SseChannel;
  readonly #url: string;
  readonly #authorize: () => Promise<Record<string, string>>;
  readonly #logger: Logger | undefined;
  readonly #backoff: BackoffOptions;
  readonly #random: () => number;
  readonly #sleep: Sleep;
  readonly #maxAttempts: number | undefined;

  #lastEventId: string | null = null;
  #serverRetryMs: number | null = null;
  #stopper: AbortController | null = null;
  #connection: AbortController | null = null;
  #running: Promise<void> | null = null;

  constructor(options: EventClientOptions) {
    this.#channel = options.channel;
    this.#url = `${normaliseBaseUrl(options.baseUrl)}${API_PREFIX}/events`;
    this.#authorize = options.authorize ?? (async () => ({}));
    this.#logger = options.logger;
    this.lifecycle = new Emitter<EventStreamLifecycle>(options.logger);
    this.#backoff = options.backoff ?? SSE_BACKOFF;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? systemSleep;
    this.#maxAttempts = options.maxAttempts;
  }

  on<K extends ServerEvent['type']>(
    type: K,
    handler: (event: ServerEventMap[K]) => void,
  ): Unsubscribe {
    return this.#events.on(type, handler);
  }

  /** The resume point that will be sent on the next reconnect. */
  get lastEventId(): string | null {
    return this.#lastEventId;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  start(): Promise<void> {
    this.#running ??= this.#loop().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async stop(): Promise<void> {
    this.#stopper?.abort();
    this.#connection?.abort();
    const running = this.#running;
    if (running !== null) {
      await running.catch(() => undefined);
    }
  }

  async #loop(): Promise<void> {
    const stopper = new AbortController();
    this.#stopper = stopper;
    let attempt = 0;
    let attempts = 0;

    while (!stopper.signal.aborted) {
      if (this.#maxAttempts !== undefined && attempts >= this.#maxAttempts) break;
      attempts += 1;

      const connection = new AbortController();
      this.#connection = connection;
      const onStop = () => connection.abort();
      stopper.signal.addEventListener('abort', onStop, { once: true });

      let sawFrame = false;
      try {
        const headers = await this.#authorize();
        if (this.#lastEventId !== null) {
          // The whole point of the id: the server replays anything issued after it.
          headers['last-event-id'] = this.#lastEventId;
        }
        await this.#channel.open({
          url: this.#url,
          headers,
          signal: connection.signal,
          onOpen: () => this.lifecycle.emit('open', { attempt }),
          onFrame: (frame) => {
            sawFrame = true;
            this.#consume(frame);
          },
          onRetryHint: (ms) => this.noteServerRetry(ms),
        });
      } catch (error) {
        if (!isCancelled(error)) {
          this.#logger?.log('debug', 'event stream failed', { error });
          this.lifecycle.emit('error', { error });
        }
      } finally {
        stopper.signal.removeEventListener('abort', onStop);
      }

      if (stopper.signal.aborted) break;
      // A connection that produced data was healthy; start the ladder again from the bottom.
      attempt = sawFrame ? 0 : attempt + 1;

      const base =
        this.#serverRetryMs === null
          ? this.#backoff
          : { ...this.#backoff, baseMs: this.#serverRetryMs };
      const delayMs = backoffDelay(attempt, base, this.#random);
      this.lifecycle.emit('closed', { attempt, delayMs });
      try {
        await this.#sleep(delayMs, stopper.signal);
      } catch {
        break;
      }
    }
  }

  #consume(frame: SseFrame): void {
    if (frame.id !== null) this.#lastEventId = frame.id;
    const parsed = tryParseJson(frame.data);
    if (!parsed.ok) {
      this.lifecycle.emit('drift', {
        error: new SchemaDriftError('GET /events', 'frame data was not JSON'),
      });
      return;
    }
    const result = serverEventSchema.safeParse(parsed.value);
    if (!result.success) {
      // One unrecognised frame — a newer server, a truncated write — must not take the whole
      // stream down. It is still reported, because silently dropping events is how a print
      // job appears to hang for ever.
      this.lifecycle.emit('drift', {
        error: new SchemaDriftError(
          'GET /events',
          'event does not match the contract',
          result.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        ),
      });
      return;
    }
    const event = result.data;
    this.#events.emit(event.type, event as ServerEventMap[typeof event.type]);
  }

  /** Set the resume point explicitly, e.g. from a value persisted across an app restart. */
  resumeFrom(lastEventId: string | null): void {
    this.#lastEventId = lastEventId;
  }

  /** Honour a `retry:` field the server sent on a previous connection. */
  noteServerRetry(ms: number | null): void {
    this.#serverRetryMs = ms;
  }
}
