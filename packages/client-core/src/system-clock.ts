import type { Clock } from './ports.js';

/**
 * The obvious `Clock`. Separate from `ports.ts` so a test never has to reach past a fake to
 * find it, and so the token lifecycle can be driven at any speed a test likes.
 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export const systemClock: Clock = new SystemClock();
