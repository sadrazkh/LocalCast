import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  FileGridItem,
  FileRow,
  FolderIcon,
  ListIcon,
  PrinterIcon,
  Select,
  Spinner,
  UploadIcon,
  formatBytes,
  formatCount,
  useLocale,
  useT,
  CopyIcon,
  CheckIcon,
  copyText,
} from '@localcast/ui-kit';
import { folderSchema } from '@localcast/contract';
import type { Entry, Folder } from '@localcast/contract';
import { useClient, useConnectionState, useClientContext } from '../client/ClientProvider.js';
import { useAsync } from '../hooks/useAsync.js';
import { useServerEvent } from '../hooks/useServerEvent.js';
import { useEntryPages, useInfiniteScroll } from '../hooks/useEntryPages.js';
import { useAppT } from '../i18n/messages.js';
import { buildHref, navigate } from '../router.js';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { PrintSheet } from '../components/PrintSheet.js';
import { Screen } from '../components/Screen.js';
import styles from './LibraryRoute.module.css';
import { looksLike4k, readView, selectEntries, writeView } from './librarySelectors.js';
import type { LibraryFilter, LibrarySort, LibraryView } from './librarySelectors.js';

/**
 * Screen 09 — the library.
 *
 * Two shapes behind one route: with no folder id it is the folder list, which is the offline
 * library's front door; with one it is a directory listing that pages on a cursor.
 */
export interface LibraryRouteProps {
  folderId: string | null;
  /** POSIX-separated and relative to the folder root; empty at the root. */
  path: string;
}

export function LibraryRoute({ folderId, path }: LibraryRouteProps) {
  return folderId === null ? <FolderList /> : <FolderContents folderId={folderId} path={path} />;
}

// ─── the folder list ──────────────────────────────────────────────────────────

const foldersSchema = folderSchema.array();

