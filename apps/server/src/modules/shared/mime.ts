/**
 * A deliberately small content-type table.
 *
 * `mime-types` would be a dependency for one lookup, and the set of extensions that actually
 * cross this server is known: the media Safari and Infuse ask for, plus the two document
 * kinds the printer accepts. Everything else is `application/octet-stream`, which every
 * WebDAV client handles by falling back to the file name.
 */
const TYPES: Record<string, string> = {
  // video — the reason Range streaming exists
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  // audio
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  // images — also the printable set
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  // documents
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

export const OCTET_STREAM = 'application/octet-stream';

export function contentTypeFor(nameOrExt: string): string {
  const dot = nameOrExt.lastIndexOf('.');
  const ext = (dot === -1 ? nameOrExt : nameOrExt.slice(dot)).toLowerCase();
  return TYPES[ext] ?? OCTET_STREAM;
}
