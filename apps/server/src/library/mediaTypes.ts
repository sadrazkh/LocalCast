import path from 'node:path';
import type { Entry, MediaKind } from '@localcast/contract';

export interface MediaDescriptor {
  kind: MediaKind;
  /** The print subsystem (SumatraPDF) accepts this: PDF and raster images only. */
  printable: boolean;
  /**
   * Whether Safari can play the file with a bare `<video>`/`<audio>` element.
   *
   * Phase 1 ships no ffmpeg, so this is a *container-level* judgement and nothing more. We
   * cannot read the codec of an MP4 without probing it, so `.mp4`/`.m4v`/`.mov` are marked
   * playable on the assumption that they hold H.264/AAC — true for the overwhelming majority
   * of files, and false for HEVC on old iOS or an AC3 audio track. The failure is honest and
   * recoverable: the player falls back to the native-player handoff when the element errors.
   *
   * Containers Safari genuinely cannot open — MKV, AVI, WMV, FLV — are marked false up
   * front rather than shown as a black box that never plays.
   */
  browserPlayable: boolean;
  /** Sent as `Content-Type` on the range endpoint. */
  contentType: string;
}

const OTHER: MediaDescriptor = {
  kind: 'other',
  printable: false,
  browserPlayable: false,
  contentType: 'application/octet-stream',
};

function video(contentType: string, browserPlayable: boolean): MediaDescriptor {
  return { kind: 'video', printable: false, browserPlayable, contentType };
}
function audio(contentType: string, browserPlayable: boolean): MediaDescriptor {
  return { kind: 'audio', printable: false, browserPlayable, contentType };
}
function image(contentType: string, printable: boolean): MediaDescriptor {
  // `browserPlayable` describes the media *player*; clients render images by `kind`, so it
  // stays false here rather than overloading the flag with a second meaning.
  return { kind: 'image', printable, browserPlayable: false, contentType };
}
function document(contentType: string, printable = false): MediaDescriptor {
  return { kind: 'document', printable, browserPlayable: false, contentType };
}
function archive(contentType: string): MediaDescriptor {
  return { kind: 'archive', printable: false, browserPlayable: false, contentType };
}

const TABLE: Record<string, MediaDescriptor> = {
  // ── video ──────────────────────────────────────────────────────────────────
  mp4: video('video/mp4', true),
  m4v: video('video/x-m4v', true),
  mov: video('video/quicktime', true),
  // Safari has no MKV demuxer at all, and WebM/VP9 is not dependable on iOS. Both get the
  // "open in a native player" handoff instead of an element that silently fails.
  mkv: video('video/x-matroska', false),
  webm: video('video/webm', false),
  avi: video('video/x-msvideo', false),
  wmv: video('video/x-ms-wmv', false),
  flv: video('video/x-flv', false),
  mpg: video('video/mpeg', false),
  mpeg: video('video/mpeg', false),
  ts: video('video/mp2t', false),
  m2ts: video('video/mp2t', false),
  mts: video('video/mp2t', false),
  ogv: video('video/ogg', false),
  '3gp': video('video/3gpp', false),
  rmvb: video('application/vnd.rn-realmedia-vbr', false),
  divx: video('video/x-msvideo', false),
  vob: video('video/dvd', false),

  // ── audio ──────────────────────────────────────────────────────────────────
  mp3: audio('audio/mpeg', true),
  m4a: audio('audio/mp4', true),
  aac: audio('audio/aac', true),
  wav: audio('audio/wav', true),
  aif: audio('audio/aiff', true),
  aiff: audio('audio/aiff', true),
  flac: audio('audio/flac', true),
  // Vorbis and Opus in Ogg are not supported by Safari on iOS.
  ogg: audio('audio/ogg', false),
  oga: audio('audio/ogg', false),
  opus: audio('audio/opus', false),
  wma: audio('audio/x-ms-wma', false),

  // ── image ──────────────────────────────────────────────────────────────────
  jpg: image('image/jpeg', true),
  jpeg: image('image/jpeg', true),
  png: image('image/png', true),
  gif: image('image/gif', true),
  bmp: image('image/bmp', true),
  tif: image('image/tiff', true),
  tiff: image('image/tiff', true),
  webp: image('image/webp', true),
  // Printable is what SumatraPDF will actually take. HEIC and SVG are not on that list.
  heic: image('image/heic', false),
  heif: image('image/heif', false),
  svg: image('image/svg+xml', false),
  avif: image('image/avif', false),
  ico: image('image/vnd.microsoft.icon', false),

  // ── document ───────────────────────────────────────────────────────────────
  pdf: document('application/pdf', true),
  txt: document('text/plain; charset=utf-8'),
  md: document('text/markdown; charset=utf-8'),
  rtf: document('application/rtf'),
  // Office formats are deliberately not printable: printing them would mean depending on an
  // installed Office, and half-working is worse than a clear "unsupported".
  doc: document('application/msword'),
  docx: document('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  xls: document('application/vnd.ms-excel'),
  xlsx: document('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  ppt: document('application/vnd.ms-powerpoint'),
  pptx: document('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  epub: document('application/epub+zip'),
  srt: document('application/x-subrip; charset=utf-8'),
  vtt: document('text/vtt; charset=utf-8'),

  // ── archive ────────────────────────────────────────────────────────────────
  zip: archive('application/zip'),
  rar: archive('application/vnd.rar'),
  '7z': archive('application/x-7z-compressed'),
  tar: archive('application/x-tar'),
  gz: archive('application/gzip'),
  iso: archive('application/x-iso9660-image'),
};

/** Lower-case, without the dot. Empty string when the name has no extension. */
export function extensionOf(name: string): string {
  const ext = path.extname(name);
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : '';
}

export function describe(name: string): MediaDescriptor {
  return TABLE[extensionOf(name)] ?? OTHER;
}

export function mediaKindOf(name: string): MediaKind {
  return describe(name).kind;
}

export function isPrintable(name: string): boolean {
  return describe(name).printable;
}

export function isBrowserPlayable(name: string): boolean {
  return describe(name).browserPlayable;
}

export function contentTypeOf(name: string): string {
  return describe(name).contentType;
}

export interface EntryInput {
  id: string;
  folderId: string;
  /** POSIX-separated, relative to the folder root. */
  relPath: string;
  name: string;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
}

export function toEntry(input: EntryInput): Entry {
  const d = input.isDir ? OTHER : describe(input.name);
  const ext = input.isDir ? null : extensionOf(input.name) || null;
  return {
    id: input.id,
    folderId: input.folderId,
    path: input.relPath,
    name: input.name,
    isDir: input.isDir,
    size: input.isDir ? null : input.size,
    mtime: input.mtime,
    ext,
    kind: d.kind,
    printable: d.printable,
    browserPlayable: d.browserPlayable,
  };
}
