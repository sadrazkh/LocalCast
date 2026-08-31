/**
 * The pluggable seams.
 *
 * This file is the whole reason `client-core` exists. Everything else in the package —
 * transport, token lifecycle, the typed API surface, SSE, the connection dot, the offline
 * policy — is written against these interfaces and nothing else. Adding an Android client
 * therefore means writing a `TokenStore` (keychain) and an `HttpTransport` (OkHttp), not
 * re-deriving the protocol from `packages/contract` a second time.
 *
 * Consequently: no module under `src/` may reference a browser global at module scope. The
 * `fetch`- and `EventSource`-based implementations live in their own files so a platform
 * that supplies its own never evaluates them.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD';

export interface TransportRequest {
  url: string;
  method: HttpMethod;
  /**
   * Header names are lower-cased by convention. Callers that build on top of a request (the
   * session manager attaching a bearer, the SSE client attaching `last-event-id`) rely on
   * that so they overwrite rather than duplicate.
   */
  headers?: Record<string, string>;
  /** `Uint8Array` is here for upload chunks; every other route in the device API is JSON. */
  body?: string | Uint8Array | null;
  signal?: AbortSignal;
  /** Milliseconds before the transport should give up. Streaming requests must ignore it. */
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased header names, so callers never have to guess the casing a platform used. */
  headers: Record<string, string>;
  /**
   * The raw text of the response. The device API speaks JSON only; file bytes are never read
   * through here — `contentUrl()` and `davUrl()` hand a URL to the player instead, because a
   * `<video>` element and a native player want a URL, not a buffer.
   */
  body: string;
}

export interface HttpTransport {
  request(req: TransportRequest): Promise<TransportResponse>;
  /**
   * Optional: only the SSE client needs it. A platform without a streaming primitive can omit
   * it and supply an `SseChannel` of its own instead (see `events.ts`).
   */
  stream?(req: TransportRequest): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Everything a paired device holds. Written as one record so a platform's secure store deals
 * with a single blob — a keychain item, one IndexedDB row — rather than six keys that can
 * drift out of step with each other after a half-completed refresh.
 */
export interface StoredSession {
  deviceId: string;
  accessToken: string;
  /** Rotating and opaque. The moment a refresh succeeds, the previous value is dead. */
  refreshToken: string;
  /** Epoch milliseconds at which `accessToken` stops being accepted. */
  expiresAt: number;
  /** MagicDNS host this device paired against. Survives a network-mode switch by re-resolving. */
  host: string;
  /** Basic-auth password for the read-only WebDAV mount; shown once at pairing, never again. */
  davPassword: string;
}

export interface TokenStore {
  read(): Promise<StoredSession | null>;
  write(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

export interface Clock {
  now(): number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Deliberately one method rather than four. A platform bridging to Logcat or `os_log` maps a
 * single call; and there is exactly one place to enforce that a token never reaches a log.
 */
export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { log: () => {} };

/**
 * Storage for the offline library. `offline.ts` owns the policy — what may be served stale
 * and for how long — and this port owns nothing but bytes in and bytes out. On the PWA this
 * is IndexedDB; on a desktop client it may be SQLite; neither leaks into the policy.
 */
export interface CacheEntry {
  value: unknown;
  /** Epoch milliseconds at which the value was written. Freshness is decided from this. */
  storedAt: number;
}

export interface CacheStore {
  read(key: string): Promise<CacheEntry | null>;
  write(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
