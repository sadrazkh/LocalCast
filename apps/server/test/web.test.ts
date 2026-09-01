import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, startServer, tempDir, type TestServer } from './helpers.js';

/**
 * The PWA is served from the same origin as the API, which is why a phone never has to be
 * told a second address. These tests guard the two ways that arrangement usually breaks: the
 * single-page fallback swallowing an API route, and a missing asset arriving as HTML with a
 * 200 so the failure shows up as a blank screen instead of a 404.
 */

let webRoot: string;
let ts: TestServer;

beforeAll(async () => {
  webRoot = tempDir('lc-web-');
  fs.mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>LocalCast</title>');
  fs.writeFileSync(path.join(webRoot, 'assets', 'main-a1b2c3.js'), 'console.log(1)');
  fs.writeFileSync(path.join(webRoot, 'sw.js'), '/* service worker */');
  fs.writeFileSync(path.join(webRoot, 'manifest.webmanifest'), '{}');

  ts = await startServer({ webRoot });
});

afterAll(async () => {
  await ts.dispose();
  cleanupTempDirs();
});

afterEach(() => {
  // no per-test state
});

describe('serving the web client', () => {
  it('serves the app shell at the root', async () => {
    const res = await ts.fetch('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('LocalCast');
  });

  it('serves a navigation route that only exists in the client router', async () => {
    const res = await ts.fetch('/library/movies', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('LocalCast');
  });

  it('keeps fingerprinted assets for a year and the shell fresh', async () => {
    const asset = await ts.fetch('/assets/main-a1b2c3.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const shell = await ts.fetch('/');
    expect(shell.headers.get('cache-control')).toBe('no-cache');

    const manifest = await ts.fetch('/manifest.webmanifest');
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
  });

  it('never caches the service worker', async () => {
    // The service worker is what injects the bearer token into <video> and WebDAV requests.
    // A cached copy would pin a stale auth strategy for as long as the browser liked.
    const res = await ts.fetch('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('service-worker-allowed')).toBe('/');
  });

  it('does not shadow the API with the single-page fallback', async () => {
    // Unauthenticated, so the point is only that this is JSON from the API and not the shell.
    const res = await ts.fetch('/api/v1/folders', { headers: { accept: 'text/html' } });
    expect(res.status).not.toBe(200);
    expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/);
  });

  it('does not shadow WebDAV or the operator API', async () => {
    for (const url of ['/dav/some-folder/x.mkv', '/operator/v1/folders']) {
      const res = await ts.fetch(url, { headers: { accept: 'text/html' } });
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/);
    }
  });

  it('404s a missing asset instead of answering with the shell', async () => {
    // Returning HTML with a 200 here is the failure that turns a typo in an asset path into
    // a blank screen and an unreadable console error.
    const res = await ts.fetch('/assets/does-not-exist.js', {
      headers: { accept: 'application/javascript' },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('LocalCast');
  });

  it('stays disabled when no webRoot is configured', async () => {
    const bare = await startServer();
    try {
      const res = await bare.fetch('/');
      expect(res.status).toBe(404);
    } finally {
      await bare.dispose();
    }
  });

  it('refuses to mount a webRoot with no index.html rather than 404ing mysteriously', async () => {
    const empty = tempDir('lc-web-empty-');
    const bare = await startServer({ webRoot: empty });
    try {
      const res = await bare.fetch('/');
      expect(res.status).toBe(404);
    } finally {
      await bare.dispose();
    }
  });
});
