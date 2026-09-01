import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ApiException, FUNNEL_PEER } from '@localcast/contract';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { CODE_ALPHABET, MAX_FAILED_ATTEMPTS } from '../src/auth/pairing.js';
import { cleanupTempDirs, postJson, startServer, type TestServer } from './helpers.js';

const servers: TestServer[] = [];

async function server(overrides: Parameters<typeof startServer>[0] = {}): Promise<TestServer> {
  const ts = await startServer(overrides);
  servers.push(ts);
  return ts;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.dispose();
});

afterAll(cleanupTempDirs);

interface Minted {
  code: string;
  qr: { secret: string; host: string; code: string; v: number };
  expiresAt: number;
}

async function mint(ts: TestServer, ttlSeconds = 300): Promise<Minted> {
  const res = await ts.fetch('/operator/pairing', postJson({ ttlSeconds, defaultPermissions: [] }));
  expect(res.status).toBe(201);
  return (await res.json()) as Minted;
}

function claimBody(code: string, secret?: string): RequestInit {
  return postJson({
    code,
    ...(secret === undefined ? {} : { secret }),
    deviceName: 'Phone',
    platform: 'ios-pwa',
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('pairing codes', () => {
  it('mints a four-character code from an unambiguous alphabet', async () => {
    const ts = await server();
    for (let i = 0; i < 25; i++) {
      const minted = await mint(ts);
      expect(minted.code).toHaveLength(4);
      expect(minted.code).toMatch(/^[A-Z2-9]{4}$/);
      // No O/0/I/1: those are the four glyphs people get wrong when typing a code off a
      // screen, so they are not in the alphabet at all.
      expect(minted.code).not.toMatch(/[O0I1]/);
      for (const ch of minted.code) expect(CODE_ALPHABET).toContain(ch);
      expect(minted.qr.secret.length).toBeGreaterThanOrEqual(43);
      expect(minted.qr.host).toBe('test.localcast.example');
    }
  });

  it('stores only the hash of the secret, never the secret', async () => {
    const ts = await server();
    const minted = await mint(ts);
    const row = ts.server.ctx.db
      .prepare('SELECT secret_hash FROM pairing_tokens WHERE code = ?')
      .get(minted.code) as { secret_hash: string };
    expect(row.secret_hash).toMatch(/^scrypt\$/);
    expect(row.secret_hash).not.toContain(minted.qr.secret);
  });

  it('accepts the right secret exactly once', async () => {
    const ts = await server();
    const minted = await mint(ts);

    const first = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, minted.qr.secret));
    expect(first.status).toBe(201);

    const second = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, minted.qr.secret));
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('pairing_consumed');
  });

  it('rejects an expired code', async () => {
    const ts = await server();
    const minted = await mint(ts, 60);
    // Reaching past the API rather than sleeping a minute: the assertion is about the
    // expiry check, not about the clock.
    ts.server.ctx.db
      .prepare('UPDATE pairing_tokens SET expires_at = ? WHERE code = ?')
      .run(Date.now() - 1000, minted.code);

    const res = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, minted.qr.secret));
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('pairing_expired');
  });

  it('rejects an unknown code with the same error as a wrong secret', async () => {
    const ts = await server({ rateLimits: { globalCapacity: 500, anonCapacity: 500 } });
    const minted = await mint(ts);

    const unknown = await ts.fetch('/api/v1/pair/claim', claimBody('ZZZZ', 'whatever'));
    const wrongSecret = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, 'wrong'));
    expect(unknown.status).toBe(400);
    expect(wrongSecret.status).toBe(400);
    expect(await errorCode(unknown)).toBe(await errorCode(wrongSecret));
  });

  it(`locks a code after ${MAX_FAILED_ATTEMPTS} wrong secrets, and stays locked for the right one`, async () => {
    // The rate limiter is opened right up so that what stops the fifth attempt is provably
    // the lockout and not the bucket.
    const ts = await server({
      rateLimits: {
        globalCapacity: 1000,
        anonCapacity: 1000,
        codeCapacity: 1000,
        backoffBaseMs: 0,
        backoffMaxMs: 0,
      },
    });
    const minted = await mint(ts);

    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt++) {
      const res = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, `wrong-${attempt}`));
      expect(await errorCode(res), `attempt ${attempt}`).toBe('pairing_invalid');
    }

    const fifth = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, 'wrong-5'));
    expect(fifth.status).toBe(429);
    expect(await errorCode(fifth)).toBe('pairing_locked');

    const withRealSecret = await ts.fetch(
      '/api/v1/pair/claim',
      claimBody(minted.code, minted.qr.secret),
    );
    expect(withRealSecret.status).toBe(429);
    expect(await errorCode(withRealSecret)).toBe('pairing_locked');

    const row = ts.server.ctx.db
      .prepare('SELECT failed_attempts, locked_at FROM pairing_tokens WHERE code = ?')
      .get(minted.code) as { failed_attempts: number; locked_at: number | null };
    expect(row.failed_attempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(row.locked_at).not.toBeNull();
  });

  it('lets a typed code through without a secret, because that is the documented fallback', async () => {
    const ts = await server();
    const minted = await mint(ts);
    const res = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code));
    expect(res.status).toBe(201);
  });

  it('will not hand a claim ticket holder someone else’s approval', async () => {
    const ts = await server();
    const minted = await mint(ts);
    const claim = (await (
      await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, minted.qr.secret))
    ).json()) as { deviceId: string; claimTicket: string };

    // Right device, wrong ticket.
    const forged = await ts.fetch(`/api/v1/pair/status/${claim.deviceId}?ticket=not-the-ticket`);
    expect(forged.status).toBe(404);

    // No ticket at all.
    const bare = await ts.fetch(`/api/v1/pair/status/${claim.deviceId}`);
    expect(bare.status).toBe(400);

    const proper = await ts.fetch(
      `/api/v1/pair/status/${claim.deviceId}?ticket=${encodeURIComponent(claim.claimTicket)}`,
    );
    expect(proper.status).toBe(200);
    expect(((await proper.json()) as { status: string }).status).toBe('pending');
  });

  it('reports a rejected device as rejected and issues nothing', async () => {
    const ts = await server();
    const minted = await mint(ts);
    const claim = (await (
      await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, minted.qr.secret))
    ).json()) as { deviceId: string; claimTicket: string };

    await ts.fetch(`/operator/devices/${claim.deviceId}/reject`, { method: 'POST' });
    const status = (await (
      await ts.fetch(
        `/api/v1/pair/status/${claim.deviceId}?ticket=${encodeURIComponent(claim.claimTicket)}`,
      )
    ).json()) as { status: string; accessToken?: string };
    expect(status.status).toBe('rejected');
    expect(status.accessToken).toBeUndefined();
  });

  it('delivers the one-time WebDAV password exactly once', async () => {
    const ts = await server();
    const minted = await mint(ts);
    const claim = (await (
      await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, minted.qr.secret))
    ).json()) as { deviceId: string; claimTicket: string };
    await ts.fetch(`/operator/devices/${claim.deviceId}/approve`, { method: 'POST' });

    const url = `/api/v1/pair/status/${claim.deviceId}?ticket=${encodeURIComponent(claim.claimTicket)}`;
    const first = (await (await ts.fetch(url)).json()) as { status: string; davPassword: string };
    expect(first.status).toBe('approved');
    expect(first.davPassword).toHaveLength(20);

    // Second poll gets nothing: the plaintext was never stored, only its hash.
    const second = await ts.fetch(url);
    expect(second.status).toBe(410);

    const row = ts.server.ctx.db
      .prepare('SELECT dav_password_hash FROM devices WHERE id = ?')
      .get(claim.deviceId) as { dav_password_hash: string };
    expect(row.dav_password_hash).toMatch(/^scrypt\$/);
    expect(row.dav_password_hash).not.toContain(first.davPassword);
  });

  it('applies the permissions snapshot taken when the code was minted', async () => {
    const ts = await server();
    const media = (await import('node:fs')).mkdtempSync(
      (await import('node:path')).join((await import('node:os')).tmpdir(), 'lc-perm-'),
    );
    const folder = (await (
      await ts.fetch('/operator/folders', postJson({ path: media, label: 'Snapshot' }))
    ).json()) as { id: string };

    const mintRes = (await (
      await ts.fetch(
        '/operator/pairing',
        postJson({ ttlSeconds: 300, defaultPermissions: [{ folderId: folder.id, mode: 'stream' }] }),
      )
    ).json()) as Minted;

    const claim = (await (
      await ts.fetch('/api/v1/pair/claim', claimBody(mintRes.code, mintRes.qr.secret))
    ).json()) as { deviceId: string };
    await ts.fetch(`/operator/devices/${claim.deviceId}/approve`, { method: 'POST' });

    expect(ts.server.ctx.permissions.modeFor(claim.deviceId, folder.id)).toBe('stream');
  });
});

