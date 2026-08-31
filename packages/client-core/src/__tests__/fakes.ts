import type {
  CacheEntry,
  CacheStore,
  Clock,
  HttpTransport,
  StoredSession,
  TokenStore,
  TransportRequest,
  TransportResponse,
} from '../ports.js';

export const BASE_URL = 'https://ali-pc.tail1234.ts.net';

export class FakeClock implements Clock {
  constructor(private t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class MemoryTokenStore implements TokenStore {
  readonly writes: StoredSession[] = [];
  clears = 0;
  #session: StoredSession | null;

  constructor(session: StoredSession | null = null) {
    this.#session = session;
  }

  async read(): Promise<StoredSession | null> {
    return this.#session;
  }
  async write(session: StoredSession): Promise<void> {
    this.writes.push(session);
    this.#session = session;
  }
  async clear(): Promise<void> {
    this.clears += 1;
    this.#session = null;
  }
  peek(): StoredSession | null {
    return this.#session;
  }
}

export type Handler = (
  request: TransportRequest,
) => TransportResponse | Promise<TransportResponse>;

export class FakeTransport implements HttpTransport {
  readonly requests: TransportRequest[] = [];
  handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return this.handler(request);
  }

  countMatching(fragment: string): number {
    return this.requests.filter((r) => r.url.includes(fragment)).length;
  }

  matching(fragment: string): TransportRequest[] {
    return this.requests.filter((r) => r.url.includes(fragment));
  }
}

export function json(status: number, body: unknown): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

export function text(status: number, body: string, contentType = 'text/html'): TransportResponse {
  return { status, headers: { 'content-type': contentType }, body };
}

export function apiError(status: number, code: string, message = 'nope'): TransportResponse {
  return json(status, { error: { code, message } });
}

export function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    deviceId: 'dev-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1_700_000_000_000 + 60 * 60_000,
    host: 'ali-pc.tail1234.ts.net',
    davPassword: 'dav-secret',
    ...overrides,
  };
}

export function bearerOf(request: TransportRequest): string | null {
  const header = request.headers?.['authorization'];
  return header === undefined ? null : header.replace(/^Bearer /, '');
}

export class MemoryCacheStore implements CacheStore {
  readonly entries = new Map<string, CacheEntry>();

  async read(key: string): Promise<CacheEntry | null> {
    return this.entries.get(key) ?? null;
  }
  async write(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
  async clear(): Promise<void> {
    this.entries.clear();
  }
}

/** A folder that satisfies `folderSchema`, for happy-path responses. */
export function folder(id = 'f1') {
  return {
    id,
    label: 'فیلم‌ها',
    kind: 'video',
    mode: 'full',
    writable: false,
    available: true,
    fileCount: 12,
    totalBytes: 1234,
    lastIndexedAt: 1_700_000_000_000,
  };
}
