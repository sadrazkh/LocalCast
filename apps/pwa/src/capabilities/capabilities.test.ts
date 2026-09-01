import { describe, expect, it, vi } from 'vitest';
import {
  applyServiceWorkerOutcome,
  hasOfflineLibrary,
  initialCapabilities,
  isEncryptedTransport,
  isSettled,
  readEnvironment,
  type CapabilityEnvironment,
} from './detect.js';
import { postCapabilityReport, toReportBody } from './report.js';
import { createCapabilityStore } from './store.js';

/**
 * These tests are the reason acceptance item E2 can stop being a guess.
 *
 * Every combination below is a real browser state that the phone could be in and that the
 * developer's machine cannot reproduce: a certificate accepted but a worker refused, an
 * `http://` origin with the camera hidden, a private window with no IndexedDB. What is checked
 * is that each one produces a distinguishable, nameable answer — because "the offline library
 * did not work" is not a finding and "the browser refused with a SecurityError on an origin it
 * had already loaded" is.
 */

const SECURE: CapabilityEnvironment = {
  secureContext: true,
  hasServiceWorker: true,
  hasMediaDevices: true,
  hasIndexedDb: true,
  standalone: true,
};

describe('what the app concludes from a given browser', () => {
  it('reports a working phone as working', () => {
    const capabilities = applyServiceWorkerOutcome(initialCapabilities(SECURE), { ok: true });
    expect(capabilities.serviceWorker).toBe('registered');
    expect(capabilities.camera).toBe('available');
    expect(capabilities.storage).toBe('indexeddb');
    expect(hasOfflineLibrary(capabilities)).toBe(true);
    expect(isSettled(capabilities)).toBe(true);
  });

  it('names the refusal E2 is about, and keeps the camera it still has', () => {
    // Chrome's documented behaviour on an origin with an outstanding certificate error: the
    // page loads, the user has accepted the warning, and `register()` still throws. Until now
    // this was a paragraph of "probably" in the README.
    const error = Object.assign(new Error('An SSL certificate error occurred'), {
      name: 'SecurityError',
    });
    const capabilities = applyServiceWorkerOutcome(initialCapabilities(SECURE), {
      ok: false,
      error,
    });

    expect(capabilities.serviceWorker).toBe('refused');
    expect(capabilities.serviceWorkerError).toBe('SecurityError');
    // The trade is partial, not total: an accepted self-signed origin is still a secure
    // context, so the camera survives even where the worker does not.
    expect(capabilities.camera).toBe('available');
    expect(hasOfflineLibrary(capabilities)).toBe(false);
  });

  it('blames the address, not the browser, on a plain-HTTP origin', () => {
    const capabilities = initialCapabilities({
      ...SECURE,
      secureContext: false,
      // An insecure origin hides both APIs, which is exactly why the diagnosis has to come
      // from the context rather than from their absence.
      hasServiceWorker: false,
      hasMediaDevices: false,
    });

    expect(capabilities.serviceWorker).toBe('insecure-context');
    expect(capabilities.camera).toBe('insecure-context');
    // This is the finding that makes plain HTTP the wrong answer to a service-worker refusal:
    // it does not restore the offline library, it guarantees its absence.
    expect(hasOfflineLibrary(capabilities)).toBe(false);
  });

  it('does not relabel an insecure origin as a failure when an attempt is reported', () => {
    const capabilities = applyServiceWorkerOutcome(
      initialCapabilities({ ...SECURE, secureContext: false, hasServiceWorker: false }),
      { ok: false, error: new Error('nope') },
    );
    expect(capabilities.serviceWorker).toBe('insecure-context');
  });

  it('separates a browser that cannot from a browser that would not', () => {
    const unsupported = initialCapabilities({ ...SECURE, hasServiceWorker: false });
    expect(unsupported.serviceWorker).toBe('unsupported');

    const failed = applyServiceWorkerOutcome(initialCapabilities(SECURE), {
      ok: false,
      error: new TypeError('Failed to fetch'),
    });
    expect(failed.serviceWorker).toBe('failed');
    expect(failed.serviceWorkerError).toBe('TypeError');
  });

  it('counts a private window with no IndexedDB as having no offline library', () => {
    const capabilities = applyServiceWorkerOutcome(
      initialCapabilities({ ...SECURE, hasIndexedDb: false }),
      { ok: true },
    );
    // A registered worker with nowhere to write is a library that empties itself when the tab
    // closes, which is not an offline library.
    expect(capabilities.storage).toBe('memory');
    expect(hasOfflineLibrary(capabilities)).toBe(false);
  });

  it('forgets a stale error once registration succeeds', () => {
    const refused = applyServiceWorkerOutcome(initialCapabilities(SECURE), {
      ok: false,
      error: Object.assign(new Error('x'), { name: 'SecurityError' }),
    });
    const recovered = applyServiceWorkerOutcome(refused, { ok: true });
    expect(recovered.serviceWorker).toBe('registered');
    expect(recovered.serviceWorkerError).toBeUndefined();
  });
});

