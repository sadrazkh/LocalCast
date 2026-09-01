import { ApiException, ErrorCode, errorStatus } from '@localcast/contract';
import { ZodError } from 'zod';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from '../kernel.js';

/**
 * Express 4 does not await handlers, so a rejected promise from an `async` route disappears
 * and the request hangs until the client gives up. Every async handler is wrapped.
 */
export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out instanceof Promise) out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new ApiException(ErrorCode.NOT_FOUND, 'Not found'));
};

/**
 * Every failure crosses the wire as `{error: {code, message}}` with a stable machine code,
 * so a client never has to string-match on prose. Anything we did not classify becomes
 * `internal`: the stack goes to the log, never to the caller.
 */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      // Nothing useful can be said now — the status line is already on the wire. Tearing the
      // connection down tells the client the body is incomplete, which is the truth.
      log.warn('error after response started', { path: req.path, error: String(err) });
      res.destroy();
      return;
    }

    if (err instanceof ApiException) {
      if (err.code === ErrorCode.RATE_LIMITED || err.code === ErrorCode.PAIRING_LOCKED) {
        const retry = err.detail?.['retryAfterMs'];
        if (typeof retry === 'number') {
          res.setHeader('Retry-After', String(Math.ceil(retry / 1000)));
        }
      }
      res.status(err.status).json(err.toBody());
      return;
    }

    if (err instanceof ZodError) {
      res.status(errorStatus[ErrorCode.BAD_REQUEST]).json({
        error: {
          code: ErrorCode.BAD_REQUEST,
          message: 'Request did not match the expected shape',
          detail: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        },
      });
      return;
    }

    if (isBodyParserError(err)) {
      res.status(errorStatus[ErrorCode.BAD_REQUEST]).json({
        error: { code: ErrorCode.BAD_REQUEST, message: 'Malformed request body' },
      });
      return;
    }

    log.error('unhandled request error', {
      path: req.path,
      method: req.method,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    if (res.writableEnded) {
      next(err);
      return;
    }
    res.status(errorStatus[ErrorCode.INTERNAL]).json({
      error: { code: ErrorCode.INTERNAL, message: 'Internal server error' },
    });
  };
}

function isBodyParserError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof (err as { type: unknown }).type === 'string' &&
    ['entity.parse.failed', 'entity.too.large', 'encoding.unsupported'].includes(
      (err as { type: string }).type,
    )
  );
}
