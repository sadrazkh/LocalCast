import { EDGE_SECRET_HEADER } from '@localcast/contract';

/**
 * Talks to the server's operator API over loopback.
 *
 * The main process could reach into the `ServerContext` directly, but going through the same
 * HTTP surface the spec defines means there is exactly one implementation of every operator
 * action, with one set of validation and one audit trail — and it keeps the door open for a
 * future remote admin surface without a second code path appearing.
 */
export class OperatorClient {
  constructor(
    private readonly port: number,
    private readonly edgeSecret: string,
  ) {}

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    // The server mounts this router at OPERATOR_PREFIX, which is `/operator` with no version
    // segment — it is loopback-only and ships with the app, so it has no independent
    // lifetime to version against.
    const res = await fetch(`http://127.0.0.1:${this.port}/operator${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        [EDGE_SECRET_HEADER]: this.edgeSecret,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (res.status === 204) return undefined as T;

    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      // The server speaks the contract's typed error envelope; surface its message so the
      // panel can show something specific instead of "something went wrong".
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: { message?: unknown } }).error?.message ?? res.statusText)
          : res.statusText;
      throw new Error(message);
    }
    return payload as T;
  }

  get<T>(path: string): Promise<T> {
    return this.#call<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.#call<T>('POST', path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.#call<T>('PATCH', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.#call<T>('DELETE', path);
  }
}
