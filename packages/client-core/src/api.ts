import {
  API_PREFIX,
  DAV_PREFIX,
  ErrorCode,
  entriesResponseSchema,
  entrySchema,
  folderSchema,
  meResponseSchema,
  pairClaimResponseSchema,
  pairStatusResponseSchema,
  printJobSchema,
  printerSchema,
  searchResponseSchema,
  uploadSessionSchema,
} from '@localcast/contract';
import type {
  Entry,
  Folder,
  PairClaimRequest,
  PrintJob,
  PrintRequest,
  Printer,
  UploadSession,
} from '@localcast/contract';
import { z } from 'zod';
import {
  decodeJson,
  errorFromResponse,
  isCancelled,
  isRefreshable,
  isRevocation,
  LocalCastError,
} from './errors.js';
import { encodePath, isSuccess, JSON_HEADERS, normaliseBaseUrl, send, withQuery } from './http.js';
import type { HttpTransport, Logger, TransportRequest } from './ports.js';
import type { SessionManager } from './session.js';

/**
 * Collection envelopes.
 *
 * `packages/contract` defines every *element* shape; the three list routes that return a
 * bare collection are wrapped here rather than re-declared, so a field can only ever be
 * described in one place. If the server later publishes envelopes of its own, these are
 * deleted and the contract's are imported — nothing else in the package changes.
 */
const foldersResponseSchema = z.object({ folders: z.array(folderSchema) });
const printersResponseSchema = z.object({ printers: z.array(printerSchema) });
const printJobsResponseSchema = z.object({ jobs: z.array(printJobSchema) });

export interface ApiClientOptions {
  transport: HttpTransport;
  session: SessionManager;
  baseUrl: string;
  logger?: Logger;
  /**
   * Called once per request with whether a server answered at all. This is what drives the
   * connection dot: a 403 still means we reached LocalCast, a `NetworkError` does not.
   */
  onOutcome?: (reachedServer: boolean) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface PageOptions extends RequestOptions {
  cursor?: string;
  limit?: number;
}

export interface EntriesOptions extends PageOptions {
  /** POSIX-separated, relative to the folder root. Empty means the root itself. */
  path?: string;
}

export interface SearchOptions extends PageOptions {
  /** Narrow to one folder; omitted, the server searches every folder this device may list. */
  folderId?: string;
}

export interface DavUrlOptions {
  /**
   * Embed Basic-auth credentials in the URL.
   *
   * VLC and Infuse are handed a URL and nothing else — they cannot be given a bearer token,
   * which is exactly why the WebDAV mount has its own password. Off by default so a URL
   * built for display or logging never carries one.
   */
  credentials?: { deviceId: string; davPassword: string };
}

export interface ContentUrlOptions {
  /**
   * Ask for `Content-Disposition: attachment`. Refused by the server in `stream` mode; the
   * client should not offer the affordance there in the first place.
   */
  download?: boolean;
}

/**
 * One method per route in spec section 4.1, each one parsing its response with the schema the
 * contract publishes. Drift therefore fails here, at the boundary, with the field name in the
 * message — not as an `undefined` read inside a component that renders it.
 */
export class ApiClient {
  readonly #transport: HttpTransport;
  readonly #session: SessionManager;
  readonly #baseUrl: string;
  readonly #logger: Logger | undefined;
  readonly #onOutcome: ((reachedServer: boolean) => void) | undefined;

