import { Router } from 'express';
import { SSE_HEARTBEAT_MS, type ServerEvent } from '@localcast/contract';
import { authed, bearerAuth } from '../../auth/middleware.js';
import type { TokenService } from '../../auth/tokens.js';
import type { InMemoryEventBus } from '../../events/bus.js';
import type { Logger } from '../../kernel.js';

/**
 * `GET /api/v1/events`.
 *
 * SSE rather than WebSocket: every message here travels server→client only, the browser
 * reconnects on its own with `Last-Event-ID`, and it crosses the tsnet and Funnel proxy
 * paths without an upgrade handshake to negotiate.
 */

export interface EventsRouterDeps {
  bus: InMemoryEventBus;
  tokens: TokenService;
  log: Logger;
  /** Test seam: shortens the heartbeat so a test does not have to wait 20 s. */
  heartbeatMs?: number;
}

export interface EventsRouter {
  router: Router;
  /** Ends every open stream. Without this a running server never finishes closing. */
  dispose(): void;
}

export function createEventsRouter(deps: EventsRouterDeps): EventsRouter {
  const router = Router();
  const open = new Set<() => void>();
  const heartbeatMs = deps.heartbeatMs ?? SSE_HEARTBEAT_MS;

  // Auth is attached to this one route rather than to the mount point: the same `/api/v1`
  // prefix also carries the unauthenticated pairing routes, and a `use`-level guard here
  // would lock those out.
  router.get('/events', bearerAuth(deps.tokens), (req, res) => {
    const { device } = authed(req);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Tells any buffering proxy in the path — including the edge — not to hold the stream.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // How long the client should wait before reconnecting after a drop.
    res.write(`retry: 3000\n\n`);

    const send = (id: number, event: ServerEvent): void => {
      if (res.writableEnded) return;
      res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const lastEventId = parseLastEventId(
      req.header('last-event-id') ?? (typeof req.query['lastEventId'] === 'string' ? req.query['lastEventId'] : undefined),
    );

    // A reconnect after a tunnel blip replays what it missed instead of silently losing a
    // print job's completion.
    if (lastEventId !== null) {
      for (const stored of deps.bus.replay(device.id, lastEventId)) {
        send(stored.id, stored.event);
      }
    }

    let lastSentId = deps.bus.currentId();
    const unsubscribe = deps.bus.subscribeWithId(device.id, (id, event) => {
      lastSentId = id;
      send(id, event);
    });

    const heartbeat = setInterval(() => {
      // A real typed event rather than a comment: intermediaries close idle streams, and the
      // client's own "am I still connected" logic gets to use the same code path as anything
      // else on the wire. It carries the last real event id so a reconnect after a quiet
      // period does not replay everything that was already delivered.
      send(lastSentId, { type: 'heartbeat', at: Date.now() });
    }, heartbeatMs);
    // The timer must never be the reason the process stays alive.
    heartbeat.unref?.();

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(close);
      if (!res.writableEnded) res.end();
    };

    open.add(close);
    res.on('close', close);
    res.on('error', close);
  });

  return {
    router,
    dispose(): void {
      for (const close of [...open]) close();
    },
  };
}

function parseLastEventId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
