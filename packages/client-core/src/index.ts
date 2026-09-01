import type { Platform, QrPayload } from '@localcast/contract';
import { ApiClient } from './api.js';
import { ConnectionMonitor } from './connection.js';
import { EventClient, TransportSseChannel } from './events.js';
import type { SseChannel } from './events.js';
import { OfflineCache } from './offline.js';
import { runPairing } from './pairing.js';
import type { CacheStore, Clock, HttpTransport, Logger, StoredSession, TokenStore } from './ports.js';
import { SessionManager } from './session.js';

export * from './ports.js';
export * from './errors.js';
export * from './emitter.js';
export * from './backoff.js';
export * from './http.js';
export * from './sse.js';
export * from './session.js';
export * from './api.js';
export * from './events.js';
export * from './connection.js';
export * from './pairing.js';
export * from './certificates.js';
export * from './codes.js';
export * from './offline.js';

/**
 * The two default implementations. They are re-exported here because the package publishes a
 * single entry point, but they are defined in their own modules and touch no global at import
 * time — a platform that supplies its own transport never constructs either one.
 */
export * from './fetch-transport.js';
export * from './system-clock.js';
export * from './event-source-channel.js';

export interface CreateClientOptions {
  transport: HttpTransport;
  tokenStore: TokenStore;
  clock: Clock;
  baseUrl: string;
  logger?: Logger;
  /** Supply one to get the offline library; omit it and every read goes to the network. */
  cacheStore?: CacheStore;
  /** Override the SSE channel, e.g. on a platform whose transport cannot stream. */
  sseChannel?: SseChannel;
}

export interface PairInput {
  /** The scanned string, or a payload already parsed from a typed code. */
  qr: string | QrPayload;
  deviceName: string;
  platform: Platform;
  signal?: AbortSignal;
}

export interface LocalCastClient {
  api: ApiClient;
  session: SessionManager;
  events: EventClient;
  connection: ConnectionMonitor;
  /** `null` unless a `CacheStore` was supplied. */
  cache: OfflineCache | null;
  /** Pair this device and install the resulting session. */
  pair(input: PairInput): Promise<StoredSession>;
  /** Begin the event stream. Safe to call more than once. */
  start(): void;
  stop(): Promise<void>;
}

/**
 * Assemble the four pieces into a working client.
 *
 * Everything below is wiring, and it is the wiring that makes the parts worth separating:
 * request outcomes feed the connection dot, the dot decides whether the cache may serve
 * stale, the SSE stream feeds both, and a revocation anywhere tears all of it down at once.
 */
export function createClient(options: CreateClientOptions): LocalCastClient {
  const { transport, tokenStore, clock, baseUrl, logger } = options;

  const session = new SessionManager({ transport, tokenStore, clock, baseUrl, logger });
  const connection = new ConnectionMonitor({ clock });

  const api = new ApiClient({
    transport,
    session,
    baseUrl,
    logger,
    onOutcome: (reachedServer) => {
      if (reachedServer) connection.noteSuccess();
      else connection.noteFailure();
    },
  });

  const events = new EventClient({
    channel: options.sseChannel ?? new TransportSseChannel(transport),
    baseUrl,
    logger,
    authorize: async (): Promise<Record<string, string>> => {
      const current = await session.ensureFresh();
      return current === null ? {} : { authorization: `Bearer ${current.accessToken}` };
    },
  });

  // The stream is a connection signal in its own right: on an idle library screen it is the
  // only traffic there is, so without this the dot would never leave `connecting`.
  events.lifecycle.on('open', () => connection.noteSuccess());
  events.lifecycle.on('error', () => connection.noteFailure());
  events.on('connection', (event) => connection.noteServerState(event.state));

  const cache =
    options.cacheStore === undefined
      ? null
      : new OfflineCache({
          store: options.cacheStore,
          clock,
          // The cache asks the dot, not the network. That keeps the hysteresis in one place:
          // a single failed request must not start serving stale listings either.
          isOnline: () => connection.state !== 'offline',
          logger,
        });

  session.events.on('signed-out', () => {
    // An offline library belonging to a device an operator has just closed must not outlive
    // the token that authorised it.
    void events.stop();
    connection.reset();
    void cache?.clear();
  });

  return {
    api,
    session,
    events,
    connection,
    cache,
    async pair(input: PairInput): Promise<StoredSession> {
      const paired = await runPairing({
        api,
        clock,
        qr: input.qr,
        deviceName: input.deviceName,
        platform: input.platform,
        signal: input.signal,
      });
      await session.adopt(paired);
      return paired;
    },
    start(): void {
      void events.start();
    },
    stop(): Promise<void> {
      return events.stop();
    },
  };
}
