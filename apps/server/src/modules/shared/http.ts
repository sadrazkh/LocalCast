import type { Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { ApiException, ErrorCode } from '@localcast/contract';
import type { AuthenticatedRequest, DeviceIdentity, Logger } from '../../kernel.js';

/**
 * Modules answer their own errors instead of relying on a core error middleware.
 *
 * Two reasons. A module has to be mountable on a bare Express app inside its own tests —
 * that is the whole point of the kernel seam. And the WebDAV surface answers in a different
 * dialect (Basic-auth challenges, `405` with `Allow`, `207` XML) that a JSON error handler
 * would mangle on the way out.
 */
export function sendApiError(res: Response, err: unknown, log?: Logger): void {
  const api = toApiException(err);
  if (api.code === ErrorCode.INTERNAL) {
    log?.error('module request failed', { error: describe(err) });
  }
  if (res.headersSent) {
    // Bytes are already on the wire. Appending a JSON error to half a video would corrupt
    // it silently; cutting the connection at least tells the client something went wrong.
    res.destroy();
    return;
  }
  res.status(api.status).json(api.toBody());
}

export function toApiException(err: unknown): ApiException {
  if (err instanceof ApiException) return err;
  return new ApiException(ErrorCode.INTERNAL, 'Unexpected server error.');
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Wraps an async handler so a rejected promise becomes a typed error response rather than an
 * unhandled rejection that takes the process down.
 */
export function asyncRoute(
  handler: (req: AuthenticatedRequest, res: Response) => Promise<void> | void,
  log?: Logger,
): RequestHandler {
  return (req, res) => {
    void (async () => {
      try {
        await handler(req as AuthenticatedRequest, res);
      } catch (err) {
        sendApiError(res, err, log);
      }
    })();
  };
}

/**
 * Core installs the auth middleware before it calls `register`, so `req.device` is present on
 * everything under the API prefix. This still checks, because a module that is mounted wrong
 * must fail with 401 rather than read `undefined.id`.
 */
export function deviceOf(req: Request): DeviceIdentity {
  const device = (req as Partial<AuthenticatedRequest>).device;
  if (!device || typeof device.id !== 'string') {
    throw new ApiException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
  }
  return device;
}

/**
 * Validates against a contract schema and reports the failures as structured detail.
 *
 * Typed on the schema rather than on its output: several contract schemas apply `.default()`,
 * so their input and output types differ, and pinning the two together would make the
 * defaulted fields optional at every call site that has already been through `safeParse`.
 */
export function parseWith<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  what: string,
): S['_output'] {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiException(ErrorCode.BAD_REQUEST, `Invalid ${what}.`, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

/** Reads a positive integer from a header or query parameter; `null` when absent. */
export function readInt(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}
