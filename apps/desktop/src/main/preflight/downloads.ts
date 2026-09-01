import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {
  DownloadSpec,
  InstallOutcome,
  PrerequisiteId,
  PrerequisiteStatus,
} from '../../shared/preflight.js';
import type { PreflightContext } from './context.js';

/**
 * Fetching the files LocalCast cannot ship in its own installer.
 *
 * The rule this file exists to keep, and which `vendor/README.md` and
 * `scripts/verify-vendor.mjs` state for the maintainer-side of the same problem: **a digest
 * that was typed rather than measured proves nothing.** So there are exactly two paths here.
 * With a recorded digest the file is verified and installed; without one the file is
 * downloaded, hashed, and then *not* installed — the computed digest goes back to the UI to
 * be shown beside the publisher's own page, and nothing moves into place until the user has
 * said so through `confirmAndInstall`.
 */

/**
 * What the app may fetch.
 *
 * `netedge` is deliberately absent and must stay absent: it is this project's own Go program,
 * not a published artefact, so there is no URL to pin and no publisher to check a digest
 * against. Its remedies are the build command and `native/netedge/README.md`.
 */
export const DOWNLOAD_SPECS: Partial<Record<PrerequisiteId, DownloadSpec>> = {
  'print-helper': {
    id: 'print-helper',
    // The download page links the portable 64-bit build as `SumatraPDF-3.6.1-64.zip`; the
    // same release directory serves that archive's single entry uncompressed, and that is
    // what is fetched here. The reason is the digest: verifying an archive and then unpacking
    // a different file means the digest never covered the bytes that end up on disk, and
    // `scripts/verify-vendor.mjs` records the digest of `vendor/bin/SumatraPDF.exe` itself.
    // Fetching the executable keeps both mechanisms checking the same file.
    url: 'https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.exe',
    sourceUrl: 'https://www.sumatrapdfreader.org/download-free-pdf-viewer',
    version: '3.6.1',
    // `sha256` is absent on purpose, not by oversight. Checked on 2026-09-01: SumatraPDF
    // publishes no digest for any artefact — not on the download page, not with the GitHub
    // release, and there is no checksum file beside the binaries. The project relies on
    // Authenticode signing instead. Inventing a hash here would produce something that passes
    // every test and proves nothing, so this download always takes the `digest-unrecorded`
    // path and asks the user to confirm what was actually computed.
    destination: 'SumatraPDF.exe',
    // Measured from the published artefact's `Content-Length` on 2026-09-01. Used only as a
    // sanity ceiling; it is not a substitute for a digest.
    sizeBytes: 20_292_984,
    licence: 'GPLv3',
  },
};

/** Well above anything in the table. A server that answers with a disk image is refused. */
const MAX_BYTES = 64 * 1024 * 1024;
/** A download that has produced nothing for this long is dead, not slow. */
const IDLE_TIMEOUT_MS = 30_000;
/** Absolute ceiling, so a trickle that never stops cannot hold the wizard open for ever. */
const TOTAL_TIMEOUT_MS = 10 * 60_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ProgressReporter = (status: PrerequisiteStatus) => void;

