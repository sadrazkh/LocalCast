/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { StoredSession } from '@localcast/client-core';
import { attachMediaAuthorization, serverForUrl } from '../mediaAuth.js';
import type { MediaAuthWebRequest } from '../mediaAuth.js';
import type { ClientHub } from '../hub.js';
import type { ServerSummary } from '../../shared/ipc.js';

/**
 * The one place in this app where a bearer token is attached to a request nobody in the code
 * issued: the range requests a native `<video>` makes for itself as the user seeks.
 *
 * Everything here is about scope. The token is the device's read access to somebody else's
 * files, the filter sees *every* https request the window makes, and the URLs it is judging
 * arrive from a remote file index. So the questions are: does the right request get it, does
 * every other request not get it, and does every path out of the listener answer at all —
 * Electron holds a request until the callback fires, so a listener that throws does not fail
 * a video, it freezes one.
 */

const ALPHA = 'https://alpha.tail1234.ts.net';
const BETA = 'https://beta.tail5678.ts.net';
const TOKEN = 'access-alpha-secret';

function session(accessToken: string): StoredSession {
  return {
    deviceId: 'dev-a',
    accessToken,
    refreshToken: 'refresh-a',
    expiresAt: 4_000_000_000_000,
    host: 'alpha.tail1234.ts.net',
    davPassword: 'dav-a',
  };
}

function summary(id: string, baseUrl: string, deviceId: string | null): ServerSummary {
  return {
    id,
    label: id,
    host: baseUrl.replace('https://', ''),
    baseUrl,
    state: deviceId === null ? 'needs-pairing' : 'paired',
    connection: 'connected',
    deviceId,
    addedAt: 1,
    lastConnectedAt: null,
    lastErrorCode: null,
  };
}

interface HubOptions {
  servers?: ServerSummary[];
  ensureFresh?: () => Promise<StoredSession | null>;
  clientThrows?: boolean;
}

function fakeHub(options: HubOptions = {}): ClientHub {
  const servers = options.servers ?? [
    summary('alpha', ALPHA, 'dev-a'),
    summary('beta', BETA, 'dev-b'),
  ];
  return {
    summaries: () => servers,
    client: (serverId: string) => {
      if (options.clientThrows === true) {
        throw new Error(`no server is registered under «${serverId}»`);
      }
      return {
        session: {
          ensureFresh: options.ensureFresh ?? (async () => session(TOKEN)),
        },
      };
    },
  } as unknown as ClientHub;
}

/** Captures the listener Electron would have registered, and lets a test drive it. */
function capture(hub: ClientHub): {
  filter: { urls: string[] };
  send(url: string, headers?: Record<string, string>): Promise<Record<string, string>>;
} {
  let listener:
    | ((
        details: { url: string; requestHeaders: Record<string, string> },
        callback: (response: { requestHeaders: Record<string, string> }) => void,
      ) => void)
    | null = null;
  let filter: { urls: string[] } = { urls: [] };

  const webRequest: MediaAuthWebRequest = {
    onBeforeSendHeaders(urls, handler) {
      filter = urls;
      listener = handler;
    },
  };
  attachMediaAuthorization(webRequest, hub);

  return {
    get filter() {
      return filter;
    },
    send(url, headers = { accept: '*/*' }) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the listener never called back and the request would hang')),
          1000,
        );
        listener!({ url, requestHeaders: { ...headers } }, (response) => {
          clearTimeout(timer);
          resolve(response.requestHeaders);
        });
      });
    },
  };
}

describe('attachMediaAuthorization', () => {
  it('attaches the bearer to a content request for a paired server, and touches nothing else', async () => {
    const hub = capture(fakeHub());
    const headers = await hub.send(`${ALPHA}/api/v1/files/f1/content`, {
      accept: '*/*',
      range: 'bytes=0-',
    });

    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // The header the element set for itself survives: this is a seek, and dropping the Range
    // would restart the film from the beginning.
    expect(headers.range).toBe('bytes=0-');
    // Headers only. A token in the URL is one the renderer can read back off the `<video>`
    // element, and one that lands in every log that records addresses.
    expect(`${ALPHA}/api/v1/files/f1/content`).not.toContain(TOKEN);
    expect(hub.filter.urls).toEqual(['https://*/*']);
  });

  it('gives nothing to a foreign origin that happens to use the same path', async () => {
    const hub = capture(fakeHub({ servers: [summary('alpha', ALPHA, 'dev-a')] }));
    const headers = await hub.send('https://evil.example.com/api/v1/files/f1/content');

    // The page renders file names and folder labels from a machine somebody else administers.
    // A URL that got into it from there must not be able to collect this device's token.
    expect(headers).not.toHaveProperty('Authorization');
    expect(JSON.stringify(headers)).not.toContain(TOKEN);
  });

  it('gives nothing for a server this machine has not been approved by', async () => {
    const hub = capture(fakeHub({ servers: [summary('alpha', ALPHA, null)] }));
    const headers = await hub.send(`${ALPHA}/api/v1/files/f1/content`);
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('lets the request out unauthenticated when the refresh fails, rather than hanging it', async () => {
    const hub = capture(
      fakeHub({
        ensureFresh: async () => {
          throw new Error('the network is down');
        },
      }),
    );

    // Resolving at all is the assertion: the 401 that follows becomes «دسترسی بسته شد» in the
    // player, and a spinner that never ends becomes a bug report.
    const headers = await hub.send(`${ALPHA}/api/v1/files/f1/content`);
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('answers even when the server row vanished mid-playback', async () => {
    const hub = capture(fakeHub({ clientThrows: true }));
    const headers = await hub.send(`${ALPHA}/api/v1/files/f1/content`);
    expect(headers).not.toHaveProperty('Authorization');
  });

});

describe('serverForUrl', () => {
  it('is null for anything that is not a media URL for a paired server', () => {
    const hub = fakeHub({ servers: [summary('alpha', ALPHA, 'dev-a')] });

    expect(serverForUrl(hub, `${ALPHA}/api/v1/files/f1/content`)).toBe('alpha');
    // Only under the content prefix: the token is not sprayed at every asset the window asks
    // for, and the JSON routes carry their own bearer from the main process already.
    expect(serverForUrl(hub, `${ALPHA}/api/v1/me`)).toBeNull();
    expect(serverForUrl(hub, `${ALPHA}/assets/app.js`)).toBeNull();
    expect(serverForUrl(hub, `${BETA}/api/v1/files/f1/content`)).toBeNull();
    expect(serverForUrl(hub, 'not a url at all')).toBeNull();
    // Plain http is a different origin from the https one this device paired with.
    expect(serverForUrl(hub, 'http://alpha.tail1234.ts.net/api/v1/files/f1/content')).toBeNull();
  });
});
