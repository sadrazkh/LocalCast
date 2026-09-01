import type { PrintJobStatus as PrintJobState } from '@localcast/contract';
import { useT } from '../i18n/index.js';
import type { MessageKey } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { AlertIcon, CheckIcon, ClockIcon, CloseIcon } from '../icons/index.js';
import { Badge } from './Badge.js';
import type { BadgeTone } from './Badge.js';
import styles from './PrintJobStatus.module.css';

const STATE: Record<PrintJobState, { key: MessageKey; tone: BadgeTone }> = {
  queued: { key: 'print.status.queued', tone: 'neutral' },
  printing: { key: 'print.status.printing', tone: 'accent' },
  done: { key: 'print.status.done', tone: 'success' },
  error: { key: 'print.status.error', tone: 'danger' },
  cancelled: { key: 'print.status.cancelled', tone: 'neutral' },
};

export interface PrintJobStatusProps {
  status: PrintJobState;
  /**
   * The spooler's own message. Shown in full — a print failure the operator can read
   * ("out of paper", "printer offline") is worth more than a tidy «خطا» on its own.
   */
  errorMessage?: string | null;
  className?: string;
}

/**
 * The print-job state indicator: در صف / در حال چاپ / انجام‌شده / خطا / لغو شد.
 *
 * «انجام‌شده» means the Windows spooler reported the job finished, not that a process
 * exited — see spec §7. This component only renders whatever state the server sends.
 */
export function PrintJobStatus({ status, errorMessage, className }: PrintJobStatusProps) {
  const t = useT();
  const state = STATE[status];

  const icon =
    status === 'printing' ? (
      <span className={styles.working} aria-hidden="true" />
    ) : status === 'done' ? (
      <CheckIcon size={12} />
    ) : status === 'error' ? (
      <AlertIcon size={12} />
    ) : status === 'cancelled' ? (
      <CloseIcon size={12} />
    ) : (
      <ClockIcon size={12} />
    );

  return (
    <span className={cx(styles.wrapper, className)}>
      <Badge tone={state.tone} icon={icon}>
        {t(state.key)}
      </Badge>
      {status === 'error' && errorMessage ? (
        <span className={styles.message}>{errorMessage}</span>
      ) : null}
    </span>
  );
}
