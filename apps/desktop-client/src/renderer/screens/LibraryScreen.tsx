import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowBackIcon,
  Badge,
  Button,
  DownloadIcon,
  EmptyState,
  FileGridItem,
  FolderIcon,
  Panel,
  PlayIcon,
  SearchIcon,
  Select,
  Spinner,
  Table,
  UploadIcon,
  Input,
  useFormat,
  useT,
} from '@localcast/ui-kit';
import type { TableColumn } from '@localcast/ui-kit';
import type { Entry, Folder } from '@localcast/contract';
import type { ServerSummary } from '../../shared/ipc.js';
import { useBridge, useDownloads, useUploads } from '../bridge.js';
import { FolderTree } from '../components/FolderTree.js';
import type { TreeSelection } from '../components/FolderTree.js';
import { TransferQueue } from '../components/TransferQueue.js';
import { errorText, S } from '../strings.js';
import styles from './LibraryScreen.module.css';

/**
 * Screen 06 — the library and the transfer queue.
 *
 * Three things worth naming, because they are where this screen could quietly lie:
 *
 *  - **`stream` mode is a UI restriction, not a security boundary.** The download button is
 *    hidden for a `stream` folder because offering an action the server will refuse is worse
 *    than not offering it, but the spec is explicit that anything able to request byte ranges
 *    can reassemble a file. Nothing here should be mistaken for DRM.
 *  - **There are no poster frames in phase 1.** Frame extraction needs ffmpeg, which is
 *    deferred, so `FileGridItem` is given `posterUrl={null}` and renders its designed
 *    icon-tile fallback. Empty boxes waiting for images that will never arrive would be the
 *    dishonest version of the same grid.
 *  - **Sorting is done on the page in hand**, not asked of the server, and the header says
 *    so when more pages exist — sorting 200 of 30,000 entries and calling it "by size" is a
 *    lie the user cannot see.
 */

export interface LibraryScreenProps {
  server: ServerSummary;
  downloadDir: string;
  onBack: () => void;
  onPlay: (entry: Entry, folder: Folder) => void;
}

type SortKey = 'name' | 'size' | 'date';

const SORT_OPTIONS = [
  { value: 'name', label: S.sortName },
  { value: 'size', label: S.sortSize },
  { value: 'date', label: S.sortDate },
];