describe('whether anyone else on the Wi-Fi can read this', () => {
  it('is about the transport, not about what the browser calls a secure context', () => {
    expect(isEncryptedTransport({ protocol: 'https:', hostname: '192.168.1.50' })).toBe(true);
    expect(isEncryptedTransport({ protocol: 'http:', hostname: '192.168.1.50' })).toBe(false);
    expect(isEncryptedTransport({ protocol: 'http:', hostname: 'localcast.local' })).toBe(false);
    // Loopback never crosses a network, which is the same line browsers draw when they treat
    // `http://localhost` as trustworthy.
    expect(isEncryptedTransport({ protocol: 'http:', hostname: 'localhost' })).toBe(true);
    expect(isEncryptedTransport({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true);
  });
});

describe('reading the real platform', () => {
  it('survives a runtime that throws when asked about itself', () => {
    const hostile = {
      isSecureContext: true,
      navigator: {},
      get indexedDB(): unknown {
        // A sandboxed iframe does exactly this. A page that crashes while describing itself
        // has described nothing.
        throw new Error('The operation is insecure.');
      },
    } as unknown as Window & typeof globalThis;

    expect(readEnvironment(hostile)).toEqual({
      secureContext: true,
      hasServiceWorker: false,
      hasMediaDevices: false,
      hasIndexedDb: false,
      standalone: false,
    });
  });

  it('sees an iOS home-screen launch through the non-standard property', () => {
    const ios = {
      isSecureContext: true,
      navigator: { standalone: true, serviceWorker: {}, mediaDevices: { getUserMedia: () => null } },
      indexedDB: {},
      // iOS Safari does not implement the display-mode query for home-screen web apps.
      matchMedia: () => ({ matches: false }),
    } as unknown as Window & typeof globalThis;

    expect(readEnvironment(ios).standalone).toBe(true);
  });
});

describe('what is sent to the server', () => {
  it('sends nothing until the answer is known', () => {
    expect(toReportBody(initialCapabilities(SECURE))).toBeNull();
  });

  it('carries the capabilities and nothing that could identify the browser', () => {
    const body = toReportBody(
      applyServiceWorkerOutcome(initialCapabilities(SECURE), {
        ok: false,
        error: Object.assign(new Error('x'), { name: 'SecurityError' }),
      }),
    );

    // The exact key set, asserted rather than sampled. A capability report is not a place to
    // accumulate a fingerprint, and the way that rule stops being true is one field at a time.
    expect(Object.keys(body ?? {}).sort()).toEqual([
      'camera',
      'secureContext',
      'serviceWorker',
      'serviceWorkerError',
      'standalone',
      'storage',
    ]);
    // No user agent, no version, no locale, and no claim about which address it was loaded
    // from — the server sees which of its own sockets the request arrived on.
    expect(JSON.stringify(body)).not.toMatch(/mozilla|version|userAgent|http/i);
  });

  it('posts to the device endpoint with the bearer, and never throws when it cannot', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const body = toReportBody(applyServiceWorkerOutcome(initialCapabilities(SECURE), { ok: true }));

    const accepted = await postCapabilityReport({
      baseUrl: 'https://192.168.1.50:8443',
      accessToken: 'token-abc',
      body: body!,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(accepted).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://192.168.1.50:8443/api/v1/capabilities');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer token-abc');

    // A phone that is offline, or paired to a server too old to have this endpoint, must carry
    // on browsing its library exactly as before. Nothing waits on this.
    const offline = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      postCapabilityReport({
        baseUrl: 'https://192.168.1.50:8443',
        accessToken: 'token-abc',
        body: body!,
        fetchImpl: offline as unknown as typeof fetch,
      }),
    ).resolves.toBe(false);
  });
});

describe('the store the screen and the report both read', () => {
  it('tells its subscribers once the registration attempt settles', () => {
    const store = createCapabilityStore({
      environment: SECURE,
      location: { protocol: 'https:', hostname: '192.168.1.50' },
    });
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.get().capabilities.serviceWorker));

    const before = store.get();
    expect(before.capabilities.serviceWorker).toBe('pending');
    expect(before.encryptedTransport).toBe(true);

    store.noteServiceWorker({ ok: true });
    expect(seen).toEqual(['registered']);

    // Identity is stable when nothing changed: `useSyncExternalStore` re-renders for ever if
    // the snapshot is a fresh object every time it asks.
    const after = store.get();
    store.noteServiceWorker({ ok: true });
    expect(store.get()).toBe(after);
    expect(seen).toEqual(['registered']);
  });

  it('knows a plain-HTTP origin is unencrypted before anything is registered', () => {
    const store = createCapabilityStore({
      environment: { ...SECURE, secureContext: false, hasServiceWorker: false, hasMediaDevices: false },
      location: { protocol: 'http:', hostname: '192.168.1.50' },
    });
    expect(store.get().encryptedTransport).toBe(false);
    expect(store.get().capabilities.serviceWorker).toBe('insecure-context');
  });
});
