import { open } from 'node:fs/promises';
import { dirname, extname, join, basename } from 'node:path';
import { ApiException, ErrorCode } from '@localcast/contract';

/**
 * Windows reserves these names in every directory and at every extension: `CON.txt` is still
 * the console. A phone that uploads a photo called `AUX.jpg` would otherwise create a file
 * that cannot be opened, deleted or renamed by any tool the user has.
 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Syntactic validation of a client-declared relative path.
 *
 * `ctx.files.resolveWritable` is the real boundary — it is the one that calls `realpath` and
 * so is the only thing that can catch a junction. This runs first anyway, because rejecting
 * `../` before it reaches a path join costs nothing, and because it is the layer that can
 * still name what was wrong: by the time a resolver has normalised the string, the error it
 * can give is "outside the root" rather than "you sent a traversal".
 */
export function sanitizeRelativePath(input: string): string {
  if (input.includes('\0')) {
    throw new ApiException(ErrorCode.PATH_ESCAPES_ROOT, 'The path contains a null byte.');
  }
  // Backslashes are separators on the target filesystem, so `a\..\..\b` is a traversal that
  // a POSIX-only check would wave through.
  const normalized = input.replace(/\\/g, '/');

  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/') || normalized.startsWith('//')) {
    throw new ApiException(ErrorCode.PATH_ESCAPES_ROOT, 'The path must be relative to the folder.');
  }

  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new ApiException(ErrorCode.BAD_REQUEST, 'A file name is required.');
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new ApiException(ErrorCode.PATH_ESCAPES_ROOT, 'The path escapes the shared folder.');
    }
    // NTFS alternate data streams: `photo.jpg:evil.exe` writes bytes nobody can see.
    if (segment.includes(':')) {
      throw new ApiException(ErrorCode.PATH_ESCAPES_ROOT, 'The path contains an invalid character.');
    }
    if (/[<>"|?*]/.test(segment)) {
      throw new ApiException(ErrorCode.BAD_REQUEST, 'The name contains characters Windows forbids.');
    }
    // A trailing dot or space is legal to create through the raw API and impossible to open
    // through Explorer afterwards.
    if (segment !== segment.replace(/[. ]+$/, '')) {
      throw new ApiException(ErrorCode.BAD_REQUEST, 'A name cannot end in a dot or a space.');
    }
    const stem = (segment.split('.')[0] ?? '').toLowerCase();
    if (RESERVED.has(stem)) {
      throw new ApiException(ErrorCode.BAD_REQUEST, `\`${segment}\` is a reserved Windows name.`);
    }
  }

  return segments.join('/');
}

/**
 * Picks a free name next to `absPath`, suffixing ` (2)`, ` (3)` … the way Windows does.
 *
 * Reserves the chosen name with an exclusive create rather than a check-then-rename. Two
 * phones uploading `IMG_0001.JPG` at the same second is not hypothetical — it is what
 * happens when someone shares a burst — and a plain existence check would let both win the
 * same name and one of them silently overwrite the other.
 */
export async function reserveFreeName(absPath: string): Promise<string> {
  const dir = dirname(absPath);
  const ext = extname(absPath);
  const stem = basename(absPath, ext);

  for (let counter = 1; counter < 1000; counter += 1) {
    const candidate = counter === 1 ? absPath : join(dir, `${stem} (${counter})${ext}`);
    try {
      const handle = await open(candidate, 'wx');
      await handle.close();
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new ApiException(
    ErrorCode.BAD_REQUEST,
    'Too many files with this name already exist in that folder.',
  );
}
