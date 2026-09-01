import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { API_PREFIX, DAV_PREFIX } from '@localcast/contract';
import type { Logger } from '../kernel.js';

/**
 * Serves the built PWA.
 *
 * The phone reaches the same origin for both the app and its data, which is the whole reason
 * the client never has to be told an address: whatever host the QR code carried serves the
 * app, and the app talks back to where it came from. There is no second deployment, no CORS,
 * and no separate hostname to keep in sync when the network mode changes.
 *
 * It is mounted *below* the edge-secret guard along with everything else, so the app bundle
 * is no more reachable from elsewhere on the machine than the API is.
 */

/** Paths that belong to the API and must never fall through to the SPA. */
const RESERVED = [API_PREFIX, DAV_PREFIX, '/operator'];

function isReserved(url: string): boolean {
  return RESERVED.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
}

export function mountWebClient(app: Express, webRoot: string, log: Logger): boolean {
  if (!webRoot) return false;

  const indexFile = path.join(webRoot, 'index.html');
  if (!existsSync(indexFile)) {
    // A desktop build whose PWA bundle did not get packaged should still serve files and
    // print, and should say why the phone cannot load the app — not 404 mysteriously.
    log.warn('web client not mounted: no index.html', { webRoot });
    return false;
  }

  app.use(
    express.static(webRoot, {
      // Vite fingerprints everything under /assets, so those are safe to keep for a year.
      // Anything else — index.html, the manifest, the icons — is served fresh, because a
      // stale shell after an update is indistinguishable from a broken app.
      setHeaders(res, filePath) {
        const rel = path.relative(webRoot, filePath).replace(/\\/g, '/');
        if (rel.startsWith('assets/')) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('cache-control', 'no-cache');
        }
        // The service worker controls how everything else is fetched, including the token
        // injection that makes <video> work. A cached copy of it would pin a stale auth
        // strategy for as long as the browser felt like it.
        if (rel === 'sw.js' || rel === 'registerSW.js') {
          res.setHeader('cache-control', 'no-store');
          res.setHeader('service-worker-allowed', '/');
        }
      },
      index: false,
      dotfiles: 'ignore',
      fallthrough: true,
    }),
  );

  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (isReserved(req.path)) {
      next();
      return;
    }
    // Only navigations get the shell. A missing image or script must stay a 404 rather than
    // arriving as HTML with a 200, which is the failure mode that turns a typo in an asset
    // path into a blank screen and an unreadable console error.
    if (!req.accepts('html')) {
      next();
      return;
    }
    res.setHeader('cache-control', 'no-cache');
    res.sendFile(indexFile);
  });

  log.info('web client mounted', { webRoot });
  return true;
}
