import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@localcast/contract';
import { SSE_BACKOFF } from '../backoff.js';
import { EventClient, TransportSseChannel } from '../events.js';
import type { SseChannel, SseOpenRequest } from '../events.js';
import type { HttpTransport, TransportRequest } from '../ports.js';
import { BASE_URL } from './fakes.js';

/** A channel driven by a script, recording the headers each attempt was opened with. */
class ScriptedChannel implements SseChannel {
  readonly headers: Array<Record<string, string>> = [];
  readonly urls: string[] = [];

  constructor(private readonly step: (request: SseOpenRequest, attempt: number) => Promise<void>) {}

  async open(request: SseOpenRequest): Promise<void> {
    const attempt = this.headers.length;
    this.headers.push({ ...request.headers });
    this.urls.push(request.url);
    return this.step(request, attempt);
  }
}

function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

function frame(data: unknown, id?: string) {
  return { id: id ?? null, event: null, data: JSON.stringify(data) };
}

describe('SSE client', () => {
  it('backs off exponentially, stays under the 30 s cap and never goes backwards', async () => {
    const channel = new ScriptedChannel(async () => {
      // Never accepted: the server is down, so the ladder must climb and then flatten.
      throw new Error('connection refused');
    });
    const { delays, sleep } = recordingSleep();

    const client = new EventClient({
      channel,
      baseUrl: BASE_URL,
      sleep,
      random: () => 1, // full jitter, i.e. the top of each band — the worst case for the cap
      maxAttempts: 12,
    });
    await client.start();

    expect(delays).toHaveLength(12);
    expect(Math.max(...delays)).toBeLessThanOrEqual(SSE_BACKOFF.capMs);
    expect(delays.slice(0, 5)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] as number);
    }
    // And the tail is pinned at the cap rather than growing without limit.
    expect(delays.slice(4).every((d) => d === SSE_BACKOFF.capMs)).toBe(true);
  });

  it('jitters: the same attempt produces different delays for different clients', async () => {
    const build = (random: () => number) => {
      const { delays, sleep } = recordingSleep();
      const channel = new ScriptedChannel(async () => {
        throw new Error('down');
      });
      return { delays, client: new EventClient({ channel, baseUrl: BASE_URL, sleep, random, maxAttempts: 3 }) };
    };
    const low = build(() => 0);
    const high = build(() => 1);
    await low.client.start();
    await high.client.start();

    expect(low.delays[0]).toBe(1_000); // the bottom of the band for attempt 1
    expect(high.delays[0]).toBe(2_000);
    expect(low.delays.every((d, i) => d < (high.delays[i] as number))).toBe(true);
  });

  it('honours Last-Event-ID on every reconnect after an event has been seen', async () => {
    const channel = new ScriptedChannel(async (request, attempt) => {
      request.onOpen?.();
      if (attempt === 0) {
        request.onFrame(frame({ type: 'heartbeat', at: 1 }, '41'));
        request.onFrame(frame({ type: 'heartbeat', at: 2 }, '42'));
      }
      // Stream ends; the client must resume from where it stopped.
    });
    const { sleep } = recordingSleep();
    const client = new EventClient({ channel, baseUrl: BASE_URL, sleep, random: () => 0.5, maxAttempts: 3 });

    await client.start();

    expect(channel.headers[0]?.['last-event-id']).toBeUndefined();
    expect(channel.headers[1]?.['last-event-id']).toBe('42');
    expect(channel.headers[2]?.['last-event-id']).toBe('42');
    expect(client.lastEventId).toBe('42');
    expect(channel.urls[0]).toBe(`${BASE_URL}/api/v1/events`);
  });

  it('resets the ladder once a connection has actually produced a frame', async () => {
    const channel = new ScriptedChannel(async (request, attempt) => {
      if (attempt === 0 || attempt === 1) throw new Error('refused');
      if (attempt === 2) request.onFrame(frame({ type: 'heartbeat', at: 1 }, '7'));
      // attempt 3 fails again, and must start from the bottom of the ladder.
      if (attempt === 3) throw new Error('refused');
    });
    const { delays, sleep } = recordingSleep();
    const client = new EventClient({ channel, baseUrl: BASE_URL, sleep, random: () => 1, maxAttempts: 4 });

    await client.start();

    // Two failures climb the ladder; the frame on the third attempt drops it back to the
    // bottom rung, so the fourth failure waits 1 s rather than 8 s.
    expect(delays).toEqual([2_000, 4_000, 1_000, 2_000]);
  });

  it('attaches the bearer produced by `authorize` to each attempt', async () => {
    let calls = 0;
    const channel = new ScriptedChannel(async () => {
      throw new Error('down');
    });
    const { sleep } = recordingSleep();
    const client = new EventClient({
      channel,
      baseUrl: BASE_URL,
      sleep,
      maxAttempts: 2,
      authorize: async () => ({ authorization: `Bearer token-${(calls += 1)}` }),
    });
    await client.start();

    expect(channel.headers[0]?.['authorization']).toBe('Bearer token-1');
    expect(channel.headers[1]?.['authorization']).toBe('Bearer token-2');
  });

  it('delivers typed events and reports an unrecognised frame as drift without dying', async () => {
    const seen: ServerEvent[] = [];
    const drifts: string[] = [];
    const channel = new ScriptedChannel(async (request, attempt) => {
      if (attempt > 0) return;
      request.onFrame(frame({ type: 'not-a-thing', nope: true }, '1'));
      request.onFrame({ id: '2', event: null, data: 'this is not json' });
      request.onFrame(
        frame(
          {
            type: 'print-job',
            job: {
              id: 'j1',
              fileName: 'a.pdf',
              printerName: 'HP',
              status: 'printing',
              copies: 1,
              color: 'mono',
              errorMessage: null,
              createdAt: 1,
              finishedAt: null,
            },
          },
          '3',
        ),
      );
    });
    const { sleep } = recordingSleep();
    const client = new EventClient({ channel, baseUrl: BASE_URL, sleep, maxAttempts: 1 });
    client.on('print-job', (event) => seen.push(event));
    client.lifecycle.on('drift', ({ error }) => drifts.push(error.message));

    await client.start();

    expect(drifts).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'print-job', job: { id: 'j1', status: 'printing' } });
    // The resume point advanced past the bad frames too, so they are not replayed for ever.
    expect(client.lastEventId).toBe('3');
  });

  it('stops on request and does not reconnect', async () => {
    let opens = 0;
    let signalOpened: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      signalOpened = resolve;
    });
    const channel = new ScriptedChannel(async (request) => {
      opens += 1;
      signalOpened();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const client = new EventClient({ channel, baseUrl: BASE_URL, sleep: async () => {} });
    const running = client.start();
    await opened;
    await client.stop();
    await running;

    expect(opens).toBe(1);
    expect(client.running).toBe(false);
  });
});

describe('TransportSseChannel', () => {
  it('decodes frames split across network reads', async () => {
    const chunks = [
      'id: 10\ndata: {"type":"heart',
      'beat","at":1}\n\n:keep-alive\n\nid: 11\nda',
      'ta: {"type":"heartbeat","at":2}\n\n',
    ];
    const transport: HttpTransport = {
      async request() {
        throw new Error('not used');
      },
      async stream(_request: TransportRequest) {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
      },
    };

    const frames: Array<{ id: string | null; data: string }> = [];
    await new TransportSseChannel(transport).open({
      url: `${BASE_URL}/api/v1/events`,
      headers: {},
      signal: new AbortController().signal,
      onFrame: (f) => frames.push({ id: f.id, data: f.data }),
    });

    expect(frames).toEqual([
      { id: '10', data: '{"type":"heartbeat","at":1}' },
      { id: '11', data: '{"type":"heartbeat","at":2}' },
    ]);
  });
});
