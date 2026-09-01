import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ApiException } from '@localcast/contract';
import { isLoopbackAddress, loopbackOnly } from '../src/auth/middleware.js';
import {
  addFolder,
  bearer,
  cleanupTempDirs,
  pairDevice,
  postJson,
  startServer,
  tempDir,
  type PairedDevice,
  type TestServer,
} from './helpers.js';

let ts: TestServer;
let device: PairedDevice;
let folderId: string;

beforeEach(async () => {
  const media = tempDir('lc-tok-');
  fs.writeFileSync(path.join(media, 'a.mp4'), 'z'.repeat(256));
  ts = await startServer();
  folderId = await addFolder(ts, { path: media, label: 'Media' });
  device = await pairDevice(ts, [{ folderId, mode: 'full' }]);
});

afterEach(async () => {
  await ts?.dispose();
});

afterAll(cleanupTempDirs);

async function me(token: string): Promise<Response> {
  return ts.fetch('/api/v1/me', { headers: bearer(token) });
}

describe('token revocation takes effect on the next request', () => {
  it('invalidates an already-issued token the instant token_version is bumped', async () => {
    expect((await me(device.accessToken)).status).toBe(200);

    // Exactly what the panel's "بستن" button does.
    ts.server.ctx.db
      .prepare('UPDATE devices SET token_version = token_version + 1 WHERE id = ?')
      .run(device.deviceId);

    const res = await me(device.accessToken);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('token_revoked');
  });

  it('closes a device mid-stream through the operator API', async () => {
    const fileId = (
      ts.server.ctx.db.prepare('SELECT id FROM files WHERE name = ?').get('a.mp4') as { id: string }
    ).id;

    const before = await ts.fetch(`/api/v1/files/${fileId}/content`, {
      headers: { ...bearer(device.accessToken), range: 'bytes=0-9' },
    });
    expect(before.status).toBe(206);

    const revoke = await ts.fetch(`/operator/devices/${device.deviceId}/revoke`, {
      method: 'POST',
    });
    expect(revoke.status).toBe(204);

    const after = await ts.fetch(`/api/v1/files/${fileId}/content`, {
      headers: { ...bearer(device.accessToken), range: 'bytes=0-9' },
    });
    expect(after.status).toBe(403);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe('device_revoked');
  });

  it('rejects a token for a device that is still pending', async () => {
    ts.server.ctx.db
      .prepare("UPDATE devices SET status = 'pending' WHERE id = ?")
      .run(device.deviceId);
    const res = await me(device.accessToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('device_pending');
  });

  it('rejects a forged or tampered token', async () => {
    const parts = device.accessToken.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat((parts[2] as string).length)}`;
    expect((await me(tampered)).status).toBe(401);
    expect((await me('not-a-token')).status).toBe(401);

    const noAuth = await ts.fetch('/api/v1/me');
    expect(noAuth.status).toBe(401);
    expect(((await noAuth.json()) as { error: { code: string } }).error.code).toBe(
      'unauthenticated',
    );
  });

  it('carries only identity, never permissions', async () => {
    const claims = JSON.parse(
      Buffer.from(device.accessToken.split('.')[1] as string, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'jti', 'sub', 'tv']);
    expect(claims['sub']).toBe(device.deviceId);
    expect(claims['tv']).toBe(1);
    // Thirty days, as the spec says; permissions are re-read from SQLite every request.
    const ttlDays = ((claims['exp'] as number) - (claims['iat'] as number)) / 86400;
    expect(Math.round(ttlDays)).toBe(30);
  });
});

describe('refresh tokens rotate', () => {
  it('kills the old refresh token the moment a new one is issued', async () => {
    const first = await ts.fetch(
      '/api/v1/token/refresh',
      postJson({ refreshToken: device.refreshToken }),
    );
    expect(first.status).toBe(200);
    const issued = (await first.json()) as { accessToken: string; refreshToken: string };
    expect(issued.refreshToken).not.toBe(device.refreshToken);
    expect((await me(issued.accessToken)).status).toBe(200);

    const replay = await ts.fetch(
      '/api/v1/token/refresh',
      postJson({ refreshToken: device.refreshToken }),
    );
    expect(replay.status).toBe(401);
  });

  it('stores only a hash of the refresh token', () => {
    const row = ts.server.ctx.db
      .prepare('SELECT refresh_hash FROM devices WHERE id = ?')
      .get(device.deviceId) as { refresh_hash: string };
    expect(row.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(device.refreshToken).not.toContain(row.refresh_hash);
  });

  it('refuses to refresh for a revoked device', async () => {
    await ts.fetch(`/operator/devices/${device.deviceId}/revoke`, { method: 'POST' });
    const res = await ts.fetch(
      '/api/v1/token/refresh',
      postJson({ refreshToken: device.refreshToken }),
    );
    expect(res.status).toBe(401);
  });
});

describe('the operator API is not reachable over the tailnet', () => {
  it('requires the edge secret as well as loopback', async () => {
    const res = await fetch(`${ts.base}/operator/devices`);
    expect(res.status).toBe(401);
  });

  it('answers loopback callers that carry the secret', async () => {
    const res = await ts.fetch('/operator/devices');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: Array<{ id: string }> };
    expect(body.devices.map((d) => d.id)).toContain(device.deviceId);
  });

  it('recognises every spelling of loopback and nothing else', () => {
    for (const addr of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(addr), addr).toBe(true);
    }
    for (const addr of [
      '192.168.1.31',
      '10.0.0.4',
      '100.64.0.1', // a tailnet address: exactly what must not get in
      '::ffff:192.168.1.31',
      '0.0.0.0',
      undefined,
      '',
    ]) {
      expect(isLoopbackAddress(addr), String(addr)).toBe(false);
    }
  });

  it('answers a non-loopback socket with 404, so it does not advertise itself', () => {
    // Binding a second interface is not something a unit test should do, so the guard is
    // driven directly with the socket address it would have seen.
    const guard = loopbackOnly();
    const errors: unknown[] = [];
    guard(
      { socket: { remoteAddress: '100.64.0.9' } } as never,
      {} as never,
      ((err?: unknown) => errors.push(err)) as never,
    );
    expect(errors).toHaveLength(1);
    expect((errors[0] as ApiException).code).toBe('not_found');
    expect((errors[0] as ApiException).status).toBe(404);
  });

  it('is not opened by a device bearer token', () => {
    // A stolen device token is neither necessary nor sufficient here: the guard never looks
    // at `Authorization` at all, so there is no privilege to escalate through.
    const guard = loopbackOnly();
    const errors: unknown[] = [];
    guard(
      {
        socket: { remoteAddress: '100.64.0.9' },
        headers: { authorization: `Bearer ${device.accessToken}` },
      } as never,
      {} as never,
      ((err?: unknown) => errors.push(err)) as never,
    );
    expect((errors[0] as ApiException).code).toBe('not_found');
  });
});
