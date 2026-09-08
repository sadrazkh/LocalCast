import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@localcast/contract';
import { ApiClient } from '../api.js';
import { CancelledError, LocalCastError } from '../errors.js';
import { isPairableHost, isUsableOrigin, parseQrPayload, runPairing } from '../pairing.js';
import { SessionManager } from '../session.js';
import type { Handler } from './fakes.js';
import { BASE_URL, FakeClock, FakeTransport, json, MemoryTokenStore } from './fakes.js';

const SECRET = 'x'.repeat(43); // 32 random bytes, base64url
const GOOD = { v: 1, host: 'ali-pc.tail1234.ts.net', code: 'A7K2', secret: SECRET };

function qr(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...GOOD, ...overrides });
}

function fieldsOf(error: unknown): string[] {
  return ((error as LocalCastError).detail?.['fields'] as string[] | undefined) ?? [];
}

function client(handler: Handler) {
  const clock = new FakeClock();
  const transport = new FakeTransport(handler);
  const sessions = new SessionManager({
    transport,
    tokenStore: new MemoryTokenStore(null),
    clock,
    baseUrl: BASE_URL,
  });
  return { clock, transport, api: new ApiClient({ transport, session: sessions, baseUrl: BASE_URL }) };
}

const APPROVED = {
  status: 'approved',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 1_700_000_003_600_000,
  davPassword: 'dav-pw',
  device: { id: 'dev-9', name: 'iPhone' },
};

