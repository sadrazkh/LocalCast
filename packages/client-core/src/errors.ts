import { ErrorCode, apiErrorSchema } from '@localcast/contract';
import type { ZodError, ZodType } from 'zod';
import type { TransportResponse } from './ports.js';

/**
 * Every failure a client can observe, carrying a stable `ErrorCode` from the contract.
 *
 * The rule the whole package obeys: **branch on `code`, never on `message`.** `message` is
 * prose, is already localised by the server, and may be reworded at any time. A client that
 * matches on it breaks silently the first time someone improves the wording.
 */
export class LocalCastError extends Error {
  readonly code: ErrorCode;
  /** HTTP status when a server actually answered; `null` when nothing came back at all. */
  readonly status: number | null;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number | null; detail?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LocalCastError';
    this.code = code;
    this.status = options.status ?? null;
    this.detail = options.detail;
  }
}

/**
 * The request never reached a server, or the answer was cut off mid-flight. Distinct from a
 * 5xx: nobody replied, so retrying is reasonable and the connection dot should notice.
 */
export class NetworkError extends LocalCastError {
  constructor(message: string, cause?: unknown) {
    super(ErrorCode.INTERNAL, message, { cause });
    this.name = 'NetworkError';
  }
}

/**
 * The server answered, the answer was well-formed JSON, and it did not match the schema the
 * contract says it must. This is server/client drift and it must fail loudly here, at the
 * boundary, rather than as `undefined is not an object` four components deeper.
 */
export class SchemaDriftError extends LocalCastError {
  readonly route: string;
  readonly issues: string[];

  constructor(route: string, reason: string, issues: string[] = []) {
    const tail = issues.length > 0 ? ` (${issues.join('; ')})` : '';
    super(ErrorCode.INTERNAL, `${route}: ${reason}${tail}`, { status: null });
    this.name = 'SchemaDriftError';
    this.route = route;
    this.issues = issues;
  }
}

/** The caller's `AbortSignal` fired. Not a server condition, so no wire code describes it. */
export class CancelledError extends LocalCastError {
  constructor(route: string) {
    super(ErrorCode.INTERNAL, `${route}: cancelled`);
    this.name = 'CancelledError';
  }
}

export function isCancelled(error: unknown): error is CancelledError {
  return error instanceof CancelledError;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(Object.values(ErrorCode));

export function isErrorCode(value: string): value is ErrorCode {
  return KNOWN_CODES.has(value);
}

/**
 * Codes after which retrying is pointless and the device must be signed out. Both mean an
 * operator has closed this device in the panel; the spec is explicit that permissions are
 * read per request, so there is nothing to wait for.
 */
const REVOCATION_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.TOKEN_REVOKED,
  ErrorCode.DEVICE_REVOKED,
]);

export function isRevocation(code: ErrorCode): boolean {
  return REVOCATION_CODES.has(code);
}

/** Codes that mean "this access token is stale, refresh and try once more". */
const REFRESHABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.TOKEN_EXPIRED,
  ErrorCode.UNAUTHENTICATED,
]);

export function isRefreshable(code: ErrorCode): boolean {
  return REFRESHABLE_CODES.has(code);
}

/**
 * Fallback when the body carried no usable code: a reverse proxy, a captive portal or a
 * gateway answered instead of LocalCast. Status is all we have, so map it and move on.
 */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.BAD_REQUEST;
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 413:
      return ErrorCode.UPLOAD_TOO_LARGE;
    case 415:
      return ErrorCode.UNPRINTABLE_TYPE;
    case 416:
      return ErrorCode.RANGE_NOT_SATISFIABLE;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 503:
      return ErrorCode.EDGE_NOT_READY;
    default:
      return ErrorCode.INTERNAL;
  }
}

/** `JSON.parse` that reports failure instead of throwing. */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function summariseIssues(error: ZodError): string[] {
  // Five is enough to identify the drift; a hundred issues in one message helps nobody.
  return error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Turn any non-2xx response into a typed error.
 *
 * A LocalCast server always sends `{error:{code,message}}`. Anything else on this path —
 * an nginx 502 page, an HTML captive-portal interception on hotel wifi, a truncated body —
 * must still come out of here as a typed error, never as a `JSON.parse` crash.
 */
export function errorFromResponse(response: TransportResponse, route: string): LocalCastError {
  const parsed = tryParseJson(response.body);
  if (parsed.ok) {
    const envelope = apiErrorSchema.safeParse(parsed.value);
    if (envelope.success) {
      const { code, message, detail } = envelope.data.error;
      // An unknown code from a newer server still has a usable status; do not throw it away.
      const known = isErrorCode(code) ? code : codeForStatus(response.status);
      return new LocalCastError(known, message, { status: response.status, detail });
    }
  }
  const code = codeForStatus(response.status);
  const shape = parsed.ok ? 'an unexpected JSON shape' : 'a non-JSON body';
  return new LocalCastError(
    code,
    `${route}: the server answered ${response.status} with ${shape}`,
    { status: response.status },
  );
}

/** Parse a value against a contract schema, or fail loudly with the exact drift. */
export function decode<T>(schema: ZodType<T>, value: unknown, route: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new SchemaDriftError(route, 'response does not match the contract', summariseIssues(result.error));
}

/**
 * Decode a successful response body. A 2xx whose body is not JSON is drift too — it means
 * something in front of the server rewrote the answer.
 */
export function decodeJson<T>(schema: ZodType<T>, response: TransportResponse, route: string): T {
  const parsed = tryParseJson(response.body);
  if (!parsed.ok) throw new SchemaDriftError(route, 'response body was not JSON');
  return decode(schema, parsed.value, route);
}
