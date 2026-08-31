import { CancelledError, NetworkError } from './errors.js';
import type { HttpTransport, TransportRequest, TransportResponse } from './ports.js';

/**
 * The one place a transport is actually invoked.
 *
 * Platforms throw wildly different things when a request fails — `TypeError: Failed to
 * fetch`, an `AbortError` `DOMException`, an OkHttp `IOException` bridged to who knows what.
 * Normalising here means nothing downstream ever inspects an exception's prose.
 */
export async function send(
  transport: HttpTransport,
  request: TransportRequest,
  route: string,
): Promise<TransportResponse> {
  try {
    return await transport.request(request);
  } catch (cause) {
    if (isAbort(cause, request.signal)) throw new CancelledError(route);
    throw new NetworkError(`${route}: the server could not be reached`, cause);
  }
}

export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (error instanceof CancelledError) return true;
  // `AbortError` is the name every platform agrees on, even when the class differs.
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Strip a trailing slash so `${base}${API_PREFIX}` never produces a double slash. */
export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Encode a path that may contain separators, preserving the separators. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function withQuery(url: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length > 0 ? `${url}?${query}` : url;
}

export const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  accept: 'application/json',
};
