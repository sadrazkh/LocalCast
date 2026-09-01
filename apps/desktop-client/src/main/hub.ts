import type { QrPayload } from '@localcast/contract';
import { createClient, formatCode, LocalCastError } from '@localcast/client-core';
import type {
  Clock,
  ConnectionState,
  HttpTransport,
  LocalCastClient,
  Logger,
} from '@localcast/client-core';
import type { ServerSummary } from '../shared/ipc.js';
import { baseUrlFor, ServerRegistry } from './registry.js';
import type { ServerRecord } from './registry.js';
import type { SessionVault } from './tokenStore.js';

/**
 * One `LocalCastClient` per paired server, and nothing else.
 *
 * This class is the whole of the multi-server story, and it is deliberately thin. Every
 * behaviour a client needs — the typed API surface, single-flight token refresh, the SSE
 * stream with `Last-Event-ID`, the connection state machine, the pairing claim-and-poll —
 * already exists in `@localcast/client-core` and is created per base URL by `createClient`.
 * What this app adds is a `Map` and the discipline of never reaching across it.
 *
 * The isolation that matters: each entry gets its **own** `TokenStore`, produced by
 * `SessionVault.storeFor(serverId)` and physically unable to name another server's key. A
 * bearer therefore cannot leak from one server to another even if some future call site
 * fetched the wrong client, because the wrong client has no access to the right token.
 */

export interface ClientHubOptions {
  registry: ServerRegistry;
  vault: SessionVault;
  transport: HttpTransport;
  clock: Clock;
  logger?: Logger;
  /** How this machine introduces itself when pairing. */
  deviceName: string;
}

interface Entry {
  record: ServerRecord;
  client: LocalCastClient;
  connection: ConnectionState;
  /** False until `connect()` has run, so an untouched row never claims to be «در حال تلاش». */
  started: boolean;
  paired: boolean;
  deviceId: string | null;
  lastErrorCode: string | null;
  unsubscribe: (() => void)[];
}

export class ClientHub {
  readonly #registry: ServerRegistry;
  readonly #vault: SessionVault;
  readonly #transport: HttpTransport;
  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  readonly #deviceName: string;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(servers: ServerSummary[]) => void>();

