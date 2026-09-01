import { ApiException, ErrorCode, FUNNEL_PEER } from '@localcast/contract';

/**
 * Rate limiting for pairing, which is the only unauthenticated write in the system.
 *
 * There is deliberately no per-IP layer. Behind Funnel every request arrives from a
 * Tailscale relay, so a per-IP bucket would either limit thousands of unrelated users
 * together or, if generous enough not to, limit nothing at all. Spec section 4.3 replaces it
 * with three layers:
 *
 *  1. a global bucket, which bounds the whole attack regardless of source;
 *  2. a per-code bucket with exponential backoff, so guessing one code gets slower fast;
 *  3. a per-peer bucket keyed on the identity `netedge` injects. In tailnet mode that
 *     identity is unforgeable and each peer gets its own allowance. In Funnel mode the
 *     header is the literal string `funnel` — every anonymous caller therefore shares ONE
 *     strict bucket, because giving `funnel` a per-key allowance would hand an attacker the
 *     generous limit meant for a known device.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitOptions {
  /** Requests per window across every caller. */
  globalCapacity: number;
  globalWindowMs: number;
  /** Allowance for one identified tailnet peer. */
  peerCapacity: number;
  peerWindowMs: number;
  /** Shared allowance for everything arriving without an identity. Deliberately small. */
  anonCapacity: number;
  anonWindowMs: number;
  /** Attempts against a single pairing code before backoff starts biting. */
  codeCapacity: number;
  codeWindowMs: number;
  /** First penalty after a failed claim; doubles per consecutive failure. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Keys idle longer than this are dropped so the maps cannot grow without bound. */
  idleEvictMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitOptions = {
  globalCapacity: 30,
  globalWindowMs: 60_000,
  peerCapacity: 20,
  peerWindowMs: 60_000,
  anonCapacity: 10,
  anonWindowMs: 60_000,
  codeCapacity: 5,
  codeWindowMs: 60_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 15 * 60_000,
  idleEvictMs: 30 * 60_000,
};

interface CodeState extends Bucket {
  failures: number;
  blockedUntil: number;
}

export class RateLimiter {
  private readonly opts: RateLimitOptions;
  private global: Bucket;
  private readonly peers = new Map<string, Bucket>();
  private readonly anon: Bucket;
  private readonly codes = new Map<string, CodeState>();

  constructor(
    options: Partial<RateLimitOptions> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.opts = { ...DEFAULT_RATE_LIMITS, ...options };
    this.global = { tokens: this.opts.globalCapacity, updatedAt: this.now() };
    this.anon = { tokens: this.opts.anonCapacity, updatedAt: this.now() };
  }

  private take(bucket: Bucket, capacity: number, windowMs: number): number {
    const t = this.now();
    const refill = ((t - bucket.updatedAt) / windowMs) * capacity;
    bucket.tokens = Math.min(capacity, bucket.tokens + refill);
    bucket.updatedAt = t;
    if (bucket.tokens < 1) {
      // How long until one whole token exists again.
      return Math.ceil(((1 - bucket.tokens) / capacity) * windowMs);
    }
    bucket.tokens -= 1;
    return 0;
  }

  private static deny(retryAfterMs: number, message: string): never {
    throw new ApiException(ErrorCode.RATE_LIMITED, message, { retryAfterMs });
  }

  checkGlobal(): void {
    const wait = this.take(this.global, this.opts.globalCapacity, this.opts.globalWindowMs);
    if (wait > 0) RateLimiter.deny(wait, 'Too many pairing attempts; try again shortly');
  }

  checkPeer(peer: string | undefined): void {
    const identified = typeof peer === 'string' && peer.length > 0 && peer !== FUNNEL_PEER;
    if (!identified) {
      const wait = this.take(this.anon, this.opts.anonCapacity, this.opts.anonWindowMs);
      if (wait > 0) RateLimiter.deny(wait, 'Too many pairing attempts; try again shortly');
      return;
    }
    this.evictIdle(this.peers, this.opts.peerWindowMs);
    let bucket = this.peers.get(peer);
    if (!bucket) {
      bucket = { tokens: this.opts.peerCapacity, updatedAt: this.now() };
      this.peers.set(peer, bucket);
    }
    const wait = this.take(bucket, this.opts.peerCapacity, this.opts.peerWindowMs);
    if (wait > 0) RateLimiter.deny(wait, 'Too many pairing attempts from this device');
  }

  checkCode(code: string): void {
    const key = code.toUpperCase();
    this.evictIdle(this.codes, this.opts.codeWindowMs);
    let state = this.codes.get(key);
    if (!state) {
      state = {
        tokens: this.opts.codeCapacity,
        updatedAt: this.now(),
        failures: 0,
        blockedUntil: 0,
      };
      this.codes.set(key, state);
    }
    const t = this.now();
    if (state.blockedUntil > t) {
      RateLimiter.deny(state.blockedUntil - t, 'Too many attempts against this code');
    }
    const wait = this.take(state, this.opts.codeCapacity, this.opts.codeWindowMs);
    if (wait > 0) RateLimiter.deny(wait, 'Too many attempts against this code');
  }

  /** Called after a claim fails. Consecutive failures double the wait. */
  penaliseCode(code: string): void {
    const key = code.toUpperCase();
    const state = this.codes.get(key);
    if (!state) return;
    state.failures += 1;
    const penalty = Math.min(
      this.opts.backoffMaxMs,
      this.opts.backoffBaseMs * 2 ** (state.failures - 1),
    );
    state.blockedUntil = this.now() + penalty;
    state.updatedAt = this.now();
  }

  /** Called after a claim succeeds, so a code that worked leaves no penalty behind. */
  clearCode(code: string): void {
    this.codes.delete(code.toUpperCase());
  }

  private evictIdle(map: Map<string, Bucket>, windowMs: number): void {
    if (map.size < 512) return;
    const cutoff = this.now() - Math.max(this.opts.idleEvictMs, windowMs);
    for (const [key, bucket] of map) {
      if (bucket.updatedAt < cutoff) map.delete(key);
    }
  }

  /** Test seam; production never resets a limiter mid-life. */
  reset(): void {
    this.global = { tokens: this.opts.globalCapacity, updatedAt: this.now() };
    this.anon.tokens = this.opts.anonCapacity;
    this.anon.updatedAt = this.now();
    this.peers.clear();
    this.codes.clear();
  }
}
