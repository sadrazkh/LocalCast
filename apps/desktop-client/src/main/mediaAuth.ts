import { API_PREFIX } from '@localcast/contract';
import type { ClientHub } from './hub.js';

/**
 * How a `<video>` element gets a bearer token.
 *
 * `ApiClient.contentUrl()` deliberately returns a URL with no credential in it, because a
 * `<video src>` cannot set an `Authorization` header — the element issues its own range
 * requests as it seeks, and nothing in the page is given a chance to decorate them. The PWA
 * solves this with a service worker that attaches the bearer to requests under the API
 * prefix. This is the desktop's equivalent, and it is the reason the player can be a plain
 * native `<video>` with real seeking rather than something that buffers through JavaScript.
 *
 * The scope is deliberately tight:
 *   - only requests to an origin that belongs to a server this machine has actually paired
 *     with, so a page that somehow loaded a foreign URL gets nothing;
 *   - only paths under `/api/v1/files/`, so the token is not sprayed at every asset;
 *   - the token is read through `session.ensureFresh()`, which is `client-core`'s
 *     single-flight refresh — a seek that lands on an expired token refreshes once, not once
 *     per in-flight range request.
 */

const CONTENT_PREFIX = `${API_PREFIX}/files/`;

export interface MediaAuthWebRequest {
  onBeforeSendHeaders(
    filter: { urls: string[] },
    listener: (
      details: { url: string; requestHeaders: Record<string, string> },
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void,
  ): void;
}

export function attachMediaAuthorization(webRequest: MediaAuthWebRequest, hub: ClientHub): void {
  webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const serverId = serverForUrl(hub, details.url);
    if (serverId === null) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    void hub
      .client(serverId)
      .session.ensureFresh()
      .then((session) => {
        if (session === null) {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }
        callback({
          requestHeaders: {
            ...details.requestHeaders,
            Authorization: `Bearer ${session.accessToken}`,
          },
        });
      })
      .catch(() => {
        // A refresh that failed is not a reason to hang the request: let it go out
        // unauthenticated and let the 401 surface in the player as «دسترسی بسته شد».
        callback({ requestHeaders: details.requestHeaders });
      });
  });
}

/** `null` unless the URL is a media request to a server this machine holds a session for. */
export function serverForUrl(hub: ClientHub, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith(CONTENT_PREFIX)) return null;
  const match = hub
    .summaries()
    .find((server) => server.baseUrl === parsed.origin && server.deviceId !== null);
  return match?.id ?? null;
}