export interface InstallOptions {
  onProgress?: ProgressReporter;
  /** Injected by the tests; production always uses the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

function destinationPath(ctx: PreflightContext, spec: DownloadSpec): string {
  return join(ctx.vendorDir, spec.destination);
}

/**
 * The partial file sits next to its destination rather than in the temp directory: `rename`
 * across volumes fails, and the vendor directory is not necessarily on the same drive as
 * `%APPDATA%`. Renaming only after verification is what makes an interrupted download
 * impossible to mistake for a finished one — a half-written `SumatraPDF.exe` would otherwise
 * look installed and fail at the first print job.
 */
function partPath(destination: string): string {
  return `${destination}.part`;
}

function failure(
  id: PrerequisiteId,
  reason: Extract<InstallOutcome, { ok: false }>['reason'],
  message: string,
  computedSha256?: string,
): InstallOutcome {
  return computedSha256
    ? { ok: false, id, reason, message, computedSha256 }
    : { ok: false, id, reason, message };
}

function progressStatus(id: PrerequisiteId, fraction: number, detail: string): PrerequisiteStatus {
  return {
    id,
    severity: id === 'print-helper' ? 'degrading' : 'blocking',
    state: 'installing',
    searchedPaths: [],
    detail,
    remedies: [],
    progress: Math.max(0, Math.min(1, fraction)),
  };
}

/**
 * Normalises whatever `fetch` handed back into something `for await` can walk.
 *
 * Node's `fetch` body is an async-iterable `ReadableStream`, but a faked response in a test
 * is usually a plain async generator, and older shims expose only `getReader`. Handling all
 * three here keeps the streaming loop below free of the distinction.
 */
function bodyIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    return body as AsyncIterable<Uint8Array>;
  }
  if (body && typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      },
    };
  }
  throw new Error('the response carried no body');
}

class DownloadTooLarge extends Error {}

interface FetchedPart {
  sha256: string;
  bytes: number;
}

/**
 * Streams the artefact to `<destination>.part`, hashing as it goes.
 *
 * Nothing is written to the destination here. The caller decides what the digest means.
 */
async function fetchToPart(
  spec: DownloadSpec,
  part: string,
  options: InstallOptions,
): Promise<FetchedPart> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();

  const total = setTimeout(
    () => controller.abort(new Error('download timed out')),
    TOTAL_TIMEOUT_MS,
  );
  let idle: NodeJS.Timeout | null = null;
  const touch = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error('download stalled')), IDLE_TIMEOUT_MS);
  };
  touch();

  try {
    const response = await doFetch(spec.url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`${spec.url} answered ${response.status} ${response.statusText}`);
    }

    const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new DownloadTooLarge(`${spec.url} declared ${declared} bytes`);
    }

    const expected = Number.isFinite(declared) && declared > 0 ? declared : (spec.sizeBytes ?? 0);
    const hash = createHash('sha256');
    let received = 0;

    // A generator rather than a `data` listener: attaching one to the body before `pipeline`
    // pipes it would put the stream into flowing mode early and drop the first chunks.
    async function* measured(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        received += chunk.byteLength;
        if (received > MAX_BYTES) {
          throw new DownloadTooLarge(`${spec.url} exceeded ${MAX_BYTES} bytes`);
        }
        hash.update(chunk);
        touch();
        options.onProgress?.(
          progressStatus(
            spec.id,
            expected > 0 ? received / expected : 0,
            `Downloading ${spec.destination} (${Math.round(received / 1024)} KB)`,
          ),
        );
        yield chunk;
      }
    }

    await mkdir(dirname(part), { recursive: true });
    await pipeline(measured(bodyIterable(response.body)), createWriteStream(part));

    return { sha256: hash.digest('hex'), bytes: received };
  } finally {
    clearTimeout(total);
    if (idle) clearTimeout(idle);
  }
}

