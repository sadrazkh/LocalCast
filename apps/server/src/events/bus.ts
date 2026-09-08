import type { ServerEvent } from '@localcast/contract';
import type { EventBus } from '../kernel.js';

export interface StoredEvent {
  id: number;
  event: ServerEvent;
}

/**
 * Decides whether a device is allowed to see an event. The bus has no database, so this is
 * supplied by the composition root — a print job belongs to one device and must not surface
 * in another device's stream just because both are subscribed.
 */
export type EventVisibility = (event: ServerEvent, deviceId: string) => boolean;

export interface EventBusOptions {
  /**
   * How many events to keep for `Last-Event-ID` replay. SSE reconnects after a tunnel blip
   * measured in seconds; a few hundred events covers that without becoming a log.
   */
  bufferSize?: number;
  visibility?: EventVisibility;
}

export class InMemoryEventBus implements EventBus {
  private nextId = 1;
  private readonly buffer: StoredEvent[] = [];
  private readonly bufferSize: number;
  private readonly visibility: EventVisibility;
  private readonly subscribers = new Map<
    number,
    { deviceId: string; handler: (id: number, event: ServerEvent) => void }
  >();
  private nextSubscriberId = 1;
  /** In-process listeners that see every event. See `observe`. */
  private readonly observers = new Set<(event: ServerEvent) => void>();

  constructor(opts: EventBusOptions = {}) {
    this.bufferSize = opts.bufferSize ?? 256;
    this.visibility = opts.visibility ?? (() => true);
  }

  publish(event: ServerEvent): void {
    const id = this.nextId++;
    // Heartbeats are generated per connection and would otherwise flood the replay buffer
    // with entries nobody can act on.
    if (event.type !== 'heartbeat') {
      this.buffer.push({ id, event });
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }

    for (const sub of this.subscribers.values()) {
      if (!this.visibility(event, sub.deviceId)) continue;
      try {
        sub.handler(id, event);
      } catch {
        // One broken SSE connection must not stop the others from being notified.
      }
    }

    for (const observer of this.observers) {
      try {
        observer(event);
      } catch {
        // Same rule: an observer that throws is its own problem.
      }
    }
  }

  /**
   * Every event, with no visibility filter. For the operator side of the app, in-process.
   *
   * The device subscriptions above are deliberately filtered — a print job belongs to one device
   * and must not appear in another's stream. The operator is the opposite case: the whole point of
   * `{ type: 'device', status: 'pending' }` is that the person at the Windows machine has to see
   * it, and that person is not a device and holds no device token.
   *
   * It is not reachable over HTTP and there is no route that exposes it. The only caller is the
   * Electron main process, which hosts this server inside itself, so an unfiltered stream never
   * crosses a process boundary let alone a network one.
   */
  observe(handler: (event: ServerEvent) => void): () => void {
    this.observers.add(handler);
    return () => {
      this.observers.delete(handler);
    };
  }

  subscribe(deviceId: string, handler: (event: ServerEvent) => void): () => void {
    return this.subscribeWithId(deviceId, (_id, event) => handler(event));
  }

  /**
   * The SSE handler needs the bus's own sequence number, not a per-connection counter — the
   * id it writes is what the browser sends back as `Last-Event-ID`, so the two have to be
   * the same numbering or a reconnect replays the wrong window.
   */
  subscribeWithId(
    deviceId: string,
    handler: (id: number, event: ServerEvent) => void,
  ): () => void {
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, { deviceId, handler });
    return () => {
      this.subscribers.delete(id);
    };
  }

  /** Events newer than `afterId` this device may see. Backs `Last-Event-ID`. */
  replay(deviceId: string, afterId: number): StoredEvent[] {
    return this.buffer.filter((e) => e.id > afterId && this.visibility(e.event, deviceId));
  }

  /** The id a fresh subscriber should treat as its starting point. */
  currentId(): number {
    return this.nextId - 1;
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  dispose(): void {
    this.subscribers.clear();
    this.observers.clear();
    this.buffer.length = 0;
  }
}
