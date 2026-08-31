import { CancelledError } from './errors.js';

export interface BackoffOptions {
  baseMs: number;
  factor: number;
  /** Hard ceiling. Without one, a phone left in a lift ends up retrying once an hour. */
  capMs: number;
  /** Fraction of the delay that is randomised, 0…1. */
  jitter: number;
}

/**
 * Reconnecting to the SSE stream. Capped at 30 s: the spec's failure table promises
 * "automatic retry with backoff", and a user who walks back into wifi should not wait
 * minutes for the dot to go green.
 */
export const SSE_BACKOFF: BackoffOptions = { baseMs: 1_000, factor: 2, capMs: 30_000, jitter: 0.5 };

/**
 * Polling `pair/status` while the operator decides. A much tighter cap than the SSE one: the
 * operator taps "approve" on the panel and is looking at the phone, so a 30 s gap before the
 * phone notices would read as a broken pairing.
 */
export const PAIRING_POLL_BACKOFF: BackoffOptions = {
  baseMs: 800,
  factor: 1.5,
  capMs: 5_000,
  jitter: 0.3,
};

/**
 * Exponential backoff with jitter, bounded by `capMs`.
 *
 * Jitter matters here specifically: after the Windows machine sleeps and wakes, every paired
 * device reconnects at once. Without it they retry in lockstep for ever.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = SSE_BACKOFF,
  random: () => number = Math.random,
): number {
  const raw = Math.min(options.capMs, options.baseMs * Math.pow(options.factor, Math.max(0, attempt)));
  const floor = raw * (1 - options.jitter);
  return Math.round(floor + random() * (raw - floor));
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Default sleep. `setTimeout` is the one timing primitive every JS platform agrees on. */
export const systemSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CancelledError('sleep'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError('sleep'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
