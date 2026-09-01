import type { Entry, Folder, MediaKind } from '@localcast/contract';

/**
 * The contract between the Electron main process and the renderer of the **client** app.
 *
 * Read this next to `apps/desktop/src/shared/ipc.ts` and notice what is absent: there is no
 * operator surface here at all. This app browses somebody else's server. It cannot add a
 * shared folder, approve a device, edit a permission matrix or mint a pairing code, because
 * those endpoints are loopback-only on the machine that owns the files and this process is
 * not that machine. The narrowness is the security posture, not an oversight.
 *
 * Everything below is a thin projection of `@localcast/client-core`, which lives entirely in
 * the main process: that is where `safeStorage` exists (so the `TokenStore` can be DPAPI
 * ciphertext) and where a download can be streamed straight to disk without every byte
 * crossing the context bridge.
 */

export const IPC = {
  // servers (screen 05)
  serversList: 'servers:list',
  serversAdd: 'servers:add',
  serversRemove: 'servers:remove',
  serversConnect: 'servers:connect',
  serversForget: 'servers:forget',
  serversPair: 'servers:pair',
  serversSubscribe: 'servers:subscribe',
  serversEvent: 'servers:event',

  // library (screen 06)
  libraryFolders: 'library:folders',
  libraryEntries: 'library:entries',
  librarySearch: 'library:search',
  libraryFileMeta: 'library:file-meta',
  libraryMediaUrl: 'library:media-url',
  libraryDavUrl: 'library:dav-url',

  // transfers (screen 06)
  downloadsList: 'downloads:list',
  downloadsStart: 'downloads:start',
  downloadsPause: 'downloads:pause',
  downloadsResume: 'downloads:resume',
  downloadsCancel: 'downloads:cancel',
  downloadsReveal: 'downloads:reveal',
  downloadsSubscribe: 'downloads:subscribe',
  downloadsEvent: 'downloads:event',

  uploadsPick: 'uploads:pick',
  uploadsStart: 'uploads:start',
  uploadsList: 'uploads:list',
  uploadsCancel: 'uploads:cancel',
  uploadsSubscribe: 'uploads:subscribe',
  uploadsEvent: 'uploads:event',

  // app
  appInfo: 'app:info',
  appOpenExternal: 'app:open-external',
} as const;

/**
 * What screen 05 shows against each row.
 *
 * `needs-pairing` is a distinct state from `offline` on purpose: one is fixed by typing a
 * four-character code, the other by turning the other machine on. A single "not working"
 * state would send the user to the wrong remedy.
 */
export type ServerState = 'paired' | 'needs-pairing' | 'offline';

/** The three values the dot may take. Identical to `client-core`'s `ConnectionState`. */
export type ServerConnection = 'connected' | 'connecting' | 'offline';

export interface ServerSummary {
  id: string;
  /** What the user named it, or the host's first label until they rename it. */
  label: string;
  /** MagicDNS FQDN. Never a bare IP — a bare IP cannot hold a Let's Encrypt certificate. */
  host: string;
  baseUrl: string;
  state: ServerState;
  connection: ServerConnection;
  /** Non-null only once this machine has been approved by that server's operator. */
  deviceId: string | null;
  addedAt: number;
  lastConnectedAt: number | null;
  /** Set when the last attempt failed for a reason the user can act on. */
  lastErrorCode: string | null;
}

export interface AddServerInput {
  host: string;
  label?: string;
}

export interface PairInput {
  serverId: string;
  /** The four characters the operator read off their panel. Normalised before sending. */
  code: string;
  deviceName: string;
}

export interface PairResult {
  ok: boolean;
  server: ServerSummary;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface EntriesPage {
  folder: Folder;
  path: string;
  entries: Entry[];
  nextCursor: string | null;
}

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled';

export interface DownloadJob {
  id: string;
  serverId: string;
  fileId: string;
  fileName: string;
  kind: MediaKind;
  /** Absolute path of the finished file. While running, `${destination}.lcpart` holds bytes. */
  destination: string;
  receivedBytes: number;
  /** `null` until the first response tells us how big the file is. */
  totalBytes: number | null;
  status: DownloadStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface UploadJob {
  id: string;
  serverId: string;
  folderId: string;
  /** POSIX-separated, relative to the folder root — what the server will call it. */
  relativePath: string;
  sourcePath: string;
  sentBytes: number;
  totalBytes: number;
  status: UploadStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface ClientAppInfo {
  version: string;
  locale: 'fa' | 'en';
  /** Where downloads land. Shown in the transfers panel so it is never a mystery. */
  downloadDir: string;
  /** Name this machine offers when pairing; the operator sees it in their device list. */
  deviceName: string;
}

/**
 * The bridge, method by method.
 *
 * There is deliberately no `invoke(channel, ...args)` here. A generic forwarder would hand
 * every channel this process registers to anything that manages to run in the renderer, and
 * some of those channels write files to the user's disk.
 */
export interface DesktopClientApi {
  servers: {
    list(): Promise<ServerSummary[]>;
    add(input: AddServerInput): Promise<ServerSummary>;
    remove(serverId: string): Promise<void>;
    /** Bring the client up: start its event stream and refresh its session. */
    connect(serverId: string): Promise<ServerSummary>;
    /** Drop the stored session but keep the server in the list. */
    forget(serverId: string): Promise<ServerSummary>;
    pair(input: PairInput): Promise<PairResult>;
    onChange(handler: (servers: ServerSummary[]) => void): () => void;
  };
  library: {
    folders(serverId: string): Promise<Folder[]>;
    entries(
      serverId: string,
      folderId: string,
      options?: { path?: string; cursor?: string; limit?: number },
    ): Promise<EntriesPage>;
    search(
      serverId: string,
      query: string,
      options?: { folderId?: string; cursor?: string; limit?: number },
    ): Promise<{ results: Entry[]; nextCursor: string | null }>;
    fileMeta(serverId: string, fileId: string): Promise<Entry>;
    /**
     * The URL for a `<video src>`. It carries no credential: the main process attaches the
     * bearer to requests for this prefix, which is the desktop's equivalent of the PWA's
     * service worker.
     */
    mediaUrl(serverId: string, fileId: string): Promise<string>;
    /**
     * The WebDAV URL for the native-player handoff, with the DAV password embedded — VLC
     * accepts a URL and nothing else. Only ever fetched at the moment the user asks for it.
     */
    davUrl(serverId: string, folderId: string, path: string): Promise<string>;
  };
  downloads: {
    list(): Promise<DownloadJob[]>;
    start(input: { serverId: string; fileId: string }): Promise<DownloadJob>;
    pause(jobId: string): Promise<void>;
    resume(jobId: string): Promise<DownloadJob>;
    cancel(jobId: string): Promise<void>;
    reveal(jobId: string): Promise<void>;
    onChange(handler: (jobs: DownloadJob[]) => void): () => void;
  };
  uploads: {
    /** Opens the OS file picker. Returns absolute paths, or an empty array if cancelled. */
    pick(): Promise<string[]>;
    start(input: { serverId: string; folderId: string; sourcePaths: string[] }): Promise<UploadJob[]>;
    list(): Promise<UploadJob[]>;
    cancel(jobId: string): Promise<void>;
    onChange(handler: (jobs: UploadJob[]) => void): () => void;
  };
  app: {
    info(): Promise<ClientAppInfo>;
    openExternal(url: string): Promise<void>;
  };
}

declare global {
  interface Window {
    localcastClient: DesktopClientApi;
  }
}