describe('rate limiting, which cannot be per-IP behind Funnel', () => {
  it('bounds the whole endpoint with a global bucket', async () => {
    // The other two layers are opened right up, so what stops request four is provably the
    // global bucket and not the per-code backoff that would otherwise bite on request two.
    const ts = await server({
      rateLimits: {
        globalCapacity: 3,
        globalWindowMs: 60_000,
        anonCapacity: 1000,
        codeCapacity: 1000,
        backoffBaseMs: 0,
        backoffMaxMs: 0,
      },
    });
    const minted = await mint(ts);

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, 'wrong'));
      codes.push(res.status);
    }
    expect(codes.slice(0, 3).every((s) => s === 400)).toBe(true);
    expect(codes.slice(3).every((s) => s === 429)).toBe(true);
  });

  it('gives an identified tailnet peer its own allowance', async () => {
    const ts = await server({
      rateLimits: { globalCapacity: 1000, peerCapacity: 2, anonCapacity: 1000, codeCapacity: 1000, backoffBaseMs: 0 },
    });
    const minted = await mint(ts);

    for (let i = 0; i < 2; i++) {
      const res = await ts.fetch('/api/v1/pair/claim', {
        ...claimBody(minted.code, 'wrong'),
        peer: 'alice-phone',
      });
      expect(res.status).toBe(400);
    }
    const exhausted = await ts.fetch('/api/v1/pair/claim', {
      ...claimBody(minted.code, 'wrong'),
      peer: 'alice-phone',
    });
    expect(exhausted.status).toBe(429);

    // A different peer identity is a different bucket; one noisy device does not lock out
    // the household.
    const other = await ts.fetch('/api/v1/pair/claim', {
      ...claimBody(minted.code, 'wrong'),
      peer: 'bob-laptop',
    });
    expect(other.status).toBe(400);
  });

  it('does NOT give `funnel` a per-key allowance', () => {
    // The header is the literal string `funnel` for every anonymous caller. Treating it as
    // an identity would hand an attacker the generous per-peer limit meant for a known
    // device, so it shares one strict bucket instead.
    const limiter = new RateLimiter({ peerCapacity: 100, anonCapacity: 2 });
    limiter.checkPeer(FUNNEL_PEER);
    limiter.checkPeer(FUNNEL_PEER);
    expect(() => limiter.checkPeer(FUNNEL_PEER)).toThrowError(ApiException);
    // An absent header is anonymous too, and lands in the same bucket rather than a new one.
    expect(() => limiter.checkPeer(undefined)).toThrowError(ApiException);
    expect(() => limiter.checkPeer('')).toThrowError(ApiException);
    // While a real identity still has its own.
    expect(() => limiter.checkPeer('alice')).not.toThrow();
  });

  it('backs off exponentially per code after each failure', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      { codeCapacity: 100, backoffBaseMs: 1000, backoffMaxMs: 60_000 },
      () => now,
    );

    limiter.checkCode('AB23');
    limiter.penaliseCode('AB23');
    expect(() => limiter.checkCode('AB23')).toThrowError(/attempts against this code/);

    now += 1001;
    expect(() => limiter.checkCode('AB23')).not.toThrow();
    limiter.penaliseCode('AB23');

    // Second failure costs twice as long, so guessing gets slower rather than merely capped.
    now += 1500;
    expect(() => limiter.checkCode('AB23')).toThrowError(ApiException);
    now += 600;
    expect(() => limiter.checkCode('AB23')).not.toThrow();
  });

  it('reports how long to wait so the client does not busy-loop', async () => {
    const ts = await server({ rateLimits: { globalCapacity: 1, globalWindowMs: 60_000 } });
    const minted = await mint(ts);
    await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, 'wrong'));
    const limited = await ts.fetch('/api/v1/pair/claim', claimBody(minted.code, 'wrong'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: { code: string; detail: { retryAfterMs: number } } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.detail.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time rather than locking out for ever', () => {
    let now = 0;
    const limiter = new RateLimiter({ globalCapacity: 2, globalWindowMs: 1000 }, () => now);
    limiter.checkGlobal();
    limiter.checkGlobal();
    expect(() => limiter.checkGlobal()).toThrowError(ApiException);
    now += 1000;
    expect(() => limiter.checkGlobal()).not.toThrow();
  });
});
