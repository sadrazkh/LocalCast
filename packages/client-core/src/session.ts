import { API_PREFIX, ErrorCode, refreshResponseSchema } from '@localcast/contract';
import { Emitter } from './emitter.js';
import {
  decodeJson,
  errorFromResponse,
  isRefreshable,
  isRevocation,
  LocalCastError,
} from './errors.js';
import { isSuccess, JSON_HEADERS, normaliseBaseUrl, send } from './http.js';
import type { Clock, HttpTransport, Logger, StoredSession, TokenStore } from './ports.js';

/**
 * Refresh this long before the access token actually expires.
 *
 * Five minutes covers a clock that is a couple of minutes off, a phone that was suspended
 * mid-request, and a slow tailnet hop — all without the user ever seeing a 401 turn into a
 * spinner. It is a proactive refresh, not a retry.
 */
export const REFRESH_SKEW_MS = 5 * 60_000;

export interface SessionEvents {
  /**
   * The device no longer has access and no amount of retrying will change that. Every client
   * listens to this and returns to the pairing screen.
   */
  'signed-out': { code: ErrorCode; reason: string };
  'session-changed': { session: StoredSession | null };
}

export interface SessionManagerOptions {
  transport: HttpTransport;
  tokenStore: TokenStore;
  clock: Clock;
  baseUrl: string;
  logger?: Logger;
}

const REFRESH_ROUTE = 'POST /token/refresh';

/**
 * Owns the token lifecycle: read it, keep it fresh, rotate it, and know when to give up.
 *
 * The single hard requirement is that **at most one refresh is ever in flight**. Refresh
 * tokens rotate — the server kills the old one the instant it issues a new one — so two
 * concurrent refreshes mean the second one presents a token that was just invalidated, and
 * the device is signed out despite having done nothing wrong. Five concurrent requests
 * hitting an expired token is the ordinary case (a library screen fires folders, entries,
 * printers, `me` and a thumbnail at once), not an edge case.
 */
export class SessionManager {
  readonly events = new Emitter<SessionEvents>();

  readonly #transport: HttpTransport;
  readonly #store: TokenStore;
  readonly #clock: Clock;
  readonly #baseUrl: string;
  readonly #logger: Logger | undefined;

  /** `undefined` means "not read from the store yet"; `null` means "read, and there is none". */
  #session: StoredSession | null | undefined = undefined;
  #loading: Promise<StoredSession | null> | null = null;
  #refreshing: Promise<StoredSession> | null = null;

  constructor(options: SessionManagerOptions) {
    this.#transport = options.transport;
    this.#store = options.tokenStore;
    this.#clock = options.clock;
    this.#baseUrl = normaliseBaseUrl(options.baseUrl);
    this.#logger = options.logger;
  }

  /** Whatever is currently held, without touching the network. */
  async load(): Promise<StoredSession | null> {
    if (this.#session !== undefined) return this.#session;
    // Single-flight the store read too: on a cold start every call site asks at once, and a
    // keychain prompt firing five times is a visible defect on a native client.
    this.#loading ??= this.#store
      .read()
      .then((session) => {
        this.#session = session;
        return session;
      })
      .finally(() => {
        this.#loading = null;
      });
    return this.#loading;
  }

  /** The session in memory, or `null`. Synchronous; does not read the store. */
  peek(): StoredSession | null {
    return this.#session ?? null;
  }

  /** Install the session produced by a successful pairing. */
  async adopt(session: StoredSession): Promise<void> {
    await this.#store.write(session);
    this.#session = session;
    this.events.emit('session-changed', { session });
  }

  /**
   * Return a session whose access token will still be valid for the next few minutes,
   * refreshing first if it will not. `null` when this device has never been paired.
   */
  async ensureFresh(): Promise<StoredSession | null> {
    const session = await this.load();
    if (session === null) return null;
    if (session.expiresAt - this.#clock.now() > REFRESH_SKEW_MS) return session;
    return this.#refresh(session);
  }

  /**
   * Called after a request came back 401 with the token `staleAccessToken`.
   *
   * If the in-memory token has already moved on, another caller won this race and refreshed
   * for us — return its result rather than spending (and thereby burning) the freshly issued
   * refresh token on a second round trip.
   */
  async refreshAfter(staleAccessToken: string): Promise<StoredSession | null> {
    const session = await this.load();
    if (session === null) return null;
    if (session.accessToken !== staleAccessToken) return session;
    return this.#refresh(session);
  }

  /**
   * Report an error from an ordinary route so revocation is acted on wherever it surfaces —
   * a 403 `device_revoked` on `GET /folders` must sign out just as decisively as one on the
   * refresh endpoint.
   */
  async noteError(error: LocalCastError): Promise<void> {
    if (isRevocation(error.code)) {
      await this.signOut(error.code, error.message);
    }
  }

  async signOut(code: ErrorCode = ErrorCode.UNAUTHENTICATED, reason = 'signed out'): Promise<void> {
    this.#session = null;
    this.#refreshing = null;
    await this.#store.clear();
    this.events.emit('session-changed', { session: null });
    this.events.emit('signed-out', { code, reason });
  }

  /** Attach the bearer to a header bag. */
  authorize(headers: Record<string, string>, accessToken: string): Record<string, string> {
    return { ...headers, authorization: `Bearer ${accessToken}` };
  }

  #refresh(known: StoredSession): Promise<StoredSession> {
    // The single-flight gate. Everything above funnels through here.
    this.#refreshing ??= this.#performRefresh(known).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #performRefresh(known: StoredSession): Promise<StoredSession> {
    const response = await send(
      this.#transport,
      {
        url: `${this.#baseUrl}${API_PREFIX}/token/refresh`,
        method: 'POST',
        headers: { ...JSON_HEADERS },
        body: JSON.stringify({ refreshToken: known.refreshToken }),
      },
      REFRESH_ROUTE,
    );

    if (!isSuccess(response.status)) {
      const error = errorFromResponse(response, REFRESH_ROUTE);
      // On this route "unauthenticated" is terminal, not retryable: the refresh token itself
      // was rejected, so there is nothing left to present.
      if (isRevocation(error.code) || isRefreshable(error.code)) {
        await this.signOut(error.code, error.message);
      }
      throw error;
    }

    const refreshed = decodeJson(refreshResponseSchema, response, REFRESH_ROUTE);
    const next: StoredSession = {
      ...known,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    // Persist before returning. `known.refreshToken` is already dead server-side; if the
    // process died between here and the write, the device would be unrecoverable.
    await this.#store.write(next);
    this.#session = next;
    this.#logger?.log('debug', 'access token refreshed', { expiresAt: next.expiresAt });
    this.events.emit('session-changed', { session: next });
    return next;
  }
}
