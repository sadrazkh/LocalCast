import http from 'node:http';
import type { Logger } from '../kernel.js';

/**
 * The unencrypted local-network listener: a last resort, off by default, and named for what
 * it is.
 *
 * ## Why this is not the answer to the offline library
 *
 * It would be easy to read this listener as the fallback for a browser that refuses to
 * register a service worker on a self-signed origin. It is not, and it cannot be. A service
 * worker requires a **secure context**, and a plain `http://192.168.1.50:8081` origin is not
 * one on any browser — the only HTTP origins browsers treat as trustworthy are `localhost` and
 * `127.0.0.1`, and a phone is neither. So this listener does not restore the offline library;
 * it guarantees its absence. The camera goes the same way: `navigator.mediaDevices` is not
 * even exposed outside a secure context.
 *
 * Which means the honest comparison is: HTTPS with an accepted warning gets *at worst* the
 * camera and encryption and *at best* the offline library too, while plain HTTP gets neither
 * and encrypts nothing. Plain HTTP is strictly worse on the axis it was proposed to repair.
 *
 * ## So why does it exist
 *
 * For the one case HTTPS genuinely cannot serve: a device that cannot get **past the
 * interstitial at all**. Some embedded webviews render a certificate error with no "proceed"
 * affordance, some TV and kiosk browsers refuse outright, and a device under a managed
 * configuration profile may have the choice taken away from it. On those, encrypted access is
 * not a worse option than plaintext — it is not an option. The alternative to this listener is
 * that the device gets nothing, which is a decision the operator should be allowed to make
 * with the cost stated, not one the product should make for them by omission.
 *
 * ## What keeps it from becoming the default path
 *
 *   - It does not exist unless `lanPlaintext` is set, and that defaults to false and is not
 *     derived from any other setting. Nothing turns it on to make something else work.
 *   - **Nothing advertises it.** The QR payload, the pairing screen and `lanEndpoint` all keep
 *     publishing the HTTPS origin. The only way onto this listener is for a person to read its
 *     address off the panel and type it, which is what makes the downgrade a choice rather
 *     than a drift.
 *   - It is a separate socket and a separate `http.Server`. The HTTPS listener's certificate,
 *     port and behaviour are untouched by whether this one is running.
 *   - Every request it accepts is marked `viaPlaintext`, so the operator API refuses it, the
 *     capability report records which devices are on it, and nothing downstream has to infer
 *     the transport from a header.
 *
 * ## Why the gate is not per-device
 *
 * A per-device allow-list was considered and deliberately not built. It would need a column on
 * `devices` — a schema migration in a file owned elsewhere — and the property it would buy is
 * one this design already has: it would stop a TLS-capable device from *silently* ending up on
 * the plain address, and nothing can silently end up here, because nothing advertises this
 * address and a device cannot reach it without a person typing it. Meanwhile the list could
 * not gate the one request that has no device yet, which is pairing — the very request the
 * device that needs this listener has to make.
 *
 * What is per-device is visibility and revocation, which is the part an operator can act on:
 * every device that talks to this listener appears in the capability report by name, tagged
 * `lan-plaintext`, and its access can be closed individually from the panel.
 */

export interface PlaintextListenerOptions {
  /** The same Express app the other two listeners serve. One app, three sockets. */
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  log: Logger;
}

export function createPlaintextListener(options: PlaintextListenerOptions): http.Server {
  let warned = false;

  return http.createServer((req, res) => {
    /**
     * Both flags, set before Express sees the request.
     *
     * `viaLan` waives the edge secret exactly as it does on the TLS listener — there is no
     * edge in front of either of them. `viaPlaintext` is the extra fact, and it is a property
     * on the request object rather than a header precisely so that no client can set it.
     */
    const marked = req as http.IncomingMessage & { viaLan?: boolean; viaPlaintext?: boolean };
    marked.viaLan = true;
    marked.viaPlaintext = true;

    if (!warned) {
      warned = true;
      // Once per run, not per request: a line in the log the first time somebody actually uses
      // the unencrypted door, so a listener left on by accident is visible in a bug report.
      options.log.warn('a device is using the unencrypted local-network address', {
        remote: req.socket.remoteAddress ?? 'unknown',
      });
    }

    options.handler(req, res);
  });
}
