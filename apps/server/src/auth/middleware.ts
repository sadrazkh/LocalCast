import {
  ApiException,
  EDGE_PEER_HEADER,
  EDGE_SECRET_HEADER,
  ErrorCode,
  FUNNEL_PEER,
} from '@localcast/contract';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthenticatedRequest, DeviceIdentity } from '../kernel.js';
import { secureEquals } from './passwords.js';
import type { TokenService } from './tokens.js';

declare module 'express-serve-static-core' {
  interface Request {
    device?: DeviceIdentity;
    peer?: string;
    /**
     * Set by the HTTPS listener that faces the local network, before Express sees the request.
     * A client cannot forge it: it is a property on the request object, not a header.
     */
    viaLan?: boolean;
    /**
     * Set by the opt-in **unencrypted** local-network listener, in addition to `viaLan`.
     *
     * Anything that wants to know whether this particular request crossed the Wi-Fi in the
     * clear reads this rather than guessing from a header or from `req.secure`, both of which
     * describe a proxy's opinion instead of our own socket.
     */
    viaPlaintext?: boolean;
  }
}

/**
 * First gate on every request. `netedge` terminates TLS on the tailnet and adds this header;
 * nothing else on the machine knows it. Without this, any local process — a browser tab, a
 * bit of malware — could reach the whole API by pointing at 127.0.0.1.
 */
export function edgeSecretGuard(secret: string, options: { lanAllowed?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    const presented = req.header(EDGE_SECRET_HEADER);
    if (secureEquals(presented, secret)) {
      next();
      return;
    }
    /**
     * Local-network mode: the secret only ever existed to stop another process on this
     * machine reaching the API by guessing a loopback port, back when `netedge` was the only
     * way in. Once the operator has deliberately shared over the LAN there is no edge to
     * inject it, and a phone on the same Wi-Fi cannot be asked to know it.
     *
     * The bypass is limited to requests that arrived on the LAN listener, not to every request
     * while LAN sharing happens to be on. That is the whole reason the two listeners are
     * separate objects: loopback keeps demanding the secret, so the original property — no
     * other process on this machine can reach the API by guessing the port — survives
     * switching local sharing on.
     *
     * Nothing else is given away. Every route below still demands a device token, and the
     * operator API — the surface that grants access — is mounted behind its own loopback
     * check, which this flag does not touch.
     */
    if (options.lanAllowed && req.viaLan === true) {
      next();
      return;
    }
    next(new ApiException(ErrorCode.UNAUTHENTICATED, 'Missing or invalid edge credentials'));
  };
}

/**
 * The peer identity the edge injects. In tailnet mode it is the WireGuard peer and cannot be
 * forged by the client; in Funnel mode there is no identity and the edge writes `funnel`.
 * A client-supplied header can only ever make itself look anonymous, never look like someone
 * else, because the edge overwrites it.
 */
export function peerContext(): RequestHandler {
  return (req, _res, next) => {
    const raw = req.header(EDGE_PEER_HEADER);
    req.peer = raw && raw.trim().length > 0 ? raw.trim() : FUNNEL_PEER;
    next();
  };
}

export function bearerAuth(tokens: TokenService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization');
    if (!header || !/^Bearer\s+/i.test(header)) {
      next(new ApiException(ErrorCode.UNAUTHENTICATED, 'Bearer token required'));
      return;
    }
    const token = header.replace(/^Bearer\s+/i, '').trim();

    tokens
      .verifyAccessToken(token)
      .then((device) => {
        req.device = device;
        const peer = req.peer ?? FUNNEL_PEER;
        req.peer = peer;
        tokens.touch(device.id, peer);
        next();
      })
      .catch(next);
  };
}

/** Narrowing helper for handlers mounted behind `bearerAuth`. */
export function authed(req: Request): AuthenticatedRequest {
  if (!req.device) {
    throw new ApiException(ErrorCode.UNAUTHENTICATED, 'Bearer token required');
  }
  return req as AuthenticatedRequest;
}

const LOOPBACK_V4 = /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '::ffff:127.0.0.1' || LOOPBACK_V4.test(address);
}

/**
 * The operator API can grant privilege, so it is not reachable over the tailnet at all — a
 * stolen device token cannot escalate through an endpoint that never answers it. The check
 * is on the socket's real peer address, not `X-Forwarded-For`, which a client controls.
 *
 * Mounted alongside the edge-secret guard, never instead of it: loopback alone would admit
 * any other process on the machine.
 *
 * The address is necessary but not sufficient, because the local-network listeners bind
 * `0.0.0.0` and that includes `127.0.0.1`. A process on this machine — or any web page in any
 * browser on it, which needs no permission to *send* a cross-origin POST — could otherwise
 * reach `https://127.0.0.1:<lanPort>/operator/folders`, where the edge secret is waived
 * because the request arrived on the LAN listener and the loopback test passes because the
 * address really is loopback. Two guards, each correct on its own, adding up to no guard at
 * all. So the operator API refuses anything that came in on a listener facing the network,
 * whatever address it appears to come from.
 */
export function loopbackOnly(): RequestHandler {
  return (req, _res, next) => {
    if (req.viaLan === true || !isLoopbackAddress(req.socket.remoteAddress)) {
      next(new ApiException(ErrorCode.NOT_FOUND, 'Not found'));
      return;
    }
    next();
  };
}
