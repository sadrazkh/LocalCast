import { ErrorCode } from '@localcast/contract';
import { LocalCastError } from './errors.js';
import type { SseChannel, SseOpenRequest } from './events.js';

/**
 * An `SseChannel` built on the browser's `EventSource`, for platforms whose only streaming
 * primitive is that.
 *
 * Kept out of `events.ts` deliberately: the default channel reads the stream off the
 * `HttpTransport` port, which is the only way to send an `Authorization` header — `EventSource`
 * cannot. A caller reaching for this one therefore has to say how the connection authenticates
 * itself, by rewriting the URL:
 *
 *     new EventSourceChannel({ authorizeUrl: (url, headers) => withToken(url, headers) })
 *
 * `EventSource` also reconnects on its own and tracks `Last-Event-ID` internally, so this
 * channel resolves only when the connection reaches `CLOSED` — at which point the `EventClient`
 * above applies its own backoff.
 */
export interface EventSourceChannelOptions {
  /**
   * Turn the request's URL and headers into a URL that authenticates itself. Required,
   * because there is no honest default: silently dropping the bearer would produce a stream
   * that 401s for ever behind an automatic retry.
   */
  authorizeUrl: (url: string, headers: Record<string, string>) => string;
  /** Injectable for tests and for a platform with a polyfill. */
  eventSourceImpl?: typeof globalThis.EventSource;
  withCredentials?: boolean;
}

export class EventSourceChannel implements SseChannel {
  readonly #options: EventSourceChannelOptions;

  constructor(options: EventSourceChannelOptions) {
    this.#options = options;
  }

  open(request: SseOpenRequest): Promise<void> {
    const Impl = this.#options.eventSourceImpl ?? globalThis.EventSource;
    if (typeof Impl !== 'function') {
      throw new LocalCastError(
        ErrorCode.INTERNAL,
        'no EventSource available; use TransportSseChannel instead',
      );
    }

    const url = this.#options.authorizeUrl(request.url, request.headers);
    return new Promise<void>((resolve, reject) => {
      const source = new Impl(url, { withCredentials: this.#options.withCredentials ?? false });

      const close = () => {
        source.close();
        request.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        close();
        resolve();
      };
      request.signal.addEventListener('abort', onAbort, { once: true });

      source.onopen = () => request.onOpen?.();
      source.onmessage = (event: MessageEvent<string>) => {
        request.onFrame({ id: event.lastEventId || null, event: event.type, data: event.data });
      };
      source.onerror = () => {
        // `EventSource` fires `error` both for a transient drop it will retry itself and for
        // a terminal failure. Only the terminal one ends this attempt; anything else is left
        // to its own reconnection so we do not run two ladders at once.
        if (source.readyState === 2 /* CLOSED */) {
          close();
          reject(new LocalCastError(ErrorCode.INTERNAL, 'the event stream closed'));
        }
      };
    });
  }
}