describe('QR validation', () => {
  it('accepts the payload the panel actually mints', () => {
    expect(parseQrPayload(qr())).toEqual(GOOD);
    expect(parseQrPayload(`  ${qr()}  `)).toEqual(GOOD);
  });

  it('rejects a payload from a different protocol version', () => {
    const error = (() => {
      try {
        parseQrPayload(qr({ v: 2 }));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(LocalCastError);
    expect((error as LocalCastError).code).toBe(ErrorCode.PAIRING_INVALID);
    expect(fieldsOf(error)).toContain('v');
  });

  it('accepts a payload with no secret, because the typed code is a real path', () => {
    /**
     * This used to assert the opposite, and the old rule was wrong rather than merely strict.
     *
     * The long secret protects the *scanned* code — it is what makes a QR unguessable. There
     * is no scanned code to protect when somebody reads four characters off a screen and types
     * them, and that path has been first-class since the beginning: it is the one that works
     * when the camera is unavailable, which on a local-network origin it often is.
     *
     * What guards the typed path is the rate limiter and the five-failure lockout, both of
     * which are tested on the server. Refusing a secretless payload here refused the fallback
     * as well as the attack.
     */
    const typed = parseQrPayload(JSON.stringify({ v: 1, host: GOOD.host, code: GOOD.code }));
    expect(typed.code).toBe(GOOD.code);
    expect(typed.secret).toBeUndefined();
  });

  it('reads a pairing link, which is what a phone camera can actually open', () => {
    const payload = parseQrPayload(`http://192.168.1.24:8420/#p=WJG6.${'s'.repeat(43)}`);
    expect(payload.code).toBe('WJG6');
    expect(payload.url).toBe('http://192.168.1.24:8420');
    expect(payload.secret).toHaveLength(43);
  });

  it('reads a link with only a code, for a QR minted without a secret', () => {
    const payload = parseQrPayload('http://192.168.1.24:8420/#p=WJG6');
    expect(payload.code).toBe('WJG6');
    expect(payload.secret).toBeUndefined();
  });

  it('refuses a link with no pairing code in its fragment', () => {
    expect(() => parseQrPayload('http://192.168.1.24:8420/')).toThrow();
  });

  it('rejects a secret that is too short to be 32 random bytes', () => {
    expect(() => parseQrPayload(qr({ secret: 'short' }))).toThrowError(LocalCastError);
  });

  it.each([
    ['a bare IPv4 address, which can never have a certificate', '192.168.1.31'],
    ['a full URL rather than a host', 'https://ali-pc.tail1234.ts.net/'],
    ['a host with a port', 'ali-pc.tail1234.ts.net:8420'],
    ['a host with credentials', 'user@ali-pc.tail1234.ts.net'],
    ['an empty host', ''],
    ['a host with a path', 'ali-pc.tail1234.ts.net/pair'],
  ])('rejects %s', (_why, host) => {
    let caught: unknown;
    try {
      parseQrPayload(qr({ host }));
    } catch (e) {
      caught = e;
    }
    expect((caught as LocalCastError).code).toBe(ErrorCode.PAIRING_INVALID);
    expect(fieldsOf(caught)).toContain('host');
  });

  it('rejects a scan that is not a LocalCast payload at all', () => {
    expect(() => parseQrPayload('https://example.com/some-other-qr')).toThrowError(LocalCastError);
    expect(() => parseQrPayload('')).toThrowError(LocalCastError);
    expect(() => parseQrPayload('{ not json')).toThrowError(LocalCastError);
  });

  it('rejects a manual code of the wrong length', () => {
    expect(() => parseQrPayload(qr({ code: 'A7K' }))).toThrowError(LocalCastError);
  });

  it('accepts a MagicDNS FQDN and nothing that merely resembles one', () => {
    expect(isPairableHost('ali-pc.tail1234.ts.net')).toBe(true);
    expect(isPairableHost('localcast.example.com')).toBe(true);
    expect(isPairableHost('10.0.0.1')).toBe(false);
    expect(isPairableHost('fe80::1')).toBe(false);
  });

  it.each([
    ['https to a tailnet name', 'https://ali-pc.tail1234.ts.net', true],
    ['https to a bare LAN address with a port', 'https://192.168.8.92:8420', true],
    // The one plaintext case the product actually mints: the switchable fallback listener, for a
    // device that cannot get past a self-signed certificate's interstitial.
    ['http to a LAN address', 'http://192.168.8.92:8421', true],
    ['http to 10.x', 'http://10.0.0.14:8421', true],
    ['http to a .local name', 'http://sadra.local:8421', true],
    ['http to loopback', 'http://127.0.0.1:8421', true],
    // Nothing in LocalCast ever mints these, so a payload carrying one is either an old server
    // or somebody trying to talk a client out of TLS on a network it does not control.
    ['http to a routable host', 'http://example.com', false],
    ['http to a public address', 'http://203.0.113.10:8421', false],
    ['an origin carrying credentials', 'https://user:pw@192.168.8.92:8420', false],
    ['an origin with a path', 'https://192.168.8.92:8420/pair', false],
    ['not a URL at all', 'nonsense', false],
  ])('isUsableOrigin — %s', (_why, origin, expected) => {
    expect(isUsableOrigin(origin)).toBe(expected);
  });

  it('refuses a pairing link that would send the phone somewhere plaintext on the internet', () => {
    // A link is the easiest of the two payload forms to hand somebody, so it is the one that
    // most needs this. The fragment is a perfectly well-formed pairing fragment; the origin is
    // the problem.
    expect(() => parseQrPayload(`http://evil.example.com/#p=WJG6.${'s'.repeat(43)}`)).toThrowError(
      LocalCastError,
    );
  });
});

describe('pairing flow', () => {
  it('claims, polls until the operator approves, and returns a usable session', async () => {
    let polls = 0;
    const { api, clock } = client((request) => {
      if (request.url.includes('/pair/claim')) {
        return json(200, { deviceId: 'dev-9', claimTicket: 'ticket-1', status: 'pending' });
      }
      polls += 1;
      return polls < 3 ? json(200, { status: 'pending' }) : json(200, APPROVED);
    });

    const delays: number[] = [];
    const paired = await runPairing({
      api,
      clock,
      qr: qr(),
      deviceName: 'iPhone',
      platform: 'ios-pwa',
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 1,
    });

    expect(polls).toBe(3);
    expect(paired).toEqual({
      deviceId: 'dev-9',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1_700_000_003_600_000,
      host: GOOD.host,
      davPassword: 'dav-pw',
    });
    // Gentle backoff: the operator is watching the phone while approving.
    expect(delays).toEqual([800, 1_200]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(5_000);
  });

  it('pairs from a link a phone camera opened, whose host is a bare LAN address', async () => {
    /**
     * The bug the whole scanning path died on.
     *
     * `runPairing` ran `isPairableHost(payload.host)` unconditionally. A pairing link puts the
     * address it was opened at in `host` — `192.168.8.92` — and `isPairableHost` refuses a bare
     * IP, correctly, for the field it was written for: `host` is a MagicDNS name and a bare IP
     * can never hold a public certificate. But a local-network payload carries the address it
     * actually wants in `url`, and this check ignored that. So every scan claimed nothing, the
     * screen fell back to the four-character form, and pairing by camera looked like it had
     * simply been left unimplemented.
     */
    const { api, clock } = client((request) =>
      request.url.includes('/pair/claim')
        ? json(200, { deviceId: 'dev-9', claimTicket: 'ticket-1', status: 'pending' })
        : json(200, APPROVED),
    );

    const phases: string[] = [];
    const paired = await runPairing({
      api,
      clock,
      qr: `https://192.168.8.92:8420/#p=WJG6.${SECRET}`,
      deviceName: 'iPhone',
      platform: 'ios-pwa',
      onPhase: (phase) => phases.push(phase),
    });

    expect(paired.deviceId).toBe('dev-9');
    // Carried into the session, so a reconnect goes back to the same origin rather than guessing
    // `https://<host>` and landing on port 443.
    expect(paired.baseUrl).toBe('https://192.168.8.92:8420');
    expect(paired.host).toBe('192.168.8.92');
    // Both phases reported, because they feel nothing alike: one is instant, the other lasts as
    // long as it takes somebody to walk to the computer.
    expect(phases).toEqual(['claiming', 'waiting-for-approval']);
  });

  it('still refuses a bare IP when the payload offers no origin to use instead', async () => {
    // The check was not wrong, only unconditional. A payload with an IP in `host` and no `url`
    // is a tailnet payload naming something that cannot be reached over the tailnet, and it must
    // still be refused — the claim must not even be sent.
    const { api, clock, transport } = client(() => json(200, APPROVED));

    await expect(
      runPairing({
        api,
        clock,
        qr: { v: 1, host: '192.168.8.92', code: 'WJG6', secret: SECRET },
        deviceName: 'iPhone',
        platform: 'ios-pwa',
      }),
    ).rejects.toThrowError(LocalCastError);

    expect(transport.matching('/pair/claim')).toHaveLength(0);
  });

  it('sends the claim ticket with every poll', async () => {
    const { api, clock, transport } = client((request) =>
      request.url.includes('/pair/claim')
        ? json(200, { deviceId: 'dev-9', claimTicket: 'ticket-1', status: 'pending' })
        : json(200, APPROVED),
    );

    await runPairing({ api, clock, qr: qr(), deviceName: 'iPhone', platform: 'ios-pwa' });

    const poll = transport.matching('/pair/status/')[0];
    expect(poll?.url).toBe(`${BASE_URL}/api/v1/pair/status/dev-9?ticket=ticket-1`);
  });

  it('stops on the caller’s cancellation signal', async () => {
    const controller = new AbortController();
    let polls = 0;
    const { api, clock } = client((request) => {
      if (request.url.includes('/pair/claim')) {
        return json(200, { deviceId: 'dev-9', claimTicket: 'ticket-1', status: 'pending' });
      }
      polls += 1;
      controller.abort(); // the user backs out of the pairing screen
      return json(200, { status: 'pending' });
    });

    await expect(
      runPairing({
        api,
        clock,
        qr: qr(),
        deviceName: 'iPhone',
        platform: 'ios-pwa',
        signal: controller.signal,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(polls).toBe(1);
  });

  it('gives up with pairing_expired once the code’s five minutes are gone', async () => {
    const { api, clock } = client((request) =>
      request.url.includes('/pair/claim')
        ? json(200, { deviceId: 'dev-9', claimTicket: 'ticket-1', status: 'pending' })
        : json(200, { status: 'pending' }),
    );

    await expect(
      runPairing({
        api,
        clock,
        qr: qr(),
        deviceName: 'iPhone',
        platform: 'ios-pwa',
        sleep: async (ms) => clock.advance(ms * 100),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PAIRING_EXPIRED });
  });

  it('surfaces an operator rejection as a typed error', async () => {
    const { api, clock } = client((request) =>
      request.url.includes('/pair/claim')
        ? json(200, { deviceId: 'dev-9', claimTicket: 'ticket-1', status: 'pending' })
        : json(200, { status: 'rejected' }),
    );

    await expect(
      runPairing({ api, clock, qr: qr(), deviceName: 'iPhone', platform: 'ios-pwa' }),
    ).rejects.toMatchObject({ code: ErrorCode.PAIRING_INVALID });
  });

  it('surfaces a locked pairing code without retrying it', async () => {
    const { api, clock, transport } = client(() =>
      json(429, { error: { code: ErrorCode.PAIRING_LOCKED, message: 'too many attempts' } }),
    );

    await expect(
      runPairing({ api, clock, qr: qr(), deviceName: 'iPhone', platform: 'ios-pwa' }),
    ).rejects.toMatchObject({ code: ErrorCode.PAIRING_LOCKED });
    expect(transport.countMatching('/pair/status/')).toBe(0);
  });
});
