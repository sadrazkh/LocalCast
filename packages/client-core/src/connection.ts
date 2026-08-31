import type { EdgeState } from '@localcast/contract';
import { Emitter } from './emitter.js';
import type { Unsubscribe } from './emitter.js';
import type { Clock } from './ports.js';

/**
 * Exactly three values. Nothing more is ever exposed from this module.
 *
 * The spec is explicit that the connection indicator is a coloured dot and a word. Relay
 * names, DERP regions, tailnet IPs and certificate state are all real things happening
 * underneath, and none of them belong in a UI whose user is trying to watch a film. Anything
 * that leaks transport detail out of here is a design error, not a feature.
 */
export type ConnectionState = 'connected' | 'connecting' | 'offline';

export interface ConnectionEvents {
  /** The payload is the whole public surface: one word. */
  change: { state: ConnectionState };
}

export interface ConnectionMonitorOptions {
  clock: Clock;
  /**
   * Consecutive failures before the dot goes red. Three, not one: a single dropped request
   * on cellular is ordinary, and a dot that flickers red every time a request is unlucky
   * trains the user to ignore it — which is exactly when it matters.
   */
  failureThreshold?: number;
  /** …or this long with nothing succeeding, whichever comes first. */
  failureWindowMs?: number;
}

/**
 * What the server's own edge state means for a client looking at the dot. The server sends
 * these over SSE; they are coarse by construction (see `edgeStateSchema`).
 */
const EDGE_TO_STATE: Record<EdgeState, ConnectionState> = {
  connected: 'connected',
  starting: 'connecting',
  connecting: 'connecting',
  'obtaining-certificate': 'connecting',
  // The three below mean the server cannot serve the tailnet at all. Even though this very
  // event reached us, the library is about to become unreachable, so say so rather than
  // showing green until the next request fails.
  stopped: 'offline',
  'error': 'offline',
  'login-required': 'offline',
};

/**
 * The small state machine behind the dot, driven by real request outcomes and by the SSE
 * stream, with hysteresis in one direction only: slow to go red, immediate to go green.
 */
export class ConnectionMonitor {
  readonly events = new Emitter<ConnectionEvents>();

  readonly #clock: Clock;
  readonly #threshold: number;
  readonly #windowMs: number;

  #failures = 0;
  #firstFailureAt: number | null = null;
  #everSucceeded = false;
  #edge: EdgeState | null = null;
  #state: ConnectionState = 'connecting';

  constructor(options: ConnectionMonitorOptions) {
    this.#clock = options.clock;
    this.#threshold = options.failureThreshold ?? 3;
    this.#windowMs = options.failureWindowMs ?? 8_000;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  subscribe(handler: (state: ConnectionState) => void): Unsubscribe {
    return this.events.on('change', ({ state }) => handler(state));
  }

  /** A request came back, or the event stream opened. The server is reachable. */
  noteSuccess(): void {
    this.#failures = 0;
    this.#firstFailureAt = null;
    this.#everSucceeded = true;
    this.#recompute();
  }

  /** A request or a stream attempt did not reach the server. */
  noteFailure(): void {
    this.#failures += 1;
    this.#firstFailureAt ??= this.#clock.now();
    this.#recompute();
  }

  /** A `connection` event from the SSE stream. */
  noteServerState(state: EdgeState): void {
    this.#edge = state;
    this.#recompute();
  }

  /** After signing out or switching servers, forget everything learnt about the old one. */
  reset(): void {
    this.#failures = 0;
    this.#firstFailureAt = null;
    this.#everSucceeded = false;
    this.#edge = null;
    this.#recompute();
  }

  #recompute(): void {
    const next = this.#compute();
    if (next === this.#state) return;
    this.#state = next;
    this.events.emit('change', { state: next });
  }

  #compute(): ConnectionState {
    if (this.#failures > 0) {
      const since = this.#clock.now() - (this.#firstFailureAt ?? this.#clock.now());
      const sustained = this.#failures >= this.#threshold || since >= this.#windowMs;
      // Below the threshold the honest word is "connecting": we are retrying and do not yet
      // know whether this is an outage or one unlucky request.
      return sustained ? 'offline' : 'connecting';
    }
    if (this.#edge !== null) return EDGE_TO_STATE[this.#edge];
    return this.#everSucceeded ? 'connected' : 'connecting';
  }
}
