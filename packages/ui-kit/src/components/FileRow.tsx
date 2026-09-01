import type { ReactNode } from 'react';
import type { MediaKind } from '@localcast/contract';
import { useFormat, useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { FolderIcon, MediaKindIcon } from '../icons/index.js';
import { Badge } from './Badge.js';
import styles from './FileRow.module.css';

export interface FileRowEntry {
  id: string;
  name: string;
  kind: MediaKind;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
  /** False for MKV containers and AC3/DTS payloads — phase 1 ships no ffmpeg. */
  browserPlayable?: boolean;
}

export interface FileRowProps {
  entry: FileRowEntry;
  onOpen?: () => void;
  /** Trailing controls: play, download, print. Rendered outside the row's own hit area. */
  actions?: ReactNode;
  selected?: boolean;
  className?: string;
}

/**
 * One entry in a list view: kind icon, name, size and date, then the action slot.
 *
 * Size stays ASCII and monospace while the date follows the locale's digits — the split
 * enforced by `formatBytes` and `formatDate`. A size is compared against Explorer; a date is
 * only read.
 *
 * When `actions` are present the row body is a `<button>` and the actions sit beside it
 * rather than inside it, so the two hit areas do not nest.
 */
export function FileRow({ entry, onOpen, actions, selected = false, className }: FileRowProps) {
  const t = useT();
  const format = useFormat();

  const body = (
    <>
      <span className={styles.icon} aria-hidden="true">
        {entry.isDir ? <FolderIcon size={18} /> : <MediaKindIcon kind={entry.kind} size={18} />}
      </span>
      <span className={styles.body}>
        <span className={styles.name} title={entry.name}>
          {entry.name}
        </span>
        <span className={styles.meta}>
          {entry.isDir ? (
            <span>{t('files.folder')}</span>
          ) : (
            <span className={styles.latin}>{format.bytes(entry.size ?? 0)}</span>
          )}
          {entry.mtime !== null ? (
            <>
              <span className={styles.separator} aria-hidden="true">
                ·
              </span>
              <span>{format.date(entry.mtime)}</span>
            </>
          ) : null}
        </span>
      </span>
    </>
  );

  const notes =
    !entry.isDir && entry.browserPlayable === false ? (
      <span className={styles.notes}>
        <Badge tone="warning" square>
          {t('files.notPlayable')}
        </Badge>
      </span>
    ) : null;

  if (!onOpen) {
    return (
      <div className={cx(styles.row, selected ? styles.selected : undefined, className)}>
        {body}
        {notes}
        {actions ? <span className={styles.actions}>{actions}</span> : null}
      </div>
    );
  }

  if (!actions) {
    return (
      <button
        type="button"
        className={cx(
          styles.row,
          styles.clickable,
          selected ? styles.selected : undefined,
          className,
        )}
        onClick={onOpen}
      >
        {body}
        {notes}
      </button>
    );
  }

  return (
    <div className={cx(styles.row, selected ? styles.selected : undefined, className)}>
      <button type="button" className={styles.rowButton} onClick={onOpen}>
        {body}
      </button>
      {notes}
      <span className={styles.actions}>{actions}</span>
    </div>
  );
}
