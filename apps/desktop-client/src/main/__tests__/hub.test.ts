/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '@localcast/contract';
import { LocalCastError } from '@localcast/client-core';
import type { TransportRequest, TransportResponse } from '@localcast/client-core';
import { ClientHub } from '../hub.js';
import { ServerRegistry } from '../registry.js';
import { SessionVault } from '../tokenStore.js';
import { FakeClock, MemoryLogger, json, RecordingTransport, reversibleCodec } from './fakes.js';

const ALPHA = 'alpha.tail1234.ts.net';
const BETA = 'beta.tail5678.ts.net';

/**
 * A fake LocalCast server for one host.
 *
 * It answers the three routes pairing and connecting actually touch, and it answers them per
 * origin — which is what makes the isolation assertion below meaningful rather than
 * decorative.
 */
function serverFor(host: string, suffix: string, expiresAt: number) {
  const origin = `https://${host}`;
  return (request: TransportRequest): TransportResponse | undefined => {
    if (!request.url.startsWith(origin)) return undefined;
    const path = new URL(request.url).pathname;

    if (path === '/api/v1/pair/claim') {
      return json(200, {
        deviceId: `dev-${suffix}`,
        claimTicket: `ticket-${suffix}`,
        status: 'pending',
      });
    }
    if (path === `/api/v1/pair/status/dev-${suffix}`) {
      return json(200, {
        status: 'approved',
        accessToken: `access-${suffix}`,
        refreshToken: `refresh-${suffix}`,
        expiresAt,
        davPassword: `dav-${suffix}`,
        device: { id: `dev-${suffix}`, name: 'test-pc' },
      });
    }
    if (path === '/api/v1/me') {
      return json(200, {
        device: { id: `dev-${suffix}`, name: 'test-pc', platform: 'windows', pairedAt: 1 },
        server: { name: host, version: '0.1.0', host },
        permissions: [],
      });
    }
    if (path === '/api/v1/folders') {
      return json(200, { folders: [] });
    }
    return undefined;
  };
}

