import { createReadStream } from 'node:fs';
import { ApiException, ErrorCode, type AccessMode } from '@localcast/contract';
import type { Request, Response } from 'express';
import type { Logger, ResolvedFile } from '../kernel.js';
import { contentTypeOf } from '../library/mediaTypes.js';

/**
 * The Range endpoint. This is where seeking in a multi-gigabyte file either works or does
 * not, so it follows spec section 5 to the letter and is tested against a >4 GiB fixture —
 * every offset here is a plain JavaScript number, which is exact to 2^53, but a 32-bit
 * truncation anywhere in the chain would show up immediately past the 4 GiB mark.
 */

export interface ParsedRange {
  start: number;
  end: number;
}

export type RangeParse =
  | { kind: 'none' }
  /** Syntactically unusable, e.g. `items=0-10`. RFC 9110 says ignore the header. */
  | { kind: 'ignore' }
  /** More than one range: answered with 200 and the whole body, never multipart. */
  | { kind: 'multiple' }
  | { kind: 'unsatisfiable' }
  | { kind: 'single'; range: ParsedRange };

export function parseRangeHeader(header: string | undefined, size: number): RangeParse {
  if (!header) return { kind: 'none' };

  const match = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  if (!match?.[1]) return { kind: 'ignore' };

  const specs = match[1].split(',').map((s) => s.trim());
  if (specs.length === 0 || specs.some((s) => s.length === 0)) return { kind: 'ignore' };
  // Safari never sends multi-range for video, so `multipart/byteranges` would be a parser we
  // maintain forever for no caller. The whole body is a correct answer to a multi-range GET.
  if (specs.length > 1) return { kind: 'multiple' };

  const spec = specs[0] as string;
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { kind: 'ignore' };

  const firstRaw = parts[1] ?? '';
  const lastRaw = parts[2] ?? '';
  if (firstRaw === '' && lastRaw === '') return { kind: 'ignore' };

  // A zero-length file cannot satisfy any range at all.
  if (size === 0) return { kind: 'unsatisfiable' };

  if (firstRaw === '') {
    // `bytes=-n`: the final n bytes. `bytes=-0` asks for nothing and is unsatisfiable.
    const suffix = Number(lastRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffix);
    return { kind: 'single', range: { start, end: size - 1 } };
  }

  const start = Number(firstRaw);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };

  if (lastRaw === '') return { kind: 'single', range: { start, end: size - 1 } };

  const last = Number(lastRaw);
  if (!Number.isSafeInteger(last)) return { kind: 'unsatisfiable' };
  // A reversed range is semantically invalid, not merely unmatched.
  if (last < start) return { kind: 'unsatisfiable' };

  return { kind: 'single', range: { start, end: Math.min(last, size - 1) } };
}

/**
 * `W/"<size>-<mtimeMs>"`. Weak on purpose: it is derived from metadata, so it is cheap and
 * exact enough for `If-Range`. Hashing the bytes would mean reading 18 GB to answer a seek,
 * which is not a trade anyone should make.
 */
export function weakETag(size: number, mtimeMs: number): string {
  return `W/"${size}-${Math.floor(mtimeMs)}"`;
}

function ifRangeMatches(header: string, etag: string, lastModified: string): boolean {
  const value = header.trim();
  // An `If-Range` carrying a date must match `Last-Modified` exactly; carrying an entity tag
  // it must match the ETag. A weak validator is only usable here because we also compare the
  // size, so a same-second rewrite of a different length still invalidates.
  if (value.startsWith('W/') || value.startsWith('"')) return value === etag;
  return value === lastModified;
}

export interface ServeFileOptions {
  /** The device's mode for the containing folder. `stream` refuses full downloads. */
  mode: AccessMode;
  /** `attachment` is a download by definition and is refused in `stream` mode. */
  disposition: 'inline' | 'attachment';
  log: Logger;
  /** Overrides the extension-derived type; used by modules that know better. */
  contentType?: string;
}

