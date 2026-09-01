import { z } from 'zod';
import { accessModeSchema, folderPermissionSchema } from './permissions.js';

export const API_PREFIX = '/api/v1';
export const DAV_PREFIX = '/dav';

/** Header `netedge` injects so the loopback server can prove a request came through the edge. */
export const EDGE_SECRET_HEADER = 'x-lc-edge-secret';
/**
 * Tailnet peer identity injected by `netedge`. In tailnet mode this is unforgeable and is
 * used as a rate-limit key. In Funnel mode it is the literal string `funnel`, because there
 * is no peer identity and per-IP limiting behind the relays limits nothing.
 */
export const EDGE_PEER_HEADER = 'x-lc-peer';
export const FUNNEL_PEER = 'funnel';

// ─── shared primitives ────────────────────────────────────────────────────────

export const platformSchema = z.enum(['ios-pwa', 'android-pwa', 'windows', 'web', 'webdav']);
export type Platform = z.infer<typeof platformSchema>;

export const mediaKindSchema = z.enum(['video', 'audio', 'image', 'document', 'archive', 'other']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const folderKindSchema = z.enum(['video', 'documents', 'photos', 'mixed']);

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

// ─── pairing ──────────────────────────────────────────────────────────────────

/**
 * A SHA-256 certificate fingerprint as OpenSSL and Node print it: 32 uppercase hex pairs
 * joined by colons. Constrained here rather than left as a free string so a client that pins
 * it never has to guess which of the four common spellings it received.
 */
export const fingerprintSha256Schema = z.string().regex(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);

/** Payload encoded into the QR code shown on screen 03. */
export const qrPayloadSchema = z.object({
  v: z.literal(1),
  /** MagicDNS FQDN, e.g. `ali-pc.tail1234.ts.net`. Never a bare IP. */
  host: z.string().min(1),
  /** Human fallback, 4 chars, unambiguous alphabet. */
  code: z.string().length(4),
  /** 32 random bytes, base64url. This is what makes the QR unguessable. */
  secret: z.string().min(32),
  /**
   * The absolute origin to connect to, when it is not simply `https://<host>`.
   *
   * Present in local-network mode, where the server listens on an ephemeral HTTPS port at a
   * bare IP: `https://192.168.1.50:8443`. A bare IP with a port cannot be spelled in `host`,
   * which is a MagicDNS name by contract and is validated as one. A client that understands
   * this field must prefer it over `host`.
   */
  url: z.string().url().optional(),
  /**
   * Fingerprint of the certificate `url` presents, when that certificate is the self-signed
   * one the server generated for the local network.
   *
   * A phone's browser cannot check this — it shows its warning and the person accepts it. A
   * native client can and must: pinning this exact certificate is the difference between
   * "encrypted to this computer" and "encrypted to whoever answered". Its presence is what
   * tells a client the certificate will not chain to a public root, so the absence of this
   * field must never be read as permission to skip verification.
   */
  fp: fingerprintSha256Schema.optional(),
});
export type QrPayload = z.infer<typeof qrPayloadSchema>;

export const pairClaimRequestSchema = z.object({
  code: z.string().length(4),
  /** Omitted when pairing by typed code; then only the rate-limited code guards entry. */
  secret: z.string().optional(),
  deviceName: z.string().min(1).max(64),
  platform: platformSchema,
});
export type PairClaimRequest = z.infer<typeof pairClaimRequestSchema>;

export const pairClaimResponseSchema = z.object({
  deviceId: z.string(),
  /** Opaque handle the device polls with; not a credential for anything else. */
  claimTicket: z.string(),
  status: z.enum(['pending', 'approved']),
});

export const pairStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('rejected') }),
  z.object({
    status: z.literal('approved'),
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number().int(),
    /** Generated once, shown once — the Basic-auth password for the WebDAV mount. */
    davPassword: z.string(),
    device: z.object({ id: z.string(), name: z.string() }),
  }),
]);

export const refreshRequestSchema = z.object({ refreshToken: z.string() });
export const refreshResponseSchema = z.object({
  accessToken: z.string(),
  /** Refresh tokens rotate: the old one is dead the moment this is issued. */
  refreshToken: z.string(),
  expiresAt: z.number().int(),
});

// ─── identity ─────────────────────────────────────────────────────────────────

export const meResponseSchema = z.object({
  device: z.object({
    id: z.string(),
    name: z.string(),
    platform: platformSchema,
    pairedAt: z.number().int(),
  }),
  server: z.object({
    name: z.string(),
    version: z.string(),
    /** The MagicDNS host clients should keep using; may change after a mode switch. */
    host: z.string(),
  }),
  permissions: z.array(folderPermissionSchema),
});