function FolderList() {
  const t = useT();
  const at = useAppT();
  const { locale } = useLocale();
  const client = useClient();
  const connection = useConnectionState();

  const folders = useAsync(
    async (signal) => {
      const fetcher = () => client.api.folders({ signal });
      if (client.cache === null) return { value: await fetcher(), stale: false };
      return client.cache.withCache('folders', 'all', foldersSchema, fetcher);
    },
    [client],
  );

  /**
   * Refetch the moment the operator changes what this device may see.
   *
   * The list was fetched once, at mount, and served from the offline cache after that — so a
   * folder granted in the panel appeared here only when somebody reloaded the app by hand. The
   * cache entry is dropped first, or the refetch would be answered from it.
   */
  const refetchFolders = () => {
    const invalidate = client.cache?.invalidate('folders', 'all') ?? Promise.resolve();
    void invalidate.finally(() => folders.reload());
  };
  useServerEvent('permissions', refetchFolders);
  useServerEvent('device', (event) => {
    if (event.status === 'active') refetchFolders();
  });
  useServerEvent('folder', refetchFolders);

  const writable = (folders.value ?? []).filter((folder) => folder.writable && folder.available);

  return (
    <Screen
      title={at('library.title')}
      connection={connection}
      actions={
        writable.length === 0 ? undefined : (
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label={t('upload.title')}
            startIcon={<UploadIcon />}
            onClick={() => navigate('/upload')}
          />
        )
      }
    >
      {folders.loading && folders.value === null ? (
        <Spinner labelled />
      ) : folders.value === null || folders.value.length === 0 ? (
        <EmptyState
          icon={<FolderIcon size={28} />}
          title={at('library.foldersEmpty')}
          description={folders.error === null ? undefined : messageOf(folders.error)}
          actions={
            <Button variant="secondary" onClick={folders.reload}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <>
          {folders.stale ? (
            <div className={styles.staleNote}>
              <Badge tone="warning" dot>
                {at('app.staleData')}
              </Badge>
            </div>
          ) : null}
          <div className={styles.folders}>
            {folders.value.map((folder) => (
              <FolderCard key={folder.id} folder={folder} locale={locale} />
            ))}
          </div>
        </>
      )}
    </Screen>
  );
}

function FolderCard({ folder, locale }: { folder: Folder; locale: 'fa' | 'en' }) {
  const t = useT();
  return (
    <Card padding="sm" muted={!folder.available}>
      <a
        className={styles.folderCard}
        href={folder.available ? buildHref(`/library/${encodeURIComponent(folder.id)}`) : buildHref('/library')}
        aria-disabled={folder.available ? undefined : true}
        data-testid={`folder-${folder.id}`}
      >
        <span className={styles.folderIcon}>
          <FolderIcon size={22} />
        </span>
        <span className={styles.folderText}>
          <span className={styles.folderLabel}>{folder.label}</span>
          <span className={styles.folderMeta}>
            <span>{t(`folders.kind.${folder.kind}`)}</span>
            {folder.fileCount === null ? null : <span>{formatCount(folder.fileCount, locale)}</span>}
            {folder.totalBytes === null ? null : (
              <span className={styles.mono}>{formatBytes(folder.totalBytes)}</span>
            )}
          </span>
        </span>
        {/* A folder whose drive is unplugged is greyed and listed, never hidden — hiding it
            reads as "the operator removed my access", which is a different thing entirely. */}
        {folder.available ? null : <Badge tone="warning">{t('folders.unavailable')}</Badge>}
        {folder.mode === 'stream' ? <Badge tone="neutral">{t('access.stream')}</Badge> : null}
      </a>
    </Card>
  );
}

// ─── one folder's contents ────────────────────────────────────────────────────

function FolderContents({ folderId, path }: { folderId: string; path: string }) {
  const t = useT();
  const at = useAppT();
  const { locale } = useLocale();
  const connection = useConnectionState();

  const [view, setView] = useState<LibraryView>(readView);
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [sort, setSort] = useState<LibrarySort>('name');
  const [printing, setPrinting] = useState<Entry | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const client = useClient();
  const { session } = useClientContext();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const page = useEntryPages(folderId, path);
  useInfiniteScroll(sentinel, page.loadMore, !page.complete && !page.loading);

  const visible = selectEntries(page.entries, filter, sort, locale);
  // Printing is a `full`-mode operation. Offering the affordance in `stream` mode would only
  // produce a 403 the user cannot do anything about.
  const canPrint = page.folder?.mode === 'full';

  function open(entry: Entry): void {
    if (entry.isDir) {
      navigate(`/library/${encodeURIComponent(folderId)}`, { query: { path: entry.path } });
      return;
    }
    navigate(`/play/${encodeURIComponent(entry.id)}`);
  }

  function printAction(entry: Entry) {
    if (!canPrint || !entry.printable || entry.isDir) return null;
    return (
      <Button
        iconOnly
        size="sm"
        variant="ghost"
        aria-label={`${t('files.print')} — ${entry.name}`}
        startIcon={<PrinterIcon size={16} />}
        onClick={() => setPrinting(entry)}
      />
    );
  }

  /**
   * A link a native player can open, one tap from the list.
   *
   * The WebDAV address with the credentials embedded, so it is a single paste into VLC's
   * "Open Network Stream". It used to exist only inside the player, behind a tap into a file the
   * browser then tried to play first — for a 4K MKV that is a black screen before the button.
   */
  async function copyLink(entry: Entry): Promise<void> {
    if (session === null) return;
    const url = client.api.davUrl(entry.folderId, entry.path, {
      credentials: { deviceId: session.deviceId, davPassword: session.davPassword },
    });
    const ok = await copyText(url);
    setCopiedId(ok ? entry.id : null);
    setCopyNote(ok ? at('library.copyLinkDone') : at('library.copyLinkFailed'));
    window.setTimeout(() => {
      setCopiedId((current) => (current === entry.id ? null : current));
      setCopyNote(null);
    }, 3_000);
  }

  function copyAction(entry: Entry) {
    if (entry.isDir || session === null) return null;
    return (
      <Button
        iconOnly
        size="sm"
        variant="ghost"
        aria-label={`${at('library.copyLink')} — ${entry.name}`}
        startIcon={copiedId === entry.id ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        onClick={() => void copyLink(entry)}
        data-testid="copy-link"
      />
    );
  }

  function actionsFor(entry: Entry) {
    const print = printAction(entry);
    const copy = copyAction(entry);
    if (print === null && copy === null) return null;
    return (
      <>
        {copy}
        {print}
      </>
    );
  }

  return (
    <Screen
      title={page.folder?.label ?? t('common.loading')}
      back={buildHref('/library')}
      connection={connection}
      actions={
        <Button
          iconOnly
          variant="ghost"
          size="sm"
          aria-label={view === 'grid' ? at('library.viewList') : at('library.viewGrid')}
          startIcon={view === 'grid' ? <ListIcon /> : <FolderIcon />}
          onClick={() => {
            const next: LibraryView = view === 'grid' ? 'list' : 'grid';
            setView(next);
            writeView(next);
          }}
        />
      }
    >
      <div className={styles.toolbar}>
        <Breadcrumb folderId={folderId} folderLabel={page.folder?.label ?? ''} path={path} />

        <div className={styles.chips} role="group" aria-label={at('library.filters')}>
          <Chip selected={filter === 'all'} onClick={() => setFilter('all')}>
            {t('common.all')}
          </Chip>
          <Chip selected={filter === 'continue'} onClick={() => setFilter('continue')}>
            {at('library.filterContinue')}
          </Chip>
          <Chip selected={filter === '4k'} onClick={() => setFilter('4k')}>
            {at('library.filter4k')}
          </Chip>
          <Chip selected={filter === 'folders'} onClick={() => setFilter('folders')}>
            {at('library.filterFolders')}
          </Chip>
        </div>

        <div className={styles.sortRow}>
          <Select
            aria-label={at('library.sort')}
            selectSize="sm"
            options={[
              { value: 'name', label: at('library.sortName') },
              { value: 'newest', label: at('library.sortNewest') },
              { value: 'largest', label: at('library.sortLargest') },
            ]}
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as LibrarySort)}
          />
          {page.stale ? (
            <Badge tone="warning" dot>
              {at('app.staleData')}
            </Badge>
          ) : null}
        </div>
      </div>

      {page.loading ? (
        <Spinner labelled />
      ) : page.error !== null && page.entries.length === 0 ? (
        <EmptyState
          title={t('offline.title')}
          description={messageOf(page.error)}
          actions={
            <Button variant="secondary" onClick={page.reload}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState title={t('files.empty')} />
      ) : view === 'grid' ? (
        <div className={styles.grid} data-testid="library-grid">
          {visible.map((entry) => (
            <FileGridItem
              key={entry.id}
              entry={entry}
              // Always null, and deliberately so: phase 1 ships no ffmpeg, so there is no
              // frame to extract and no poster to fetch. `FileGridItem` draws its designed
              // media-kind fallback instead of an empty box.
              posterUrl={null}
              onOpen={() => open(entry)}
              actions={
                <>
                  {looksLike4k(entry) ? <Badge tone="neutral">4K</Badge> : null}
                  {actionsFor(entry)}
                </>
              }
            />
          ))}
        </div>
      ) : (
        <div className={styles.list} data-testid="library-list">
          {visible.map((entry) => (
            <FileRow key={entry.id} entry={entry} onOpen={() => open(entry)} actions={actionsFor(entry)} />
          ))}
        </div>
      )}

      {copyNote === null ? null : (
        <p className={styles.end} role="status">
          {copyNote}
        </p>
      )}

      {/* The sentinel drives the scroll; the button is what makes the same thing reachable
          with a keyboard and in any environment without IntersectionObserver. */}
      <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
      {page.complete ? (
        page.entries.length > 0 ? (
          <p className={styles.end}>{at('library.endOfList')}</p>
        ) : null
      ) : (
        <div className={styles.more}>
          <Button variant="ghost" loading={page.loadingMore} onClick={page.loadMore}>
            {page.loadingMore ? at('library.loadingMore') : t('common.more')}
          </Button>
        </div>
      )}

      <PrintSheet entry={printing} onClose={() => setPrinting(null)} />
    </Screen>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