export function LibraryScreen({ server, downloadDir, onBack, onPlay }: LibraryScreenProps) {
  const api = useBridge();
  const t = useT();
  const format = useFormat();
  const downloads = useDownloads();
  const uploads = useUploads();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [selection, setSelection] = useState<TreeSelection | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [view, setView] = useState<'grid' | 'table'>('grid');

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.library
      .folders(server.id)
      .then((list) => {
        if (!live) return;
        setFolders(list);
        const first = list.find((candidate) => candidate.available) ?? list[0];
        setSelection(first === undefined ? null : { folderId: first.id, path: '' });
        if (first === undefined) setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(codeOf(cause));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, server.id]);

  useEffect(() => {
    if (selection === null || query.trim().length > 0) return;
    let live = true;
    setLoading(true);
    setError(null);
    api.library
      .entries(server.id, selection.folderId, { path: selection.path })
      .then((page) => {
        if (!live) return;
        setFolder(page.folder);
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(codeOf(cause));
        setEntries([]);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, server.id, selection, query]);

  // Debounced so a four-letter query does not fire four FTS5 searches across a tailnet hop.
  useEffect(() => {
    const term = query.trim();
    if (term.length === 0) {
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api.library
        .search(server.id, term, selection === null ? {} : { folderId: selection.folderId })
        .then((page) => {
          if (!live) return;
          setEntries(page.results);
          setNextCursor(page.nextCursor);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (live) setError(codeOf(cause));
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, server.id, query, selection]);

  const loadChildren = useCallback(
    async (folderId: string, path: string) => {
      const page = await api.library.entries(server.id, folderId, { path });
      return page.entries;
    },
    [api, server.id],
  );

  const sorted = useMemo(() => {
    const rows = [...entries];
    rows.sort((a, b) => {
      // Directories first in every ordering: a folder is a place, not a bigger file, and a
      // 0-byte directory sorted among files by size is nonsense.
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (sortKey === 'size') return (b.size ?? 0) - (a.size ?? 0);
      if (sortKey === 'date') return (b.mtime ?? 0) - (a.mtime ?? 0);
      return a.name.localeCompare(b.name, 'fa');
    });
    return rows;
  }, [entries, sortKey]);

  const canDownload = folder?.mode === 'full';
  const canUpload = folder?.writable === true && folder.mode === 'full';

  const open = (entry: Entry) => {
    if (entry.isDir) {
      setQuery('');
      setSelection({ folderId: entry.folderId, path: entry.path });
      return;
    }
    if (entry.kind === 'video' || entry.kind === 'audio') {
      if (folder !== null) onPlay(entry, folder);
    }
  };

  const download = (entry: Entry) => {
    void api.downloads.start({ serverId: server.id, fileId: entry.id });
  };

  const upload = async () => {
    if (folder === null) return;
    const picked = await api.uploads.pick();
    if (picked.length === 0) return;
    await api.uploads.start({ serverId: server.id, folderId: folder.id, sourcePaths: picked });
  };

  const columns: TableColumn<Entry>[] = [
    {
      id: 'name',
      header: t('files.name'),
      cell: (entry) => (
        <span className={styles.cellName}>
          {entry.isDir ? <FolderIcon size={16} /> : null}
          <span className={styles.ellipsis} title={entry.name}>
            {entry.name}
          </span>
          {!entry.isDir && !entry.browserPlayable ? (
            <Badge tone="warning" square>
              {t('files.notPlayable')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'size',
      header: t('files.size'),
      width: '110px',
      align: 'end',
      latin: true,
      cell: (entry) => (entry.isDir ? '—' : format.bytes(entry.size ?? 0)),
    },
    {
      id: 'date',
      header: t('files.date'),
      width: '150px',
      align: 'end',
      cell: (entry) => (entry.mtime === null ? '—' : format.date(entry.mtime, 'datetime')),
    },
    {
      id: 'actions',
      header: S.actionsColumn,
      width: '160px',
      align: 'end',
      cell: (entry) => (
        <span className={styles.rowActions}>
          {entry.isDir ? null : (
            <>
              {entry.kind === 'video' || entry.kind === 'audio' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={t('files.play')}
                  startIcon={<PlayIcon size={16} />}
                  onClick={() => open(entry)}
                />
              ) : null}
              {canDownload ? (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={t('files.download')}
                  startIcon={<DownloadIcon size={16} />}
                  onClick={() => download(entry)}
                />
              ) : null}
            </>
          )}
        </span>
      ),
    },
  ];

  const crumbs = selection === null ? [] : selection.path.split('/').filter((s) => s.length > 0);

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <Button
          variant="ghost"
          size="sm"
          startIcon={<ArrowBackIcon size={16} />}
          onClick={onBack}
        >
          {S.backToServers}
        </Button>
        <span className={styles.serverName}>{server.label}</span>
        <div className={styles.headerTools}>
          <Input
            aria-label={S.searchPlaceholder}
            placeholder={S.searchPlaceholder}
            value={query}
            inputSize="sm"
            fullWidth={false}
            startAdornment={<SearchIcon size={16} />}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            aria-label={S.sortLabel}
            options={SORT_OPTIONS}
            value={sortKey}
            selectSize="sm"
            fullWidth={false}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setView(view === 'grid' ? 'table' : 'grid')}
          >
            {view === 'grid' ? S.viewTable : S.viewGrid}
          </Button>
        </div>
      </header>

      <div className={styles.body}>
        <Panel title={S.foldersHeading} className={styles.sidebar} scrollBody flush>
          <FolderTree
            folders={folders}
            selection={selection}
            onSelect={(next) => {
              setQuery('');
              setSelection(next);
            }}
            loadChildren={loadChildren}
          />
        </Panel>

        <Panel
          className={styles.content}
          title={searching ? S.searchResults : (folder?.label ?? S.libraryTitle)}
          description={
            searching ? undefined : (
              <span className={styles.crumbs} dir="ltr">
                {crumbs.length === 0 ? '/' : `/${crumbs.join('/')}`}
              </span>
            )
          }
          actions={
            <>
              {selection !== null && selection.path.length > 0 && !searching ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelection({
                      folderId: selection.folderId,
                      path: selection.path.split('/').slice(0, -1).join('/'),
                    })
                  }
                >
                  {S.upOneLevel}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                startIcon={<UploadIcon size={16} />}
                disabled={!canUpload}
                title={canUpload ? undefined : S.uploadNotWritable}
                onClick={() => void upload()}
              >
                {S.uploadToFolder}
              </Button>
            </>
          }
          footerStart={
            nextCursor === null ? undefined : (
              // Said out loud rather than silently sorting a partial page: the ordering below
              // covers what has been fetched, not the whole folder.
              <span className={styles.moreNote}>
                {format.count(sorted.length)} — {t('common.more')}
              </span>
            )
          }
          scrollBody
        >
          {loading ? (
            <div className={styles.centre}>
              <Spinner size="md" labelled />
            </div>
          ) : error !== null ? (
            <EmptyState title={S.errorTitle} description={errorText(error)} />
          ) : sorted.length === 0 ? (
            <EmptyState
              icon={<FolderIcon size={24} />}
              title={t('files.empty')}
              description={folder?.available === false ? S.uploadNotWritable : undefined}
            />
          ) : view === 'grid' ? (
            <div className={styles.grid}>
              {sorted.map((entry) => (
                <FileGridItem
                  key={entry.id}
                  entry={entry}
                  // Phase 1 ships no ffmpeg, so there is no frame to show. The kit renders a
                  // designed icon tile for this, which is the honest state, not a failure.
                  posterUrl={null}
                  onOpen={() => open(entry)}
                  actions={
                    entry.isDir || !canDownload ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={t('files.download')}
                        startIcon={<DownloadIcon size={16} />}
                        onClick={() => download(entry)}
                      />
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <Table
              columns={columns}
              rows={sorted}
              getRowId={(entry) => entry.id}
              onRowClick={open}
              dense
            />
          )}
        </Panel>
      </div>

      <Panel
        title={S.transfersTitle}
        className={styles.transfers}
        description={canDownload ? undefined : S.downloadNotAllowed}
        scrollBody
        flush
      >
        <TransferQueue
          downloads={downloads}
          uploads={uploads}
          downloadDir={downloadDir}
          onPause={(id) => void api.downloads.pause(id)}
          onResume={(id) => void api.downloads.resume(id)}
          onCancel={(id) => void api.downloads.cancel(id)}
          onReveal={(id) => void api.downloads.reveal(id)}
          onCancelUpload={(id) => void api.uploads.cancel(id)}
        />
      </Panel>
    </div>
  );
}

/** Pull the stable code off whatever crossed the bridge; never match on the message. */
function codeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    // Electron wraps a thrown main-process error's message; the code is still in the text,
    // so the last resort is a lookup by the codes we know rather than by prose.
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string') {
      const match = /\b(folder_unavailable|download_not_allowed|forbidden|not_found|folder_closed|token_revoked|device_revoked|unauthenticated|edge_not_ready)\b/.exec(
        message,
      );
      if (match?.[1] !== undefined) return match[1];
    }
  }
  return 'internal';
}
