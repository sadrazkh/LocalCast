import type { Logger } from './ports.js';

export type Unsubscribe = () => void;

type AnyHandler = (payload: never) => void;

/**
 * A ~40-line typed emitter rather than a dependency.
 *
 * `EventTarget` exists on the web and on Node, but not everywhere this package is meant to
 * run, and it loses the payload type. The event maps here are derived from the contract's
 * discriminated unions, so `on('print-job', j => j.job.status)` type-checks.
 */
// `Record<keyof M, unknown>` rather than `Record<string, unknown>`: an `interface` has no
// implicit index signature, and every event map in this package is written as one.
export class Emitter<M extends Record<keyof M, unknown>> {
  readonly #handlers = new Map<keyof M, Set<AnyHandler>>();
  readonly #logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.#logger = logger;
  }

  on<K extends keyof M>(type: K, handler: (payload: M[K]) => void): Unsubscribe {
    let set = this.#handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    const bucket = set;
    bucket.add(handler as AnyHandler);
    return () => {
      bucket.delete(handler as AnyHandler);
    };
  }

  once<K extends keyof M>(type: K, handler: (payload: M[K]) => void): Unsubscribe {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.#handlers.get(type);
    if (set === undefined) return;
    // Copy first: a handler unsubscribing itself is normal and must not mutate the live set
    // we are iterating.
    for (const handler of [...set]) {
      try {
        (handler as (payload: M[K]) => void)(payload);
      } catch (error) {
        // One broken listener must not stop the others, and must not surface as a rejected
        // network call three layers up — but it is never swallowed silently either.
        this.#logger?.log('error', 'event listener threw', { type: String(type), error });
      }
    }
  }

  clear(): void {
    this.#handlers.clear();
  }
}
