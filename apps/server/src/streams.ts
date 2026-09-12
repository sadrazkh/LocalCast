import type { Readable, Writable } from 'node:stream';

/**
 * What is being played right now, how fast, and what it is waiting on.
 *
 * ## Why
 *
 * "Heavy files stutter, light ones are fine" has three possible causes and the panel could name
 * none of them: the Wi-Fi cannot carry the bitrate, the drive the file is on cannot supply it, or
 * this process is too busy to move it. Each calls for a different thing from the user — a closer
 * access point, a different drive, waiting for indexing to finish — and until now the only readout
 * was «پخش‌های در جریان: —», with a footer admitting it was not measured.
 *
 * ## How
 *
 * Every range response is registered here with the read stream feeding it. Two things are
 * sampled on every chunk that comes off the disk: how many bytes, and whether the socket had
 * still not drained the previous chunk. A socket that is usually still full when the next chunk
 * arrives means the network is the bottleneck — the disk is ahead of the wire. A socket that is
 * usually empty means the wire is waiting on the disk, or on this process. The ratio is the
 * verdict; the byte count over the last few seconds is the rate.
 *
 * In memory, never persisted: a stream that ended is not a fact anyone needs tomorrow.
 */

export interface StreamInfo {
  id: number;
  deviceId: string | null;
  /** The file's name, for the panel. Never the absolute path. */
  name: string;
  startedAt: number;
  /** Bytes delivered so far. */
  bytes: number;
  /** Megabits per second over the last few seconds. */
  mbps: number;
  /**
   * How often the socket was still full when the next chunk arrived, 0–1. Above about 0.5 the
   * network is what is slow; well below it, the disk or this process is.
   */
  networkWaitRatio: number;
  /** The plain-language verdict the two numbers add up to. */
  bottleneck: 'network' | 'source' | 'none';
}

interface Entry {
  info: Omit<StreamInfo, 'mbps' | 'networkWaitRatio' | 'bottleneck'>;
  samples: number;
  blocked: number;
  /** (time, cumulative bytes) points over the recent window, oldest first. */
  window: { at: number; bytes: number }[];
}

/** Sockets on which `writableNeedDrain` is meaningful. Express's `Response` is one. */
type Sink = Pick<Writable, 'writableNeedDrain' | 'once'>;

const WINDOW_MS = 4_000;

export class StreamMonitor {
  #nextId = 1;
  readonly #active = new Map<number, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Watch one response until it closes. Returns the stream's id, which the caller does not
   * usually need — the point is the side effect.
   */
  track(sink: Sink, source: Readable, meta: { deviceId: string | null; name: string }): number {
    const id = this.#nextId++;
    const entry: Entry = {
      info: { id, deviceId: meta.deviceId, name: meta.name, startedAt: this.now(), bytes: 0 },
      samples: 0,
      blocked: 0,
      window: [],
    };
    this.#active.set(id, entry);

    const onData = (chunk: Buffer | string): void => {
      const length = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      entry.info.bytes += length;
      entry.samples += 1;
      if (sink.writableNeedDrain) entry.blocked += 1;
      const at = this.now();
      entry.window.push({ at, bytes: entry.info.bytes });
      while (entry.window.length > 1 && at - (entry.window[0]?.at ?? at) > WINDOW_MS) entry.window.shift();
    };
    source.on('data', onData);

    const done = (): void => {
      source.off('data', onData);
      this.#active.delete(id);
    };
    sink.once('close', done);
    source.once('close', done);
    return id;
  }

  /** How many responses are streaming right now. The indexer waits while this is non-zero. */
  count(): number {
    return this.#active.size;
  }

  list(): StreamInfo[] {
    return [...this.#active.values()].map((entry) => this.#describe(entry));
  }

  #describe(entry: Entry): StreamInfo {
    const first = entry.window[0];
    const last = entry.window[entry.window.length - 1];
    const spanMs = first && last ? last.at - first.at : 0;
    const mbps = first && last && spanMs > 0 ? ((last.bytes - first.bytes) * 8) / spanMs / 1000 : 0;
    const networkWaitRatio = entry.samples === 0 ? 0 : entry.blocked / entry.samples;
    const bottleneck: StreamInfo['bottleneck'] =
      entry.samples < 8 ? 'none' : networkWaitRatio >= 0.5 ? 'network' : 'source';
    return {
      ...entry.info,
      mbps: Math.round(mbps * 10) / 10,
      networkWaitRatio: Math.round(networkWaitRatio * 100) / 100,
      bottleneck,
    };
  }
}