  constructor(options: ApiClientOptions) {
    this.#transport = options.transport;
    this.#session = options.session;
    this.#baseUrl = normaliseBaseUrl(options.baseUrl);
    this.#logger = options.logger;
    this.#onOutcome = options.onOutcome;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  // ─── URL builders ───────────────────────────────────────────────────────────
  //
  // These return a URL instead of a body because their consumers are not this library. A
  // `<video>` element streams from a URL, and the native-player handoff hands a URL to VLC.
  // Fetching the bytes here and re-serving them would defeat Range seeking entirely.

  /**
   * The Range endpoint. Note this URL carries no credential: a `<video src>` cannot set an
   * `Authorization` header. On the web the service worker attaches the bearer to requests
   * under this prefix; on a native client the player is handed `davUrl()` with credentials.
   */
  contentUrl(fileId: string, options: ContentUrlOptions = {}): string {
    const url = `${this.#baseUrl}${API_PREFIX}/files/${encodeURIComponent(fileId)}/content`;
    // `download=1` rather than an absent parameter: the server treats a rangeless GET as a
    // download anyway, so the flag exists to make the intent explicit for a request that
    // does carry a Range — and it is refused in `stream` mode either way.
    return options.download === true ? withQuery(url, { download: '1' }) : url;
  }

  /** The read-only WebDAV path for a file, for the "باز در پلیر بومی" handoff. */
  davUrl(folderId: string, path: string, options: DavUrlOptions = {}): string {
    const suffix = `${DAV_PREFIX}/${encodeURIComponent(folderId)}/${encodePath(path)}`;
    const credentials = options.credentials;
    if (credentials === undefined) return `${this.#baseUrl}${suffix}`;
    const marker = '://';
    const split = this.#baseUrl.indexOf(marker);
    if (split < 0) return `${this.#baseUrl}${suffix}`;
    const scheme = this.#baseUrl.slice(0, split + marker.length);
    const authority = this.#baseUrl.slice(split + marker.length);
    const user = encodeURIComponent(credentials.deviceId);
    const password = encodeURIComponent(credentials.davPassword);
    return `${scheme}${user}:${password}@${authority}${suffix}`;
  }

  // ─── pairing (unauthenticated: there is no token yet) ───────────────────────

  async claimPairing(body: PairClaimRequest, options: RequestOptions = {}) {
    return this.#anonymous(pairClaimResponseSchema, 'POST /pair/claim', {
      url: `${this.#baseUrl}${API_PREFIX}/pair/claim`,
      method: 'POST',
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  /**
   * Poll until the operator approves. The claim ticket travels as a query parameter because
   * this request has no token yet and the ticket is the only thing identifying the poller;
   * it is a one-shot handle, useless for anything but this poll.
   */
  async pairingStatus(deviceId: string, claimTicket: string, options: RequestOptions = {}) {
    const url = withQuery(
      `${this.#baseUrl}${API_PREFIX}/pair/status/${encodeURIComponent(deviceId)}`,
      { ticket: claimTicket },
    );
    return this.#anonymous(pairStatusResponseSchema, 'GET /pair/status/:id', {
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
  }

  /**
   * Force a token refresh. Delegates to the session manager so it goes through the same
   * single-flight gate as every implicit refresh — calling this concurrently with in-flight
   * requests must not produce a second rotation.
   */
  async refresh() {
    const session = await this.#session.load();
    if (session === null) {
      throw new LocalCastError(ErrorCode.UNAUTHENTICATED, 'this device is not paired');
    }
    const refreshed = await this.#session.refreshAfter(session.accessToken);
    if (refreshed === null) {
      throw new LocalCastError(ErrorCode.UNAUTHENTICATED, 'this device is not paired');
    }
    return refreshed;
  }

  // ─── identity and library ───────────────────────────────────────────────────

  async me(options: RequestOptions = {}) {
    return this.#authed(meResponseSchema, 'GET /me', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/me`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
  }

  async folders(options: RequestOptions = {}): Promise<Folder[]> {
    const result = await this.#authed(foldersResponseSchema, 'GET /folders', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/folders`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
    return result.folders;
  }

  async entries(folderId: string, options: EntriesOptions = {}) {
    const url = withQuery(
      `${this.#baseUrl}${API_PREFIX}/folders/${encodeURIComponent(folderId)}/entries`,
      { path: options.path, cursor: options.cursor, limit: options.limit },
    );
    return this.#authed(entriesResponseSchema, 'GET /folders/:id/entries', () => ({
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
  }

  async search(query: string, options: SearchOptions = {}) {
    const url = withQuery(`${this.#baseUrl}${API_PREFIX}/search`, {
      q: query,
      folderId: options.folderId,
      cursor: options.cursor,
      limit: options.limit,
    });
    return this.#authed(searchResponseSchema, 'GET /search', () => ({
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
  }

  async fileMeta(fileId: string, options: RequestOptions = {}): Promise<Entry> {
    return this.#authed(entrySchema, 'GET /files/:id/meta', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/files/${encodeURIComponent(fileId)}/meta`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
  }

  // ─── printing ───────────────────────────────────────────────────────────────

  async printers(options: RequestOptions = {}): Promise<Printer[]> {
    const result = await this.#authed(printersResponseSchema, 'GET /printers', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/printers`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
    return result.printers;
  }

  async print(request: PrintRequest, options: RequestOptions = {}): Promise<PrintJob> {
    return this.#authed(printJobSchema, 'POST /print', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/print`,
      method: 'POST',
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(request),
      signal: options.signal,
    }));
  }

  async printJobs(options: PageOptions = {}): Promise<PrintJob[]> {
    const url = withQuery(`${this.#baseUrl}${API_PREFIX}/print/jobs`, {
      cursor: options.cursor,
      limit: options.limit,
    });
    const result = await this.#authed(printJobsResponseSchema, 'GET /print/jobs', () => ({
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
    return result.jobs;
  }

