/**
 * Playback position per file, so «ادامه تماشا» means something.
 *
 * `localStorage` rather than IndexedDB, and deliberately so: this is written on every
 * `timeupdate` while a film plays, it is a handful of numbers, and losing it costs the user a
 * few seconds of scrubbing. IndexedDB's asynchrony would buy durability nobody needs here and
 * would put a promise in the middle of a media event handler.
 *
 * The API does not model watch progress at all — it is not in `packages/contract` — so this
 * is per-device by construction. That is the honest scope: the phone knows where the phone
 * got to. Claiming otherwise would need a server route that does not exist.
 */

const KEY = 'localcast:progress';
/** Enough for a long library without letting the record grow unbounded. */
const MAX_ENTRIES = 200;
/** Below this, the user has not started; above it, they have finished. */
const START_FRACTION = 0.02;
const END_FRACTION = 0.95;

export interface PlaybackProgress {
  seconds: number;
  duration: number;
  updatedAt: number;
}

type ProgressMap = Record<string, PlaybackProgress>;

function read(storage: Storage | undefined = safeStorage()): ProgressMap {
  if (storage === undefined) return {};
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ProgressMap) : {};
  } catch {
    return {};
  }
}

function write(map: ProgressMap, storage: Storage | undefined = safeStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Quota, or private browsing. Watch position is not worth an error the user has to read.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function getProgress(fileId: string, storage?: Storage): PlaybackProgress | null {
  return read(storage)[fileId] ?? null;
}

export function setProgress(
  fileId: string,
  seconds: number,
  duration: number,
  storage?: Storage,
  now: number = Date.now(),
): void {
  const map = read(storage);
  const fraction = duration > 0 ? seconds / duration : 0;

  // A finished film is not "continue watching", and neither is one that played for two
  // seconds while the user worked out it was the wrong file.
  if (duration === 0 || fraction < START_FRACTION || fraction > END_FRACTION) {
    if (map[fileId] === undefined) return;
    delete map[fileId];
    write(map, storage);
    return;
  }

  map[fileId] = { seconds, duration, updatedAt: now };

  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => (map[a]?.updatedAt ?? 0) - (map[b]?.updatedAt ?? 0))
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => delete map[id]);
  }
  write(map, storage);
}

export function hasProgress(fileId: string, storage?: Storage): boolean {
  return read(storage)[fileId] !== undefined;
}

export function allProgress(storage?: Storage): ProgressMap {
  return read(storage);
}
