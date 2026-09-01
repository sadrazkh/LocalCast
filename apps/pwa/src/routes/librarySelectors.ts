import type { Entry } from '@localcast/contract';
import { hasProgress } from '../storage/progress.js';

/** The canvas's four chips: همه / ادامه تماشا / ۴K / پوشه‌ها. */
export type LibraryFilter = 'all' | 'continue' | '4k' | 'folders';
export type LibrarySort = 'name' | 'newest' | 'largest';
export type LibraryView = 'grid' | 'list';

/**
 * Whether a file is 4K, decided from the name.
 *
 * Resolution is not in the contract and the indexer deliberately does not probe files — that
 * would mean opening every video on every scan. The name is what a media library actually
 * carries this in, and it is what the canvas's chip filters on. It is a heuristic and it is
 * only ever used to filter a view, never to decide what is served.
 */
export function looksLike4k(entry: Entry): boolean {
  return /(^|[^a-z0-9])(4k|2160p|uhd)([^a-z0-9]|$)/i.test(entry.name);
}

export function applyFilter(entries: readonly Entry[], filter: LibraryFilter): Entry[] {
  switch (filter) {
    case 'folders':
      return entries.filter((entry) => entry.isDir);
    case '4k':
      return entries.filter((entry) => !entry.isDir && looksLike4k(entry));
    case 'continue':
      // Watch position is per-device and lives in `localStorage`; the API has no notion of it.
      return entries.filter((entry) => !entry.isDir && hasProgress(entry.id));
    case 'all':
    default:
      return [...entries];
  }
}

/**
 * Sort what has been loaded.
 *
 * This is a client-side sort over the pages fetched so far, and it cannot be anything else:
 * the contract's listing route takes a cursor and a limit and no sort key, so asking the
 * server for "largest first" is not a request that exists. The consequence is worth stating
 * honestly — with an unloaded tail, "largest" means largest *of what you can see*, and the
 * answer converges as the infinite scroll fetches more.
 *
 * Directories sort ahead of files regardless of key, which is what every file browser does
 * and what makes a deep tree navigable.
 */
export function applySort(entries: readonly Entry[], sort: LibrarySort, locale = 'fa'): Entry[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    switch (sort) {
      case 'newest':
        return (b.mtime ?? 0) - (a.mtime ?? 0);
      case 'largest':
        return (b.size ?? 0) - (a.size ?? 0);
      case 'name':
      default:
        return collator.compare(a.name, b.name);
    }
  });
}

export function selectEntries(
  entries: readonly Entry[],
  filter: LibraryFilter,
  sort: LibrarySort,
  locale = 'fa',
): Entry[] {
  return applySort(applyFilter(entries, filter), sort, locale);
}

const VIEW_KEY = 'localcast:view';

export function readView(): LibraryView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writeView(view: LibraryView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Private browsing. The toggle still works for this session.
  }
}