  async printJob(jobId: string, options: RequestOptions = {}): Promise<PrintJob> {
    return this.#authed(printJobSchema, 'GET /print/jobs/:id', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/print/jobs/${encodeURIComponent(jobId)}`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
  }

  // ─── uploads (surface 4: the phone pushes, it never hosts) ──────────────────

  async createUpload(
    request: { folderId: string; relativePath: string; totalBytes: number; mtime?: number },
    options: RequestOptions = {},
  ): Promise<UploadSession> {
    return this.#authed(uploadSessionSchema, 'POST /uploads', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/uploads`,
      method: 'POST',
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(request),
      signal: options.signal,
    }));
  }

  /**
   * Append one chunk. The offset is sent explicitly rather than inferred, so a chunk replayed
   * after a dropped connection is rejected with `upload_offset_mismatch` instead of being
   * appended twice — a resumable upload that silently duplicates 4 MB is worse than one that
   * fails.
   */
  async patchUpload(
    uploadId: string,
    offset: number,
    chunk: Uint8Array,
    options: RequestOptions = {},
  ): Promise<UploadSession> {
    return this.#authed(uploadSessionSchema, 'PATCH /uploads/:id', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/uploads/${encodeURIComponent(uploadId)}`,
      method: 'PATCH',
      headers: {
        'content-type': 'application/octet-stream',
        accept: 'application/json',
        'upload-offset': String(offset),
      },
      body: chunk,
      signal: options.signal,
    }));
  }

  async upload(uploadId: string, options: RequestOptions = {}): Promise<UploadSession> {
    return this.#authed(uploadSessionSchema, 'GET /uploads/:id', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/uploads/${encodeURIComponent(uploadId)}`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
  }

  /** Abandon a session. A 204 with no body is the expected answer, hence the tolerant schema. */
  async deleteUpload(uploadId: string, options: RequestOptions = {}): Promise<void> {
    await this.#authed(z.unknown(), 'DELETE /uploads/:id', () => ({
      url: `${this.#baseUrl}${API_PREFIX}/uploads/${encodeURIComponent(uploadId)}`,
      method: 'DELETE',
      headers: { accept: 'application/json' },
      signal: options.signal,
    }));
  }

  // ─── plumbing ───────────────────────────────────────────────────────────────

  async #anonymous<T>(
    schema: z.ZodType<T>,
    route: string,
    request: TransportRequest,
  ): Promise<T> {
    const response = await this.#sendCounted(request, route);
    if (!isSuccess(response.status)) throw errorFromResponse(response, route);
    return decodeJson(schema, response, route);
  }

  /**
   * Send with a bearer, and retry exactly once behind a single-flight refresh when the server
   * says the token is stale. Once, not in a loop: a second 401 after a fresh token means the
   * server is rejecting us for a reason a third attempt will not fix.
   */
  async #authed<T>(
    schema: z.ZodType<T>,
    route: string,
    build: () => TransportRequest,
  ): Promise<T> {
    const session = await this.#session.ensureFresh();
    if (session === null) {
      throw new LocalCastError(ErrorCode.UNAUTHENTICATED, `${route}: this device is not paired`);
    }

    const first = build();
    let response = await this.#sendCounted(
      { ...first, headers: this.#session.authorize(first.headers ?? {}, session.accessToken) },
      route,
    );

    if (response.status === 401 || response.status === 403) {
      const error = errorFromResponse(response, route);
      if (isRevocation(error.code)) {
        // No retry: an operator closed this device. Clear and surface `signed-out`.
        await this.#session.noteError(error);
        throw error;
      }
      if (response.status === 401 && isRefreshable(error.code)) {
        const refreshed = await this.#session.refreshAfter(session.accessToken);
        if (refreshed !== null) {
          const retry = build();
          response = await this.#sendCounted(
            { ...retry, headers: this.#session.authorize(retry.headers ?? {}, refreshed.accessToken) },
            route,
          );
        }
      }
    }

    if (!isSuccess(response.status)) {
      const error = errorFromResponse(response, route);
      await this.#session.noteError(error);
      throw error;
    }
    return decodeJson(schema, response, route);
  }

  async #sendCounted(request: TransportRequest, route: string) {
    try {
      const response = await send(this.#transport, request, route);
      this.#onOutcome?.(true);
      return response;
    } catch (error) {
      // A request the caller cancelled says nothing about the network; only a real transport
      // failure is allowed to move the connection dot.
      if (!isCancelled(error)) {
        this.#onOutcome?.(false);
        this.#logger?.log('warn', 'request failed before reaching the server', { route });
      }
      throw error;
    }
  }
}