const HIGH_WATER_MARK = 256 * 1024;

/**
 * Writes the whole response. Throws `ApiException` before anything is written when the
 * request is refused, so the normal error middleware still shapes the body.
 */
export function serveFile(
  req: Request,
  res: Response,
  file: ResolvedFile,
  opts: ServeFileOptions,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    throw new ApiException(ErrorCode.BAD_REQUEST, 'Only GET and HEAD are supported');
  }
  if (file.isDir) throw new ApiException(ErrorCode.NOT_FOUND, 'Not found');

  const size = file.size;
  const etag = weakETag(size, file.mtimeMs);
  const lastModified = new Date(Math.floor(file.mtimeMs)).toUTCString();
  const name = file.entry.name;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', opts.contentType ?? contentTypeOf(name));
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastModified);
  // Media is private to the device and validated by ETag; a shared cache must not keep it.
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  // Both spellings: the ASCII one for old clients, the RFC 5987 one for the Persian and
  // otherwise non-Latin file names this library is full of.
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader(
    'Content-Disposition',
    `${opts.disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );

  let parsed = parseRangeHeader(req.header('range'), size);

  const ifRange = req.header('if-range');
  if (ifRange && parsed.kind === 'single') {
    if (!ifRangeMatches(ifRange, etag, lastModified)) {
      // The file changed under the client. Serving the requested slice would splice old and
      // new bytes together, so the range is dropped and the request becomes a full one —
      // which `stream` mode then refuses, and the client retries without `If-Range`.
      parsed = { kind: 'none' };
    }
  }

  const isFullBody = parsed.kind === 'none' || parsed.kind === 'ignore' || parsed.kind === 'multiple';

  // `stream` mode is a user-interface restriction, not a security boundary — anything that
  // can ask for ranges can reassemble the file, and the spec says so out loud. What it does
  // guarantee is that the obvious ways to take a copy are refused: a plain GET, an explicit
  // attachment, and a multi-range request (which is answered with the whole body and would
  // otherwise be a one-line bypass). A HEAD carries no body and is always allowed, because
  // every player issues one before it seeks.
  if (opts.mode === 'stream' && req.method !== 'HEAD') {
    if (opts.disposition === 'attachment' || isFullBody) {
      throw new ApiException(
        ErrorCode.DOWNLOAD_NOT_ALLOWED,
        'This folder is shared for playback only',
      );
    }
  }

  if (parsed.kind === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    throw new ApiException(ErrorCode.RANGE_NOT_SATISFIABLE, 'Requested range is not satisfiable');
  }

  let start = 0;
  let end = size === 0 ? 0 : size - 1;
  if (parsed.kind === 'single') {
    start = parsed.range.start;
    end = parsed.range.end;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
  } else {
    res.status(200);
    res.setHeader('Content-Length', String(size));
  }

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  if (size === 0) {
    res.end();
    return;
  }

  const stream = createReadStream(file.absPath, {
    start,
    end,
    highWaterMark: HIGH_WATER_MARK,
  });

  /**
   * THE defect this whole endpoint is written around. Scrubbing a 4K file abandons dozens of
   * in-flight requests per second; each one leaves a read stream — and its file descriptor —
   * alive unless it is destroyed when the response closes. `pipe` alone does not do this.
   */
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    res.off('close', cleanup);
    res.off('error', cleanup);
    if (!stream.destroyed) stream.destroy();
  };

  res.on('close', cleanup);
  res.on('error', cleanup);

  stream.on('error', (err: NodeJS.ErrnoException) => {
    cleanup();
    if (res.headersSent) {
      // The status line is already out; the only honest signal left is a truncated body.
      opts.log.warn('read stream failed mid-response', {
        path: file.relPath,
        error: err.message,
      });
      res.destroy(err);
      return;
    }
    res.status(err.code === 'ENOENT' ? 404 : 500).end();
  });

  stream.on('end', cleanup);
  stream.pipe(res);
}