async function digestOf(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function moveIntoPlace(
  spec: DownloadSpec,
  part: string,
  destination: string,
): Promise<InstallOutcome> {
  try {
    await mkdir(dirname(destination), { recursive: true });
    await rename(part, destination);
  } catch (err) {
    return failure(
      spec.id,
      'write-failed',
      `The download was verified but could not be moved to ${destination}: ${messageOf(err)}`,
    );
  }
  return { ok: true, id: spec.id, installedTo: destination };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Downloads and — only when the digest is recorded and matches — installs.
 *
 * Split out from `install` so the digest rules can be exercised against a spec of the test's
 * own making. The real table is deliberately thin, and a test that could only use it would be
 * unable to cover the recorded-digest branch at all.
 */
export async function installFromSpec(
  spec: DownloadSpec,
  ctx: PreflightContext,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const destination = destinationPath(ctx, spec);
  const part = partPath(destination);

  let fetched: FetchedPart;
  try {
    fetched = await fetchToPart(spec, part, options);
  } catch (err) {
    // Whatever landed is partial and worthless; leaving it would make the next attempt think
    // there is something to resume.
    await rm(part, { force: true });
    return failure(
      spec.id,
      err instanceof DownloadTooLarge ? 'unsupported' : 'network',
      `${spec.url} could not be downloaded: ${messageOf(err)}`,
    );
  }

  if (spec.sha256) {
    const expected = spec.sha256.toLowerCase();
    if (fetched.sha256 !== expected) {
      // Deleted, not kept for inspection: a file that failed its digest is exactly the file
      // that must not be sitting on disk where something later mistakes it for the real one.
      await rm(part, { force: true });
      return failure(
        spec.id,
        'digest-mismatch',
        `The download did not match the recorded digest. Expected ${expected}, got ${fetched.sha256}. Nothing was installed.`,
        fetched.sha256,
      );
    }
    return moveIntoPlace(spec, part, destination);
  }

  // No recorded digest, so nothing is installed yet. The verified bytes stay in the `.part`
  // file and the caller shows this digest next to `sourceUrl`; `confirmAndInstall` finishes
  // the job once the user has compared them.
  return failure(
    spec.id,
    'digest-unrecorded',
    `No digest has been recorded for ${spec.destination} ${spec.version}, and its publisher does not publish one. ` +
      `Check the digest below against ${spec.sourceUrl} before installing. Licence: ${spec.licence}.`,
    fetched.sha256,
  );
}

export async function install(
  id: PrerequisiteId,
  ctx: PreflightContext,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const spec = DOWNLOAD_SPECS[id];
  if (!spec) {
    return failure(
      id,
      'unsupported',
      `LocalCast has no download configured for ${id}; it cannot be fetched automatically.`,
    );
  }
  return installFromSpec(spec, ctx, options);
}

/**
 * The second half of the unrecorded-digest flow, called only after the user has confirmed the
 * digest against the publisher's page.
 *
 * The confirmed digest is re-verified against the file rather than trusted: between the two
 * calls the `.part` file could have been replaced, and the point of the confirmation is that
 * the bytes installed are the bytes the user looked at.
 */
export async function confirmAndInstall(
  id: PrerequisiteId,
  computedSha256: string,
  ctx: PreflightContext,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const spec = DOWNLOAD_SPECS[id];
  if (!spec) {
    return failure(id, 'unsupported', `LocalCast has no download configured for ${id}.`);
  }

  const confirmed = computedSha256.trim().toLowerCase();
  if (!SHA256_HEX.test(confirmed)) {
    // This value crosses IPC from the renderer. It is only ever compared, never executed or
    // interpolated into a path, but a malformed one means the confirmation is not meaningful.
    return failure(id, 'declined', 'The confirmed digest is not a SHA-256 hex string.');
  }

  const destination = destinationPath(ctx, spec);
  const part = partPath(destination);

  const present = await stat(part).catch(() => null);
  if (!present) {
    // The partial file is gone — swept, or the app restarted between the two calls. Fetch it
    // again and hold it to the digest the user confirmed, which is the recorded-digest path
    // with the user standing in for the maintainer.
    return installFromSpec({ ...spec, sha256: confirmed }, ctx, options);
  }

  const actual = await digestOf(part);
  if (actual !== confirmed) {
    await rm(part, { force: true });
    return failure(
      id,
      'digest-mismatch',
      `The file on disk no longer matches the digest that was confirmed (${confirmed}). Nothing was installed.`,
      actual,
    );
  }

  const outcome = await moveIntoPlace(spec, part, destination);
  if (outcome.ok) {
    options.onProgress?.(progressStatus(id, 1, `${spec.destination} installed`));
  }
  return outcome;
}
