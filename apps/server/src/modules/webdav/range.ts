import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Request, Response } from 'express';

/**
 * HTTP Range serving, self-contained on purpose.
 *
 * This file has no imports from the rest of the server because it is the one piece where a
 * subtle mistake is invisible in a browser and fatal in Infuse: an off-by-one in
 * `Content-Range` shows up as a video that plays but cannot seek, and a leaked read stream
 * shows up as a server that dies after an hour of scrubbing. Keeping it dependency-free
 * means it can be read, reviewed and tested as one unit.
 */

export type CreateStream = (path: string, opts: { start: number; end: number }) => Readable;

const defaultCreateStream: CreateStream = (path, opts) => createReadStream(path, opts);

export interface RangeTarget {
  absPath: string;
  size: number;
  mtimeMs: number;
  contentType: string;
  /** `inline` for playback, `attachment` for a download. */
  disposition: 'inline' | 'attachment';
  fileName: string;
}

export type ParsedRange =
  | { kind: 'none' }
  /** Multi-range request: answered as a plain 200 with the whole body. */
  | { kind: 'full' }
  | { kind: 'unsatisfiable' }
  | { kind: 'range'; start: number; end: number };

/**
 * `W/"<size>-<mtimeMs>"`.
 *
 * Weak, and never a content hash. Hashing an 18 GB film on every request to produce a strong
 * validator is indefensible; size plus mtime changes whenever the bytes change in any way a
 * media file realistically changes.
 */
export function weakEtag(size: number, mtimeMs: number): string {
  return `W/"${size}-${Math.floor(mtimeMs)}"`;
}

export function parseRangeHeader(header: string | undefined, size: number): ParsedRange {
  if (!header) return { kind: 'none' };
  const match = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  if (!match || match[1] === undefined) return { kind: 'none' };

  const specs = match[1].split(',').map((s) => s.trim());
  if (specs.length === 0) return { kind: 'none' };
  // Safari never sends multi-range for video, and `multipart/byteranges` is a body format
  // with real complexity and no benefit here. Answer the whole file instead; that is a legal
  // response to any range request.
  if (specs.length > 1) return { kind: 'full' };

  const spec = specs[0];
  if (spec === undefined) return { kind: 'none' };
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { kind: 'none' };

  const startText = parts[1] ?? '';
  const endText = parts[2] ?? '';
  if (startText === '' && endText === '') return { kind: 'none' };

  if (startText === '') {
    // `bytes=-n`: the last n bytes.
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isFinite(start)) return { kind: 'none' };
  if (start >= size) return { kind: 'unsatisfiable' };

  let end = endText === '' ? size - 1 : Number(endText);
  if (!Number.isFinite(end)) return { kind: 'none' };
  // A backwards range is syntactically invalid rather than unsatisfiable, and RFC 9110 says
  // an invalid Range header is ignored — so serve the whole file rather than 416.
  if (end < start) return { kind: 'none' };
  if (end > size - 1) end = size - 1;
  return { kind: 'range', start, end };
}

/**
 * `If-Range` against the weak ETag or `Last-Modified`.
 *
 * RFC 9110 says a server evaluating `If-Range` must use strong comparison, which a weak
 * validator can never satisfy — read literally, every `If-Range` here would fail and every
 * seek would re-download the file from zero. Since the alternative to a weak ETag is hashing
 * gigabytes per request, this compares the validator verbatim instead, exactly as every
 * production server that emits weak ETags does.
 */
export function ifRangeMatches(header: string | undefined, etag: string, mtimeMs: number): boolean {
  if (!header) return true;
  const value = header.trim();
  if (value.startsWith('"') || value.startsWith('W/')) return value === etag;
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return false;
  // Last-Modified has one-second resolution, so compare at that resolution.
  return Math.floor(mtimeMs / 1000) === Math.floor(asDate / 1000);
}

export function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

/** RFC 5987 encoding, so a Persian file name survives `Content-Disposition`. */
function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export interface ServeRangeOptions {
  /** Injectable so a test can watch the stream's lifecycle without touching the disk. */
  createStream?: CreateStream;
}

/**
 * Serves `target` honouring `Range`, and resolves once the response is finished or aborted.
 *
 * Answers 206 with a `Content-Range` for a satisfiable range, 416 with `bytes * /<size>` for
 * one past the end, and 200 for everything else. Never buffers the file.
 */
export async function serveRange(
  req: Request,
  res: Response,
  target: RangeTarget,
  options: ServeRangeOptions = {},
): Promise<void> {
  const createStream = options.createStream ?? defaultCreateStream;
  const etag = weakEtag(target.size, target.mtimeMs);
  const isHead = req.method.toUpperCase() === 'HEAD';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', httpDate(target.mtimeMs));
  res.setHeader('Content-Type', target.contentType);
  res.setHeader('Content-Disposition', contentDisposition(target.disposition, target.fileName));
  // `no-transform` is the standards-blessed way to tell any intermediary — and any
  // compression middleware — to leave media bytes alone.
  res.setHeader('Cache-Control', 'private, max-age=0, no-transform');

  const rangeHeader = req.headers.range;
  let parsed = parseRangeHeader(typeof rangeHeader === 'string' ? rangeHeader : undefined, target.size);
  if (
    parsed.kind === 'range' &&
    !ifRangeMatches(
      typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined,
      etag,
      target.mtimeMs,
    )
  ) {
    // The file changed under the client; giving it a range of the new file would splice two
    // different files together in its buffer.
    parsed = { kind: 'full' };
  }

  if (parsed.kind === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${target.size}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(416).end(
      JSON.stringify({
        error: { code: 'range_not_satisfiable', message: 'Requested range is outside the file.' },
      }),
    );
    return;
  }

  const start = parsed.kind === 'range' ? parsed.start : 0;
  const end = parsed.kind === 'range' ? parsed.end : target.size - 1;
  const length = target.size === 0 ? 0 : end - start + 1;

  if (parsed.kind === 'range') {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${target.size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', String(length));

  if (isHead || length === 0) {
    res.end();
    return;
  }

  const stream = createStream(target.absPath, { start, end });

  await new Promise<void>((resolve) => {
    let done = false;
    const settle = (): void => {
      if (done) return;
      done = true;
      resolve();
    };

    // THE defect this whole module exists to avoid. Scrubbing a 4K file abandons dozens of
    // in-flight requests within a second; without destroying the read stream when the
    // response closes, every one of them holds a file descriptor open until the process
    // runs out of them and the server stops serving anything at all.
    res.on('close', () => {
      stream.destroy();
      settle();
    });

    stream.on('error', () => {
      // Headers are already sent, so there is no honest status code left to send. Cutting
      // the connection makes the client retry rather than accept a truncated file as whole.
      stream.destroy();
      res.destroy();
      settle();
    });

    res.on('finish', settle);
    stream.pipe(res);
  });
}
