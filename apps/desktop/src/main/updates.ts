import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { app, shell } from 'electron';

/**
 * Checks GitHub Releases for a newer LocalCast and, where it can, installs it.
 *
 * Deliberately not `electron-updater`. That expects a publish channel this project does not
 * have, and it cannot update a portable build at all — the running executable is the thing it
 * would have to replace. What is here instead is small enough to read: ask the releases API,
 * compare versions, download the installer, **check it against the SHA256SUMS published
 * beside it**, and hand it to the user's own installer.
 *
 * The digest check is the part that matters. An updater that downloads an executable and runs
 * it without verifying anything is a remote-code-execution feature with a friendly button, so
 * a release whose checksums are missing or do not match is refused rather than installed.
 */

const REPO = 'sadrazkh/LocalCast';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export type UpdateState =
  | { status: 'current'; version: string }
  | { status: 'available'; version: string; latest: string; notes: string; canInstall: boolean; url: string }
  | { status: 'error'; message: string };

export interface UpdateProgress {
  receivedBytes: number;
  totalBytes: number;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

/** `1.2.10` sorts after `1.2.9`, which a string comparison gets wrong. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === y) continue;
    // A prerelease suffix sorts below the release it qualifies: 1.0.0-rc1 < 1.0.0.
    if (typeof x === 'number' && typeof y === 'number') return x > y;
    if (typeof x === 'number') return true;
    if (typeof y === 'number') return false;
    return x > y;
  }
  return false;
}

async function fetchRelease(): Promise<{ tag: string; notes: string; assets: ReleaseAsset[] }> {
  const res = await fetch(RELEASES_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `LocalCast/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name: string; body?: string; assets?: ReleaseAsset[] };
  return { tag: body.tag_name, notes: body.body ?? '', assets: body.assets ?? [] };
}

/**
 * A portable build cannot replace itself: the executable is running, and on Windows that file
 * is locked. It is told about the update and sent to the download page instead of being
 * offered a button that could only half-work.
 */
function runningPortable(): boolean {
  return !!process.env['PORTABLE_EXECUTABLE_DIR'] || process.env['LOCALCAST_PORTABLE'] === '1';
}

export async function checkForUpdate(): Promise<UpdateState> {
  const current = app.getVersion();
  try {
    const release = await fetchRelease();
    if (!isNewer(release.tag, current)) return { status: 'current', version: current };

    const installer = release.assets.find((a) => /^LocalCast-Setup-.*\.exe$/i.test(a.name));
    return {
      status: 'available',
      version: current,
      latest: release.tag.replace(/^v/, ''),
      notes: release.notes,
      // Installable only when there is an installer to run and we are not the portable build.
      canInstall: !!installer && !runningPortable() && app.isPackaged,
      url: RELEASES_PAGE,
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Parses the `<sha256> *<name>` lines the release publishes. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match) map.set(match[2]!.trim(), match[1]!.toLowerCase());
  }
  return map;
}

/**
 * Downloads the installer, verifies it, and launches it.
 *
 * Refuses in three cases, all of which are "we cannot prove this file is the one the release
 * published": no SHA256SUMS asset, no entry for this file, or a digest that does not match.
 * Refusing is the whole point — the alternative is running an unverified executable.
 */
export async function downloadAndInstall(onProgress?: (p: UpdateProgress) => void): Promise<void> {
  if (runningPortable()) {
    await shell.openExternal(RELEASES_PAGE);
    return;
  }

  const release = await fetchRelease();
  const installer = release.assets.find((a) => /^LocalCast-Setup-.*\.exe$/i.test(a.name));
  if (!installer) throw new Error('That release has no installer to run.');

  const sums = release.assets.find((a) => a.name === 'SHA256SUMS');
  if (!sums) {
    throw new Error(
      'That release publishes no checksums, so the download cannot be verified. Install it by ' +
        'hand from the releases page if you trust it.',
    );
  }

  const sumsText = await (await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(30_000) })).text();
  const expected = parseChecksums(sumsText).get(installer.name);
  if (!expected) throw new Error(`The checksums file has no entry for ${installer.name}.`);

  const target = join(app.getPath('temp'), installer.name);
  await rm(target, { force: true });

  const res = await fetch(installer.browser_download_url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed with ${res.status}`);

  const hash = createHash('sha256');
  let received = 0;
  const total = Number(res.headers.get('content-length') ?? installer.size);

  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* (source) {
      for await (const chunk of source) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        received += buffer.length;
        onProgress?.({ receivedBytes: received, totalBytes: total });
        yield buffer;
      }
    },
    createWriteStream(target),
  );

  const actual = hash.digest('hex');
  if (actual !== expected) {
    await rm(target, { force: true });
    throw new Error(
      `The download does not match the checksum the release published. Expected ${expected}, got ${actual}. ` +
        'Nothing was installed.',
    );
  }

  // Sanity: a truncated download that somehow hashed correctly is not a thing, but a zero-byte
  // file caused by a full disk is, and it would launch and do nothing.
  if ((await stat(target)).size === 0) throw new Error('The download is empty.');

  // Detached, so the installer outlives this process — it has to replace the very files this
  // one is running from.
  spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}
