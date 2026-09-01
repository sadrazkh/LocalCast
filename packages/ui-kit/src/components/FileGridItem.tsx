import type { ReactNode } from 'react';
import type { MediaKind } from '@localcast/contract';
import { useFormat, useT } from '../i18n/index.js';
import type { MessageKey } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { FolderIcon, MediaKindIcon } from '../icons/index.js';
import styles from './FileGridItem.module.css';

const KIND_LABEL: Record<MediaKind, MessageKey> = {
  video: 'files.kind.video',
  audio: 'files.kind.audio',
  image: 'files.kind.image',
  document: 'files.kind.document',
  archive: 'files.kind.archive',
  other: 'files.kind.other',
};

export interface FileGridItemEntry {
  id: string;
  name: string;
  kind: MediaKind;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
}

export interface FileGridItemProps {
  entry: FileGridItemEntry;
  /**
   * Poster image URL, when one exists.
   *
   * Phase 1 ships no ffmpeg and therefore extracts no video frames, so this is `null` for
   * every video in the library. That is the *normal* path, not an error path — see the
   * fallback below.
   */
  posterUrl?: string | null;
  /** Already-formatted duration overlay, e.g. `1:42:07`. ASCII by contract. */
  duration?: string;
  onOpen?: () => void;
  /** Floating controls over the thumbnail. */
  actions?: ReactNode;
  selected?: boolean;
  className?: string;
}

/**
 * A library tile.
 *
 * Shows the poster when one is supplied and the media-kind icon when one is not. The
 * fallback is a designed state: a centred icon with the kind named under it, on the same
 * tile shape the poster would occupy, so a grid of icon tiles looks like a deliberate view
 * rather than a page of broken images. Since phase 1 ships no frame extraction, this is what
 * the library looks like for almost every video.
 */
export function FileGridItem({
  entry,
  posterUrl = null,
  duration,
  onOpen,
  actions,
  selected = false,
  className,
}: FileGridItemProps) {
  const t = useT();
  const format = useFormat();

  const thumb = (
    <span className={styles.thumb} data-poster={posterUrl ? 'image' : 'fallback'}>
      {posterUrl ? (
        <img className={styles.poster} src={posterUrl} alt="" loading="lazy" />
      ) : (
        <span className={styles.fallback}>
          {entry.isDir ? (
            <FolderIcon size={24} />
          ) : (
            <MediaKindIcon kind={entry.kind} size={24} />
          )}
          <span className={styles.fallbackLabel}>
            {entry.isDir ? t('files.folder') : t(KIND_LABEL[entry.kind])}
          </span>
        </span>
      )}
      {duration ? <span className={styles.duration}>{duration}</span> : null}
    </span>
  );

  const body = (
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
  );

  const classes = cx(
    styles.item,
    onOpen ? styles.clickable : undefined,
    selected ? styles.selected : undefined,
    className,
  );

  if (!onOpen) {
    return (
      <div className={classes}>
        {thumb}
        {body}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    );
  }

  // Actions are rendered as siblings of the open button, never inside it: a button nested
  // in a button is invalid and browsers drop the inner one from the tab order.
  return (
    <div className={classes}>
      <button type="button" className={styles.rowButton} onClick={onOpen}>
        {thumb}
        {body}
      </button>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