describe('ClientHub', () => {
  let dir: string;
  let clock: FakeClock;
  let transport: RecordingTransport;
  let hub: ClientHub;
  let vault: SessionVault;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lc-hub-'));
    clock = new FakeClock();
    const expiresAt = clock.now() + 3_600_000;
    transport = new RecordingTransport(
      serverFor(ALPHA, 'a', expiresAt),
      serverFor(BETA, 'b', expiresAt),
    );
    vault = new SessionVault(join(dir, 'sessions.json'), reversibleCodec);
    hub = new ClientHub({
      registry: new ServerRegistry(join(dir, 'servers.json')),
      vault,
      transport,
      clock,
      deviceName: 'test-pc',
    });
  });

  afterEach(async () => {
    await hub.stopAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drives client-core runPairing from a typed code and stores the session under that server', async () => {
    const server = hub.add(ALPHA);
    expect(server.state).toBe('needs-pairing');

    const paired = await hub.pair(server.id, ' a1-b2 ');
    expect(paired.state).toBe('paired');
    expect(paired.deviceId).toBe('dev-a');

    const claim = transport.sent.find((request) => request.url.endsWith('/pair/claim'));
    expect(claim).toBeDefined();
    // `formatCode` normalisation: whitespace and separators stripped, upper-cased. A code
    // typed as «a1-b2» must reach the server as `A1B2` or it will simply not match.
    expect(JSON.parse(claim!.body ?? '{}')).toMatchObject({
      code: 'A1B2',
      deviceName: 'test-pc',
      platform: 'windows',
    });
    // The contract says `secret` is omitted when pairing by typed code, not sent empty.
    expect(JSON.parse(claim!.body ?? '{}')).not.toHaveProperty('secret');

    // The poll `runPairing` performs, with the one-shot claim ticket as a query parameter.
    expect(
      transport.sent.some((request) =>
        request.url.startsWith(`https://${ALPHA}/api/v1/pair/status/dev-a?ticket=ticket-a`),
      ),
    ).toBe(true);

    const stored = vault.read(server.id);
    expect(stored?.accessToken).toBe('access-a');
    expect(stored?.davPassword).toBe('dav-a');
    expect(stored?.host).toBe(ALPHA);
    // Nothing was written for a server that was never paired.
    expect(vault.pairedServerIds()).toEqual([server.id]);
  });

  it('keeps two paired servers on separate sessions and never sends one a token from the other', async () => {
    const alpha = hub.add(ALPHA);
    const beta = hub.add(BETA);

    await hub.pair(alpha.id, 'A1B2');
    await hub.pair(beta.id, 'C3D4');

    expect(vault.read(alpha.id)?.accessToken).toBe('access-a');
    expect(vault.read(beta.id)?.accessToken).toBe('access-b');

    await hub.client(alpha.id).api.folders();
    await hub.client(beta.id).api.folders();

    const toAlpha = transport.bearersFor(`https://${ALPHA}`);
    const toBeta = transport.bearersFor(`https://${BETA}`);

    expect(toAlpha.length).toBeGreaterThan(0);
    expect(toBeta.length).toBeGreaterThan(0);

    // The assertion that matters: no bearer minted by one server ever appears in a request
    // addressed to the other. This is the failure that would leak a device's access from one
    // household's server to another's, and it is guaranteed structurally — each client holds
    // a `TokenStore` that cannot name a different server's key.
    expect(toAlpha.every((header) => header === 'Bearer access-a')).toBe(true);
    expect(toBeta.every((header) => header === 'Bearer access-b')).toBe(true);
    expect(toAlpha).not.toContain('Bearer access-b');
    expect(toBeta).not.toContain('Bearer access-a');
  });

  it('connects against the server it was told to, and reports the three list states', async () => {
    const alpha = hub.add(ALPHA);
    const beta = hub.add(BETA);

    await hub.pair(alpha.id, 'A1B2');
    const connected = await hub.connect(alpha.id);

    expect(connected.state).toBe('paired');
    expect(connected.baseUrl).toBe(`https://${ALPHA}`);
    expect(transport.sent.some((request) => request.url === `https://${ALPHA}/api/v1/me`)).toBe(
      true,
    );
    // The unpaired server was never contacted by the act of connecting the paired one.
    expect(transport.sent.every((request) => !request.url.startsWith(`https://${BETA}/api/v1/me`)))
      .toBe(true);

    expect(hub.summary(beta.id).state).toBe('needs-pairing');

    await hub.forget(alpha.id);
    expect(hub.summary(alpha.id).state).toBe('needs-pairing');
    expect(vault.read(alpha.id)).toBeNull();
  });

  it('refuses an address that cannot hold a certificate', () => {
    expect(() => hub.add('192.168.1.31')).toThrow(/MagicDNS/);
  });

  it('leaves the row unpaired and stores nothing when the operator says no', async () => {
    // One server, and its pairing poll comes back rejected rather than approved.
    const refusing = new RecordingTransport((request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/pair/claim') {
        return json(200, { deviceId: 'dev-a', claimTicket: 'ticket-a', status: 'pending' });
      }
      if (path === '/api/v1/pair/status/dev-a') return json(200, { status: 'rejected' });
      return undefined;
    });
    const refusingVault = new SessionVault(join(dir, 'refused.json'), reversibleCodec);
    const refusingHub = new ClientHub({
      registry: new ServerRegistry(join(dir, 'refused-servers.json')),
      vault: refusingVault,
      transport: refusing,
      clock,
      deviceName: 'test-pc',
    });
    const server = refusingHub.add(ALPHA);

    const error = await refusingHub.pair(server.id, 'A1B2').catch((cause: unknown) => cause);

    // A contract code, so the dialog can say «کد پذیرفته نشد» rather than showing prose the
    // server wrote. `ipc.ts` turns exactly this into a `PairResult` the renderer can read.
    expect(error).toBeInstanceOf(LocalCastError);
    expect((error as LocalCastError).code).toBe(ErrorCode.PAIRING_INVALID);
    expect(refusingVault.pairedServerIds()).toEqual([]);
    expect(refusingHub.summary(server.id).state).toBe('needs-pairing');
    await refusingHub.stopAll();
  });

  it('takes only the removed server’s session with it', async () => {
    const alpha = hub.add(ALPHA);
    const beta = hub.add(BETA);
    await hub.pair(alpha.id, 'A1B2');
    await hub.pair(beta.id, 'C3D4');

    await hub.remove(alpha.id);

    expect(hub.summaries().map((server) => server.id)).toEqual([beta.id]);
    expect(vault.read(alpha.id)).toBeNull();
    // The neighbour is untouched: one file holds both, and a removal that rewrote the whole
    // thing carelessly would sign the other household's server out at the same time.
    expect(vault.read(beta.id)?.accessToken).toBe('access-b');
    expect(hub.summary(beta.id).deviceId).toBe('dev-b');
  });

  it('sends a revoked device back to pairing with a code, and no token in the log', async () => {
    const logger = new MemoryLogger();
    let revoked = false;
    const closing = new RecordingTransport((request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/pair/claim') {
        return json(200, { deviceId: 'dev-a', claimTicket: 'ticket-a', status: 'pending' });
      }
      if (path === '/api/v1/pair/status/dev-a') {
        return json(200, {
          status: 'approved',
          accessToken: 'access-a',
          refreshToken: 'refresh-a',
          expiresAt: clock.now() + 3_600_000,
          davPassword: 'dav-a',
          device: { id: 'dev-a', name: 'test-pc' },
        });
      }
      if (path === '/api/v1/me' && revoked) {
        return json(403, {
          error: { code: 'device_revoked', message: 'this device was closed by the operator' },
        });
      }
      if (path === '/api/v1/me') {
        return json(200, {
          device: { id: 'dev-a', name: 'test-pc', platform: 'windows', pairedAt: 1 },
          server: { name: ALPHA, version: '0.1.0', host: ALPHA },
          permissions: [],
        });
      }
      return undefined;
    });
    const closingVault = new SessionVault(join(dir, 'closed.json'), reversibleCodec);
    const closingHub = new ClientHub({
      registry: new ServerRegistry(join(dir, 'closed-servers.json')),
      vault: closingVault,
      transport: closing,
      clock,
      logger,
      deviceName: 'test-pc',
    });
    const server = closingHub.add(ALPHA);
    await closingHub.pair(server.id, 'A1B2');
    expect(closingHub.summary(server.id).state).toBe('paired');

    revoked = true;
    const after = await closingHub.connect(server.id);

    // «نیاز به جفت‌سازی», not a red dot: one is fixed by asking the operator to approve this
    // machine again, the other by turning the other machine on.
    expect(after.state).toBe('needs-pairing');
    expect(after.lastErrorCode).toBe(ErrorCode.DEVICE_REVOKED);
    expect(closingVault.read(server.id)).toBeNull();
    expect(logger.text()).not.toContain('access-a');
    expect(logger.text()).not.toContain('refresh-a');
    expect(logger.text()).not.toContain('dav-a');
    await closingHub.stopAll();
  });
});
