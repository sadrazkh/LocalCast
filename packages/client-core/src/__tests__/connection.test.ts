import { describe, expect, it } from 'vitest';
import { ConnectionMonitor } from '../connection.js';
import { FakeClock } from './fakes.js';

function monitor(options: { failureThreshold?: number; failureWindowMs?: number } = {}) {
  const clock = new FakeClock();
  return { clock, monitor: new ConnectionMonitor({ clock, ...options }) };
}

describe('connection state machine', () => {
  it('starts as connecting, because nothing is yet known', () => {
    expect(monitor().monitor.state).toBe('connecting');
  });

  it('does not flip to offline on a single failed request', () => {
    const { monitor: m } = monitor();
    m.noteSuccess();
    expect(m.state).toBe('connected');

    m.noteFailure();
    expect(m.state).toBe('connecting');

    m.noteFailure();
    expect(m.state).toBe('connecting');
  });

  it('flips to offline once failure is sustained, and back to connected on recovery', () => {
    const { monitor: m } = monitor();
    m.noteSuccess();
    m.noteFailure();
    m.noteFailure();
    m.noteFailure();
    expect(m.state).toBe('offline');

    m.noteSuccess();
    expect(m.state).toBe('connected');
  });

  it('also gives up once failures have gone on long enough, even below the count', () => {
    const { clock, monitor: m } = monitor({ failureThreshold: 10, failureWindowMs: 8_000 });
    m.noteSuccess();
    m.noteFailure();
    expect(m.state).toBe('connecting');

    clock.advance(9_000);
    m.noteFailure();
    expect(m.state).toBe('offline');
  });

  it('emits a change only when the word actually changes', () => {
    const { monitor: m } = monitor();
    const seen: string[] = [];
    m.subscribe((state) => seen.push(state));

    m.noteSuccess();
    m.noteSuccess();
    m.noteSuccess();
    m.noteFailure();
    m.noteFailure();
    m.noteFailure();
    m.noteSuccess();

    expect(seen).toEqual(['connected', 'connecting', 'offline', 'connected']);
  });

  it('reflects the server edge state without ever naming a transport', () => {
    const { monitor: m } = monitor();
    const payloads: unknown[] = [];
    m.events.on('change', (payload) => payloads.push(payload));

    m.noteSuccess();
    m.noteServerState('obtaining-certificate');
    expect(m.state).toBe('connecting');

    m.noteServerState('login-required');
    expect(m.state).toBe('offline');

    m.noteServerState('connected');
    expect(m.state).toBe('connected');

    // The whole public payload is one word from a closed set. No host, no relay, no DERP.
    for (const payload of payloads) {
      expect(Object.keys(payload as object)).toEqual(['state']);
      expect(['connected', 'connecting', 'offline']).toContain((payload as { state: string }).state);
    }
  });

  it('lets an unreachable server override a stale "connected" edge report', () => {
    const { monitor: m } = monitor();
    m.noteServerState('connected');
    expect(m.state).toBe('connected');

    m.noteFailure();
    m.noteFailure();
    m.noteFailure();
    expect(m.state).toBe('offline');
  });

  it('forgets everything on reset, e.g. after signing out', () => {
    const { monitor: m } = monitor();
    m.noteSuccess();
    m.noteFailure();
    m.noteFailure();
    m.noteFailure();
    expect(m.state).toBe('offline');

    m.reset();
    expect(m.state).toBe('connecting');
  });
});