  constructor(options: ClientHubOptions) {
    this.#registry = options.registry;
    this.#vault = options.vault;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#deviceName = options.deviceName;

    for (const record of this.#registry.list()) this.#ensure(record);
  }

  onChange(handler: (servers: ServerSummary[]) => void): () => void {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  summaries(): ServerSummary[] {
    return [...this.#entries.values()]
      .map((entry) => this.#summarise(entry))
      .sort((a, b) => a.addedAt - b.addedAt);
  }

  summary(serverId: string): ServerSummary {
    const entry = this.#entries.get(serverId);
    if (entry === undefined) throw new UnknownServer(serverId);
    return this.#summarise(entry);
  }

  /** The shared-package client for one server. Every route in the app goes through this. */
  client(serverId: string): LocalCastClient {
    const entry = this.#entries.get(serverId);
    if (entry === undefined) throw new UnknownServer(serverId);
    return entry.client;
  }

  add(host: string, label?: string): ServerSummary {
    const record = this.#registry.add(host, label);
    const entry = this.#ensure(record);
    this.#emit();
    return this.#summarise(entry);
  }

  /**
   * Start the event stream and prove the session still works.
   *
   * `me()` rather than a bare ping: it is the cheapest call that exercises the whole chain —
   * refresh if the access token had aged, the bearer, and the server's own view of this
   * device's permissions — so a revoked device is discovered here rather than three screens
   * later when a folder listing comes back empty.
   */
  async connect(serverId: string): Promise<ServerSummary> {
    const entry = this.#entries.get(serverId);
    if (entry === undefined) throw new UnknownServer(serverId);

    entry.started = true;
    entry.lastErrorCode = null;
    const session = await entry.client.session.load();
    entry.paired = session !== null;
    entry.deviceId = session?.deviceId ?? null;

    if (session === null) {
      this.#emit();
      return this.#summarise(entry);
    }

    entry.client.start();
    try {
      await entry.client.api.me();
      this.#registry.noteConnected(serverId, this.#clock.now());
      entry.record.lastConnectedAt = this.#clock.now();
    } catch (error) {
      entry.lastErrorCode = error instanceof LocalCastError ? error.code : 'internal';
      this.#logger?.log('warn', 'could not reach server', { serverId, code: entry.lastErrorCode });
    }
    // A `signed-out` event may have fired inside `me()`; re-read rather than trusting the
    // value captured before the call.
    entry.paired = entry.client.session.peek() !== null;
    this.#emit();
    return this.#summarise(entry);
  }

  /**
   * Pair with the four-character code the operator read off their panel.
   *
   * This delegates to `client-core`'s `runPairing` through `client.pair()` — the claim, the
   * backed-off poll, the expiry, the rejected-by-operator branch and the `session.adopt`
   * write are all its behaviour, unchanged. The only thing the desktop decides is that there
   * is no camera here, so the payload is assembled from a typed code instead of a scan.
   */
  async pair(serverId: string, code: string, signal?: AbortSignal): Promise<ServerSummary> {
    const entry = this.#entries.get(serverId);
    if (entry === undefined) throw new UnknownServer(serverId);

    // `formatCode` is the shared normaliser: it maps «۱۲۳۴» from a Persian keyboard back to
    // `1234`, strips spaces and hyphens, and upper-cases. Comparing an un-normalised code
    // against what the server minted is a pairing failure that looks like a wrong code.
    const normalised = formatCode(code);

    // The contract says `secret` is *omitted* when pairing by typed code — the long secret
    // exists to make a QR unguessable, and there is no QR here. `runPairing` forwards
    // `payload.secret` straight into the claim body, and an absent property disappears from
    // the JSON while an empty string does not. `QrPayload` types `secret` as a string because
    // a scanned payload always carries one, so this is the single place the desktop has to
    // widen it; sending `""` instead would put a value on the wire the server never expects.
    const payload = { v: 1, host: entry.record.host, code: normalised } as unknown as QrPayload;

    const session = await entry.client.pair({
      qr: payload,
      deviceName: this.#deviceName,
      platform: 'windows',
      signal,
    });

    entry.paired = true;
    entry.started = true;
    entry.deviceId = session.deviceId;
    entry.lastErrorCode = null;
    entry.client.start();
    this.#registry.noteConnected(serverId, this.#clock.now());
    entry.record.lastConnectedAt = this.#clock.now();
    this.#emit();
    return this.#summarise(entry);
  }

  /** Drop the credential but keep the row, so the user can pair again without retyping a host. */
  async forget(serverId: string): Promise<ServerSummary> {
    const entry = this.#entries.get(serverId);
    if (entry === undefined) throw new UnknownServer(serverId);
    await entry.client.stop();
    await entry.client.session.signOut();
    entry.paired = false;
    entry.started = false;
    entry.deviceId = null;
    entry.connection = 'offline';
    this.#emit();
    return this.#summarise(entry);
  }

  async remove(serverId: string): Promise<void> {
    const entry = this.#entries.get(serverId);
    if (entry !== undefined) {
      await entry.client.stop();
      await entry.client.session.signOut();
      for (const off of entry.unsubscribe) off();
      this.#entries.delete(serverId);
    }
    this.#registry.remove(serverId);
    this.#emit();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => entry.client.stop()));
  }

  #ensure(record: ServerRecord): Entry {
    const existing = this.#entries.get(record.id);
    if (existing !== undefined) {
      existing.record = record;
      return existing;
    }

    const client = createClient({
      transport: this.#transport,
      // The per-server store. Nothing else in this process can hand a different one in.
      tokenStore: this.#vault.storeFor(record.id),
      clock: this.#clock,
      baseUrl: baseUrlFor(record.host),
      logger: this.#logger,
    });

    const stored = this.#vault.read(record.id);
    const entry: Entry = {
      record,
      client,
      connection: 'offline',
      started: false,
      paired: stored !== null,
      deviceId: stored?.deviceId ?? null,
      lastErrorCode: null,
      unsubscribe: [],
    };

    entry.unsubscribe.push(
      client.connection.subscribe((state) => {
        entry.connection = state;
        this.#emit();
      }),
      client.session.events.on('signed-out', ({ code }) => {
        // The operator closed this device. The row goes back to «نیاز به جفت‌سازی» rather
        // than sitting on a red dot the user would try to fix by restarting the app.
        entry.paired = false;
        entry.deviceId = null;
        entry.lastErrorCode = code;
        this.#emit();
      }),
      client.session.events.on('session-changed', ({ session }) => {
        entry.paired = session !== null;
        entry.deviceId = session?.deviceId ?? null;
      }),
    );

    this.#entries.set(record.id, entry);
    return entry;
  }

  #summarise(entry: Entry): ServerSummary {
    const connection: ServerSummary['connection'] = entry.started ? entry.connection : 'offline';
    const state: ServerSummary['state'] = !entry.paired
      ? 'needs-pairing'
      : connection === 'offline'
        ? 'offline'
        : 'paired';

    return {
      id: entry.record.id,
      label: entry.record.label,
      host: entry.record.host,
      baseUrl: baseUrlFor(entry.record.host),
      state,
      connection,
      deviceId: entry.deviceId,
      addedAt: entry.record.addedAt,
      lastConnectedAt: entry.record.lastConnectedAt,
      lastErrorCode: entry.lastErrorCode,
    };
  }

  #emit(): void {
    const snapshot = this.summaries();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export class UnknownServer extends Error {
  constructor(readonly serverId: string) {
    super(`no server is registered under «${serverId}»`);
    this.name = 'UnknownServer';
  }
}
