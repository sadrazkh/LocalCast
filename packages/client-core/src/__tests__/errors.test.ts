import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@localcast/contract';
import { ApiClient } from '../api.js';
import { errorFromResponse, LocalCastError, SchemaDriftError } from '../errors.js';
import { SessionManager } from '../session.js';
import type { Handler } from './fakes.js';
import {
  apiError,
  BASE_URL,
  FakeClock,
  FakeTransport,
  folder,
  json,
  MemoryTokenStore,
  session,
  text,
} from './fakes.js';

function harness(handler: Handler) {
  const clock = new FakeClock();
  const store = new MemoryTokenStore(session());
  const transport = new FakeTransport(handler);
  const sessions = new SessionManager({ transport, tokenStore: store, clock, baseUrl: BASE_URL });
  return { api: new ApiClient({ transport, session: sessions, baseUrl: BASE_URL }), transport };
}

describe('error mapping', () => {
  it('carries the contract code through, without ever reading the message', () => {
    const error = errorFromResponse(
      apiError(404, ErrorCode.FOLDER_CLOSED, 'یافت نشد'),
      'GET /folders/:id/entries',
    );
    expect(error.code).toBe(ErrorCode.FOLDER_CLOSED);
    expect(error.status).toBe(404);
    expect(error.message).toBe('یافت نشد');
  });

  it('keeps structured detail, e.g. retryAfterMs on a rate limit', () => {
    const error = errorFromResponse(
      json(429, { error: { code: ErrorCode.RATE_LIMITED, message: 'slow down', detail: { retryAfterMs: 30_000 } } }),
      'POST /pair/claim',
    );
    expect(error.code).toBe(ErrorCode.RATE_LIMITED);
    expect(error.detail).toEqual({ retryAfterMs: 30_000 });
  });

  it('falls back to the status when a newer server sends a code this build does not know', () => {
    const error = errorFromResponse(json(403, { error: { code: 'quota_exhausted', message: 'x' } }), 'GET /me');
    expect(error.code).toBe(ErrorCode.FORBIDDEN);
    expect(error.status).toBe(403);
  });

  it('turns an HTML proxy error page into a typed error rather than a JSON parse crash', async () => {
    const { api } = harness(() => text(502, '<html><body><h1>502 Bad Gateway</h1></body></html>'));

    const error = await api.folders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalCastError);
    expect((error as LocalCastError).code).toBe(ErrorCode.INTERNAL);
    expect((error as LocalCastError).status).toBe(502);
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  it('turns a captive-portal interception (200 + HTML) into drift, not a parse crash', async () => {
    const { api } = harness(() => text(200, '<html>Sign in to Hotel WiFi</html>'));

    const error = await api.folders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaDriftError);
    expect((error as SchemaDriftError).message).toContain('was not JSON');
  });

  it('maps a bodyless 503 from the edge to a typed code', async () => {
    const { api } = harness(() => ({ status: 503, headers: {}, body: '' }));
    await expect(api.folders()).rejects.toMatchObject({ code: ErrorCode.EDGE_NOT_READY, status: 503 });
  });

  it('raises a drift error naming the missing field when a response loses one', async () => {
    // The server dropped `available` — exactly the kind of change that would otherwise
    // surface as an un-greyed folder whose every file 404s, three components away.
    const broken = { ...folder(), id: 'f1' } as Record<string, unknown>;
    delete broken['available'];
    const { api } = harness(() => json(200, { folders: [broken] }));

    const error = await api.folders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaDriftError);
    const drift = error as SchemaDriftError;
    expect(drift.route).toBe('GET /folders');
    expect(drift.issues.join(' ')).toContain('folders.0.available');
    expect(drift.message).toContain('does not match the contract');
  });

  it('raises drift when a field has the wrong type, not just when it is missing', async () => {
    const { api } = harness(() => json(200, { folders: [{ ...folder(), fileCount: 'lots' }] }));
    const error = await api.folders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaDriftError);
    expect((error as SchemaDriftError).issues.join(' ')).toContain('folders.0.fileCount');
  });
});
