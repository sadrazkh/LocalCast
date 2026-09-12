/**
 * Keys seen within a window, for "once per minute" rules.
 *
 * Both range-serving paths need the same thing: a player scrubbing a film sends dozens of
 * requests a second, and anything done *per request* that should be done *per playback* — an
 * activity row, a log line — has to be gated on "have I seen this device and this file lately".
 * Bounded: an entry expires on its next lookup after the window, and the map is swept whenever it
 * grows past a few thousand, so a long session cannot grow it without limit.
 */
export class RecentKeys {
  readonly #seen = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /** True the first time a key is seen within the window; false while it is still fresh. */
  note(key: string, now = Date.now()): boolean {
    const last = this.#seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.#seen.set(key, now);
    if (this.#seen.size > 4096) {
      for (const [k, at] of this.#seen) if (now - at >= this.windowMs) this.#seen.delete(k);
    }
    return true;
  }
}
