import { Button, MediaKindIcon, ProgressBar, UploadIcon, useFormat } from '@localcast/ui-kit';
import type { ProgressTone } from '@localcast/ui-kit';
import type { DownloadJob, UploadJob } from '../../shared/ipc.js';
import { errorText, S } from '../strings.js';
import styles from './TransferQueue.module.css';

/**
 * The transfer rows at the foot of screen 06 — downloads and uploads in one list.
 *
 * The numbers are ASCII by contract: a byte count is compared against Explorer and pasted
 * into support threads, so `formatBytes` never localises its digits. The percentage beside
 * it is a user-facing fraction and therefore does follow the locale — that split is the whole
 * point of `formatBytes` and `formatPercent` being different functions.
 *
 * A failed row states the reason from its stable `ErrorCode`, never by matching on the
 * server's prose. «در حالت فقط پخش دانلود ممکن نیست» is an answer; "request failed" is not.
 */

const DOWNLOAD_LABEL: Record<DownloadJob['status'], string> = {
  queued: S.transferQueued,
  downloading: S.transferDownloading,
  paused: S.transferPaused,
  done: S.transferDone,
  error: S.transferError,
  cancelled: S.transferCancelled,
};

const DOWNLOAD_TONE: Record<DownloadJob['status'], ProgressTone> = {
  queued: 'accent',
  downloading: 'accent',
  paused: 'warning',
  done: 'success',
  error: 'danger',
  cancelled: 'warning',
};

const UPLOAD_LABEL: Record<UploadJob['status'], string> = {
  queued: S.transferQueued,
  uploading: S.transferUploading,
  done: S.transferDone,
  error: S.transferError,
  cancelled: S.transferCancelled,
};

export interface TransferQueueProps {
  downloads: DownloadJob[];
  uploads: UploadJob[];
  downloadDir: string;
  onPause: (jobId: string) => void;
  onResume: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onReveal: (jobId: string) => void;
  onCancelUpload: (jobId: string) => void;
}

export function TransferQueue({
  downloads,
  uploads,
  downloadDir,
  onPause,
  onResume,
  onCancel,
  onReveal,
  onCancelUpload,
}: TransferQueueProps) {
  const format = useFormat();

  if (downloads.length === 0 && uploads.length === 0) {
    return (
      <div className={styles.empty}>
        <span>{S.transfersEmpty}</span>
        <span className={styles.path} dir="ltr" title={downloadDir}>
          {S.transfersSavedTo}: {downloadDir}
        </span>
      </div>
    );
  }

  return (
    <ul className={styles.list}>
      {downloads.map((job) => {
        const fraction =
          job.totalBytes === null || job.totalBytes === 0
            ? null
            : job.receivedBytes / job.totalBytes;
        return (
          <li key={job.id} className={styles.row} data-status={job.status}>
            <span className={styles.icon} aria-hidden="true">
              <MediaKindIcon kind={job.kind} size={18} />
            </span>
            <div className={styles.body}>
              <div className={styles.head}>
                <span className={styles.name} title={job.fileName}>
                  {job.fileName}
                </span>
                <span className={styles.status}>
                  {job.status === 'error' ? errorText(job.errorCode) : DOWNLOAD_LABEL[job.status]}
                </span>
              </div>
              <ProgressBar
                value={job.status === 'done' ? 1 : fraction}
                tone={DOWNLOAD_TONE[job.status]}
                size="sm"
                valueText={
                  <span className={styles.bytes} dir="ltr">
                    {format.bytes(job.receivedBytes)}
                    {job.totalBytes === null ? '' : ` / ${format.bytes(job.totalBytes)}`}
                  </span>
                }
              />
            </div>
            <div className={styles.actions}>
              {job.status === 'downloading' || job.status === 'queued' ? (
                <Button variant="ghost" size="sm" onClick={() => onPause(job.id)}>
                  {S.transferPause}
                </Button>
              ) : null}
              {job.status === 'paused' || job.status === 'error' ? (
                <Button variant="secondary" size="sm" onClick={() => onResume(job.id)}>
                  {S.transferResume}
                </Button>
              ) : null}
              {job.status === 'done' ? (
                <Button variant="ghost" size="sm" onClick={() => onReveal(job.id)}>
                  {S.transferReveal}
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => onCancel(job.id)}>
                  {S.transferCancel}
                </Button>
              )}
            </div>
          </li>
        );
      })}

      {uploads.map((job) => (
        <li key={job.id} className={styles.row} data-status={job.status}>
          <span className={styles.icon} aria-hidden="true">
            <UploadIcon size={18} />
          </span>
          <div className={styles.body}>
            <div className={styles.head}>
              <span className={styles.name} title={job.relativePath}>
                {job.relativePath}
              </span>
              <span className={styles.status}>
                {job.status === 'error' ? errorText(job.errorCode) : UPLOAD_LABEL[job.status]}
              </span>
            </div>
            <ProgressBar
              value={job.totalBytes === 0 ? null : job.sentBytes / job.totalBytes}
              tone={job.status === 'error' ? 'danger' : job.status === 'done' ? 'success' : 'accent'}
              size="sm"
              valueText={
                <span className={styles.bytes} dir="ltr">
                  {format.bytes(job.sentBytes)} / {format.bytes(job.totalBytes)}
                </span>
              }
            />
          </div>
          <div className={styles.actions}>
            {job.status === 'uploading' || job.status === 'queued' ? (
              <Button variant="ghost" size="sm" onClick={() => onCancelUpload(job.id)}>
                {S.transferCancel}
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
