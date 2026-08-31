import { z } from 'zod';

/**
 * Stable machine-readable error codes. Clients branch on these; they never string-match on
 * `message`, which is prose and may be translated or reworded at any time.
 */
export const ErrorCode = {
  // auth / pairing
  UNAUTHENTICATED: 'unauthenticated',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_REVOKED: 'token_revoked',
  DEVICE_PENDING: 'device_pending',
  DEVICE_REVOKED: 'device_revoked',
  PAIRING_INVALID: 'pairing_invalid',
  PAIRING_EXPIRED: 'pairing_expired',
  PAIRING_CONSUMED: 'pairing_consumed',
  PAIRING_LOCKED: 'pairing_locked',
  RATE_LIMITED: 'rate_limited',

  // authorization
  FORBIDDEN: 'forbidden',
  FOLDER_CLOSED: 'folder_closed',
  DOWNLOAD_NOT_ALLOWED: 'download_not_allowed',
  PRINT_NOT_ALLOWED: 'print_not_allowed',
  UPLOAD_NOT_ALLOWED: 'upload_not_allowed',

  // resources
  NOT_FOUND: 'not_found',
  FOLDER_UNAVAILABLE: 'folder_unavailable',
  PATH_ESCAPES_ROOT: 'path_escapes_root',
  RANGE_NOT_SATISFIABLE: 'range_not_satisfiable',

  // print
  PRINTER_NOT_FOUND: 'printer_not_found',
  PRINTER_DISABLED: 'printer_disabled',
  UNPRINTABLE_TYPE: 'unprintable_type',
  SPOOLER_FAILED: 'spooler_failed',

  // upload
  UPLOAD_SESSION_UNKNOWN: 'upload_session_unknown',
  UPLOAD_OFFSET_MISMATCH: 'upload_offset_mismatch',
  UPLOAD_TOO_LARGE: 'upload_too_large',

  // network edge
  EDGE_NOT_READY: 'edge_not_ready',
  EDGE_LOGIN_REQUIRED: 'edge_login_required',
  EDGE_CERT_UNAVAILABLE: 'edge_cert_unavailable',
  EDGE_CONTROL_UNREACHABLE: 'edge_control_unreachable',
  EDGE_MODE_UNSUPPORTED: 'edge_mode_unsupported',

  // generic
  BAD_REQUEST: 'bad_request',
  INTERNAL: 'internal',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Optional structured payload, e.g. `{ retryAfterMs: 30000 }` for RATE_LIMITED. */
    detail: z.record(z.unknown()).optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** HTTP status each code is served with. Kept here so server and tests agree. */
export const errorStatus: Record<ErrorCode, number> = {
  unauthenticated: 401,
  token_expired: 401,
  token_revoked: 401,
  device_pending: 403,
  device_revoked: 403,
  pairing_invalid: 400,
  pairing_expired: 410,
  pairing_consumed: 409,
  pairing_locked: 429,
  rate_limited: 429,
  forbidden: 403,
  folder_closed: 404,
  download_not_allowed: 403,
  print_not_allowed: 403,
  upload_not_allowed: 403,
  not_found: 404,
  folder_unavailable: 503,
  path_escapes_root: 400,
  range_not_satisfiable: 416,
  printer_not_found: 404,
  printer_disabled: 403,
  unprintable_type: 415,
  spooler_failed: 502,
  upload_session_unknown: 404,
  upload_offset_mismatch: 409,
  upload_too_large: 413,
  edge_not_ready: 503,
  edge_login_required: 503,
  edge_cert_unavailable: 503,
  edge_control_unreachable: 502,
  edge_mode_unsupported: 400,
  bad_request: 400,
  internal: 500,
};

/**
 * A `none` folder must be indistinguishable from a folder that does not exist, so callers
 * cannot probe the permission matrix. `FOLDER_CLOSED` is therefore served as 404 and the
 * message must not reveal that the folder exists.
 */
export class ApiException extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiException';
  }

  get status(): number {
    return errorStatus[this.code];
  }

  toBody(): ApiError {
    return { error: { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) } };
  }
}
