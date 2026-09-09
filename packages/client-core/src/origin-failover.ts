import { Emitter } from './emitter.js';
import { ErrorCode } from '@localcast/contract';
import { LocalCastError, NetworkError } from './errors.js';
import { normaliseBaseUrl } from './http.js';
import type { HttpTransport, Logger, TransportRequest, TransportResponse } from './ports.js';

/**
 * A transport that follows the server to its other addresses.
 *
 * ## The problem
 *
 * A phone pairs at `https://192.168.8.92:8420`. That address is a DHCP lease. When the lease
 * moves — a router reboot, a week away, a second access point — every request the phone makes
 * goes to an address nothing answers at, and the app shows «قطع» until somebody pairs it again.
 * The server, meanwhile, is fine, and answers at `https://sadra.local:8420` the whole time.
 *
 * ## What this does
 *
 * Every request the client builds is against one fixed origin, `primary`. This sits underneath
 * and rewrites that origin to whichever of the server's addresses last answered. When a request
 * fails at the network level — the connection was refused, the host did not resolve, the
 * request timed out — it is retried against each alternate in turn, and the first that answers
 * becomes the active origin for everything after it. A request that *did* reach a server and
 * got an answer, of any status, is never retried here: a 401 is a fact about the token, not the
 * address.
 *
 * The alternates come from the server itself, via `/me`, and are read on every failure so a
 * list refreshed a moment ago is the list that is tried. `primary` is always the last resort,
 * so an address that came back is found again.
 *
 * ## What it does not do
 *
 * It cannot move the page. The web app was loaded from `primary`, and a `<video>` element or a
 * service worker fetch is same-origin to that page, not to this transport. What it buys is the
 * listing, the events stream and the session refresh — enough for the app to open, show the
 * library, and say in a banner which address to use from now on.
 */

export interface OriginFailoverOptions {
  inner: HttpTransport;
  /** The origin every request is built against. */
  primary: string;
  /** The server's other origins, best first. Read afresh on every failure. */
  alternates: () => readonly string[];
  logger?: Logger;
}

export interface OriginChange {
  origin: string;
  previous: string;
}

/**
 * Did this fail before any server answered?
 *
 * Three shapes, because three layers can say so. `NetworkError` is what the client's own
 * wrapping produces. A bare `TypeError` is what `fetch` rejects with — "Failed to fetch",
 * "Load failed", "fetch failed" — on a refused connection or an unresolvable name. And an
 * `AbortError` is a timeout, *unless* the caller's own signal is what fired, in which case it is
 * the user backing out and must not be answered by trying somewhere else.
 */
export function isNetworkFailure(error: unknown, request: TransportRequest): boolean {
  if (request.signal?.aborted === true) return false;
  if (error instanceof NetworkError) return true;
  if (error instanceof LocalCastError) return false;
  if (error instanceof TypeError) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export class OriginFailoverTransport implements HttpTransport {
  readonly events = new Emitter<{ change: OriginChange }>();
  readonly #inner: HttpTransport;
  readonly #primary: string;
  readonly #alternates: () => readonly string[];
  readonly #logger: Logger | undefined;
  #active: string;

  constructor(options: OriginFailoverOptions) {
    this.#inner = options.inner;
    this.#primary = normaliseBaseUrl(options.primary);
    this.#alternates = options.alternates;
    this.#logger = options.logger;
    this.#active = this.#primary;
  }

  /** The origin requests are currently going to. `primary` until something else answered. */
  activeOrigin(): string {
    return this.#active;
  }

  /** Back to the address the client was built against, e.g. after a sign-out. */
  reset(): void {
    this.#adopt(this.#primary);
  }

  request(request: TransportRequest): Promise<TransportResponse> {
    return this.#attempt(request, (rewritten) => this.#inner.request(rewritten));
  }

  stream(request: TransportRequest): Promise<ReadableStream<Uint8Array>> {
    const stream = this.#inner.stream;
    if (stream === undefined) {
      return Promise.reject(
        new LocalCastError(ErrorCode.INTERNAL, 'this transport cannot stream; supply an SseChannel of your own'),
      );
    }
    return this.#attempt(request, (rewritten) => stream.call(this.#inner, rewritten));
  }

  async #attempt<T>(request: TransportRequest, run: (request: TransportRequest) => Promise<T>): Promise<T> {
    const known = this.#knownOrigins();
    const matched = known.find((origin) => request.url === origin || request.url.startsWith(`${origin}/`));
    // Not one of the server's addresses — an absolute URL to somewhere else. Not ours to touch.
    if (matched === undefined) return run(request);
    const path = request.url.slice(matched.length);

    let lastError: unknown = null;
    for (const origin of this.#candidates()) {
      try {
        const result = await run({ ...request, url: `${origin}${path}` });
        this.#adopt(origin);
        return result;
      } catch (error) {
        if (!isNetworkFailure(error, request)) throw error;
        lastError = error;
        this.#logger?.log('warn', `no answer from ${origin}; trying the next address`);
      }
    }
    throw lastError;
  }

  /** Active first, then the alternates in the order the server gave them, then primary. */
  #candidates(): string[] {
    const alternates = this.#alternates().map(normaliseBaseUrl);
    return unique([this.#active, ...alternates, this.#primary]);
  }

  #knownOrigins(): string[] {
    return unique([this.#primary, this.#active, ...this.#alternates().map(normaliseBaseUrl)]);
  }

  #adopt(origin: string): void {
    if (origin === this.#active) return;
    const previous = this.#active;
    this.#active = origin;
    this.#logger?.log('info', `server reached at ${origin}; using it from now on`);
    this.events.emit('change', { origin, previous });
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
