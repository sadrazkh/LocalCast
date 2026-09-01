import { describe, expect, it } from 'vitest';
import { ApiException, ErrorCode, errorStatus } from '../errors.js';
import { accessModeSchema, can, operationSchema } from '../permissions.js';
import { networkConfigSchema } from '../netedge.js';
import { printRequestSchema, qrPayloadSchema } from '../api.js';

/**
 * The contract is where the product's hard rules live, so this is where they are pinned.
 *
 * Every assertion here corresponds to a decision that is expensive to get wrong at runtime
 * and invisible in review: a permission that silently widens, a folder that reveals its own
 * existence, or a network mode that cannot possibly work being accepted and then spinning
 * on "connecting…" for ever.
 */

describe('the access matrix', () => {
  it('grants exactly what each mode is supposed to grant', () => {
    const ops = operationSchema.options;
    const table = Object.fromEntries(
      accessModeSchema.options.map((mode) => [mode, ops.filter((op) => can(mode, op))]),
    );

    expect(table).toEqual({
      full: ['list', 'stream', 'download', 'print', 'upload'],
      stream: ['list', 'stream'],
      none: [],
    });
  });

  it('never lets stream mode become a download route', () => {
    // `stream` is a UI restriction and the spec says so, but it must still refuse the two
    // operations that would hand over a whole file in one request.
    expect(can('stream', 'download')).toBe(false);
    expect(can('stream', 'print')).toBe(false);
  });
});

describe('error codes', () => {
  it('gives every code an HTTP status', () => {
    const codes = Object.values(ErrorCode);
    const missing = codes.filter((code) => errorStatus[code] === undefined);
    expect(missing).toEqual([]);
  });

  it('answers a closed folder with 404, so the matrix cannot be probed', () => {
    // 403 would confirm the folder exists. A device that has been shut out of a folder
    // should not be able to learn that the folder is there at all.
    expect(errorStatus[ErrorCode.FOLDER_CLOSED]).toBe(404);
    expect(errorStatus[ErrorCode.NOT_FOUND]).toBe(404);
  });

  it('carries the code and any detail through the wire envelope', () => {
    const err = new ApiException(ErrorCode.RATE_LIMITED, 'slow down', { retryAfterMs: 30_000 });
    expect(err.status).toBe(429);
    expect(err.toBody()).toEqual({
      error: { code: 'rate_limited', message: 'slow down', detail: { retryAfterMs: 30_000 } },
    });
  });

  it('omits detail entirely when there is none, rather than sending null', () => {
    expect(new ApiException(ErrorCode.NOT_FOUND, 'gone').toBody()).toEqual({
      error: { code: 'not_found', message: 'gone' },
    });
  });
});

describe('network configuration refuses what cannot work', () => {
  const base = { hostname: 'localcast', expose: 'tailnet' as const };

  it('accepts the default mode with control-plane certificates', () => {
    expect(
      networkConfigSchema.safeParse({ ...base, mode: 'default', certStrategy: 'control-plane' })
        .success,
    ).toBe(true);
  });

  it('rejects control-plane issuance on a self-hosted control server', () => {
    // Headscale has not implemented the DNS delegation `tailscale cert` needs. Accepting
    // this combination is how a settings page ends up showing "connecting…" for ever.
    const result = networkConfigSchema.safeParse({
      ...base,
      mode: 'custom',
      controlUrl: 'https://headscale.example.com',
      certStrategy: 'control-plane',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('certStrategy');
  });

  it('rejects Funnel on a self-hosted control server', () => {
    // Funnel depends on Tailscale's own ingress fleet; the upstream request is closed as
    // not planned.
    const result = networkConfigSchema.safeParse({
      mode: 'custom',
      controlUrl: 'https://headscale.example.com',
      certStrategy: 'dns01',
      certDomain: 'files.example.com',
      dnsProvider: 'cloudflare',
      dnsApiToken: 'token',
      hostname: 'localcast',
      expose: 'funnel',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('expose');
  });

  it('requires a control URL in custom mode', () => {
    const result = networkConfigSchema.safeParse({
      ...base,
      mode: 'custom',
      certStrategy: 'external-proxy',
      certDomain: 'files.example.com',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('controlUrl');
  });

  it('requires a domain, provider and token for dns01', () => {
    const result = networkConfigSchema.safeParse({
      ...base,
      mode: 'custom',
      controlUrl: 'https://headscale.example.com',
      certStrategy: 'dns01',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a complete dns01 configuration', () => {
    expect(
      networkConfigSchema.safeParse({
        ...base,
        mode: 'custom',
        controlUrl: 'https://headscale.example.com',
        certStrategy: 'dns01',
        certDomain: 'files.example.com',
        dnsProvider: 'cloudflare',
        dnsApiToken: 'token',
      }).success,
    ).toBe(true);
  });
});

describe('the QR payload', () => {
  const valid = {
    v: 1,
    host: 'localcast.tail1234.ts.net',
    code: '7F2A',
    secret: 'x'.repeat(43),
  };

  it('accepts a well-formed payload', () => {
    expect(qrPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a short secret, a wrong version and a mis-sized code', () => {
    // The long secret is the only thing making a QR unguessable; the 4-character code is
    // guarded by a rate limiter instead.
    expect(qrPayloadSchema.safeParse({ ...valid, secret: 'short' }).success).toBe(false);
    expect(qrPayloadSchema.safeParse({ ...valid, v: 2 }).success).toBe(false);
    expect(qrPayloadSchema.safeParse({ ...valid, code: '7F2' }).success).toBe(false);
  });
});

describe('print requests', () => {
  it('applies the documented defaults', () => {
    const parsed = printRequestSchema.parse({
      printerId: 'p1',
      source: { kind: 'library', fileId: 'f1' },
    });
    expect(parsed).toMatchObject({ copies: 1, color: 'mono', duplex: 'simplex' });
  });

  it('bounds the copy count', () => {
    const base = { printerId: 'p1', source: { kind: 'library', fileId: 'f1' } };
    expect(printRequestSchema.safeParse({ ...base, copies: 0 }).success).toBe(false);
    expect(printRequestSchema.safeParse({ ...base, copies: 100 }).success).toBe(false);
    expect(printRequestSchema.safeParse({ ...base, copies: 99 }).success).toBe(true);
  });
});