// ─── library ──────────────────────────────────────────────────────────────────

export const folderSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: folderKindSchema,
  mode: accessModeSchema,
  writable: z.boolean(),
  /** False when the drive is unplugged; the client greys it rather than hiding it. */
  available: z.boolean(),
  fileCount: z.number().int().nullable(),
  totalBytes: z.number().int().nullable(),
  lastIndexedAt: z.number().int().nullable(),
});
export type Folder = z.infer<typeof folderSchema>;

export const entrySchema = z.object({
  id: z.string(),
  folderId: z.string(),
  /** Always POSIX-separated and relative to the folder root, even on Windows. */
  path: z.string(),
  name: z.string(),
  isDir: z.boolean(),
  size: z.number().int().nullable(),
  mtime: z.number().int().nullable(),
  ext: z.string().nullable(),
  kind: mediaKindSchema,
  /** True when the print subsystem accepts this type: PDF and images only. */
  printable: z.boolean(),
  /**
   * True when Safari can play the file directly. False for MKV containers and for
   * H.265/AC3/DTS payloads — the player then offers the native-player WebDAV handoff
   * instead of showing a black box.
   */
  browserPlayable: z.boolean(),
});
export type Entry = z.infer<typeof entrySchema>;

export const entriesResponseSchema = z.object({
  folder: folderSchema,
  path: z.string(),
  entries: z.array(entrySchema),
  nextCursor: z.string().nullable(),
});

export const searchResponseSchema = z.object({
  results: z.array(entrySchema),
  nextCursor: z.string().nullable(),
});

// ─── printing ─────────────────────────────────────────────────────────────────

export const printerSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  colorCapable: z.boolean(),
  duplexCapable: z.boolean(),
  status: z.string(),
  online: z.boolean(),
});
export type Printer = z.infer<typeof printerSchema>;

export const printJobStatusSchema = z.enum(['queued', 'printing', 'done', 'error', 'cancelled']);
export type PrintJobStatus = z.infer<typeof printJobStatusSchema>;

export const printRequestSchema = z.object({
  printerId: z.string(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('library'), fileId: z.string() }),
    z.object({ kind: z.literal('upload'), uploadId: z.string() }),
  ]),
  copies: z.number().int().min(1).max(99).default(1),
  color: z.enum(['color', 'mono']).default('mono'),
  duplex: z.enum(['simplex', 'long', 'short']).default('simplex'),
  /** e.g. `1-4,7`. Empty means the whole document. */
  pageRange: z.string().optional(),
});
export type PrintRequest = z.infer<typeof printRequestSchema>;

export const printJobSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  printerName: z.string(),
  status: printJobStatusSchema,
  copies: z.number().int(),
  color: z.enum(['color', 'mono']),
  errorMessage: z.string().nullable(),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});
export type PrintJob = z.infer<typeof printJobSchema>;

// ─── uploads (surface 4: the phone pushes, it does not host) ──────────────────

export const uploadCreateRequestSchema = z.object({
  folderId: z.string(),
  /** POSIX-separated, relative; the server rejects anything that escapes the folder root. */
  relativePath: z.string().min(1),
  totalBytes: z.number().int().min(0),
  mtime: z.number().int().optional(),
});

export const uploadSessionSchema = z.object({
  id: z.string(),
  receivedBytes: z.number().int(),
  totalBytes: z.number().int(),
  chunkSize: z.number().int(),
  status: z.enum(['active', 'complete', 'aborted']),
});
export type UploadSession = z.infer<typeof uploadSessionSchema>;

// ─── operator API (loopback only — never reachable over the tailnet) ──────────

export const deviceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: platformSchema,
  status: z.enum(['pending', 'active', 'revoked']),
  lastSeenAt: z.number().int().nullable(),
  pairingCode: z.string().nullable(),
  permissions: z.array(folderPermissionSchema),
});
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const addFolderRequestSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1).max(64),
  kind: folderKindSchema.default('mixed'),
  writable: z.boolean().default(false),
  autoIndex: z.boolean().default(true),
});

export const setPermissionsRequestSchema = z.object({
  deviceId: z.string(),
  permissions: z.array(folderPermissionSchema),
});

export const mintPairingRequestSchema = z.object({
  /** Applied to the device the moment the operator approves it. */
  defaultPermissions: z.array(folderPermissionSchema).default([]),
  ttlSeconds: z.number().int().min(60).max(3600).default(300),
});

export const mintPairingResponseSchema = z.object({
  code: z.string().length(4),
  qr: qrPayloadSchema,
  expiresAt: z.number().int(),
});
