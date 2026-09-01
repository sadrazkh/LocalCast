import { useState } from 'react';
import type { DragEvent } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  FolderIcon,
  Panel,
  RefreshIcon,
  Spinner,
  Switch,
  Table,
  TrashIcon,
  cx,
  useFormat,
  useT,
} from '@localcast/ui-kit';
import type { MessageKey, TableColumn } from '@localcast/ui-kit';
import { getApi, updateFolder } from '../lib/api.js';
import type { AdminFolder } from '../lib/api.js';
import { useCopy } from '../lib/copy.js';
import { useConfirm, useToast } from '../lib/feedback.js';
import { messageOf } from '../lib/useAsync.js';
import { useLibrary } from '../state/library.js';
import styles from './FoldersScreen.module.css';

const KIND_LABEL: Record<string, MessageKey> = {
  video: 'folders.kind.video',
  documents: 'folders.kind.documents',
  photos: 'folders.kind.photos',
  mixed: 'folders.kind.mixed',
};

/** `path.basename` for a Windows or POSIX path, without pulling Node into the renderer. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Screen 01 — «پوشه‌های اشتراکی».
 *
 * Removing a folder confirms first and says what removal does and does not do: the files
 * stay on disk. An operator who thinks «برداشتن» might delete their archive will never press
 * it, and one who assumes it does not will press it at exactly the wrong moment.
 */
export function FoldersScreen() {
  const t = useT();
  const c = useCopy();
  const format = useFormat();
  const confirm = useConfirm();
  const toast = useToast();
  const { folders, reloadFolders, loading, error } = useLibrary();
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);

  const report = (err: unknown) => toast({ tone: 'danger', title: messageOf(err) });

  const addPath = async (path: string) => {
    setBusy(true);
    try {
      await getApi().folders.add({ path, label: baseName(path), kind: 'mixed', writable: false });
      await reloadFolders();
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  const pickAndAdd = async () => {
    try {
      const path = await getApi().folders.pick();
      if (path) await addPath(path);
    } catch (err) {
      report(err);
    }
  };

  /**
   * Electron removed `File.path` in v32; the replacement, `webUtils.getPathForFile`, has to
   * be called from the preload script and this app's bridge does not expose it. So a drop is
   * accepted, the legacy property is used when it happens to be there, and otherwise the drop
   * opens the folder picker — which is a working gesture rather than a dead target.
   */
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    const file = event.dataTransfer.files[0];
    const path = (file as (File & { path?: string }) | undefined)?.path;
    if (path) void addPath(path);
    else void pickAndAdd();
  };

  const patch = async (folder: AdminFolder, next: Parameters<typeof updateFolder>[1]) => {
    try {
      await updateFolder(folder.id, next);
      await reloadFolders();
    } catch (err) {
      report(err);
    }
  };

  const reindex = async (id?: string) => {
    try {
      await getApi().folders.reindex(id);
      await reloadFolders();
    } catch (err) {
      report(err);
    }
  };

  const remove = async (folder: AdminFolder) => {
    const accepted = await confirm({
      title: c('folders.remove'),
      body: c('folders.removeConfirm', { label: folder.label }),
      confirmLabel: c('folders.remove'),
      danger: true,
    });
    if (!accepted) return;
    try {
      await getApi().folders.remove(folder.id);
      await reloadFolders();
    } catch (err) {
      report(err);
    }
  };

  const columns: TableColumn<AdminFolder>[] = [
    {
      id: 'path',
      header: c('folders.path'),
      cell: (folder) => (
        <div className={styles.pathCell}>
          <span className={styles.label}>
            {folder.label}
            {folder.available ? null : (
              <Badge tone="warning">{t('folders.unavailable')}</Badge>
            )}
            {folder.writable ? <Badge tone="neutral">{t('folders.writable')}</Badge> : null}
          </span>
          <span className={styles.path} title={folder.path}>
            {folder.path}
          </span>
        </div>
      ),
    },
    {
      id: 'size',
      header: t('files.size'),
      align: 'end',
      latin: true,
      cell: (folder) => (
        <div className={styles.sizeCell}>
          <span>{folder.totalBytes === null ? '—' : format.bytes(folder.totalBytes)}</span>
          <span className={styles.sub}>
            {folder.fileCount === null ? '' : format.count(folder.fileCount)}
          </span>
        </div>
      ),
    },
    {
      id: 'kind',
      header: t('files.kind'),
      width: '84px',
      cell: (folder) => t(KIND_LABEL[folder.kind] ?? 'folders.kind.mixed'),
    },
    {
      id: 'indexed',
      header: t('folders.lastIndexed'),
      width: '132px',
      cell: (folder) =>
        folder.lastIndexedAt === null
          ? c('folders.never')
          : format.date(folder.lastIndexedAt, 'datetime'),
    },
    {
      id: 'autoIndex',
      header: c('folders.autoIndex'),
      width: '96px',
      cell: (folder) => (
        <Switch
          checked={folder.autoIndex}
          onChange={(checked) => void patch(folder, { autoIndex: checked })}
          aria-label={`${c('folders.autoIndex')} — ${folder.label}`}
        />
      ),
    },
    {
      id: 'share',
      header: c('folders.share'),
      width: '84px',
      cell: (folder) => (
        <Switch
          checked={folder.enabled}
          onChange={(checked) => void patch(folder, { enabled: checked })}
          aria-label={`${c('folders.share')} — ${folder.label}`}
        />
      ),
    },
    {
      id: 'actions',
      header: '',
      width: '92px',
      align: 'end',
      cell: (folder) => (
        <div className={styles.rowActions}>
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label={`${c('folders.rescan')} — ${folder.label}`}
            startIcon={<RefreshIcon size={14} />}
            onClick={() => void reindex(folder.id)}
          />
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label={`${c('folders.remove')} — ${folder.label}`}
            startIcon={<TrashIcon size={14} />}
            onClick={() => void remove(folder)}
          />
        </div>
      ),
    },
  ];

  return (
    <Panel
      title={t('folders.title')}
      actions={
        <>
          <Button variant="ghost" startIcon={<RefreshIcon size={14} />} onClick={() => void reindex()}>
            {c('folders.rescanAll')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            startIcon={<FolderIcon size={14} />}
            onClick={() => void pickAndAdd()}
          >
            {t('folders.add')}
          </Button>
        </>
      }
    >
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div
        className={cx(styles.drop, dropping ? styles.dropActive : undefined)}
        onDragOver={(event) => {
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        <Table<AdminFolder>
          columns={columns}
          rows={folders}
          getRowId={(folder) => folder.id}
          caption={t('folders.title')}
          empty={
            // A first load must not flash «هنوز پوشه‌ای…» before the answer arrives; an
            // operator who sees that for a moment believes their folders are gone.
            loading ? (
              <Spinner labelled />
            ) : (
              <EmptyState
                icon={<FolderIcon size={22} />}
                title={t('folders.empty')}
                description={c('folders.emptyHint')}
                actions={
                  <Button variant="primary" onClick={() => void pickAndAdd()}>
                    {t('folders.add')}
                  </Button>
                }
              />
            )
          }
        />
        <p className={styles.dropHint}>
          <span>{c('folders.dropHere')}</span>
          <span className={styles.sub}>{c('folders.dropHint')}</span>
        </p>
      </div>
    </Panel>
  );
}
