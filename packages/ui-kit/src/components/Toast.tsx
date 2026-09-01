import type { ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from '../icons/index.js';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

const TONE_ICON: Record<ToastTone, (props: { size?: number }) => ReactNode> = {
  info: InfoIcon,
  success: CheckIcon,
  warning: AlertIcon,
  danger: AlertIcon,
};

export interface ToastProps {
  tone?: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  /** A single follow-up control, e.g. «تلاش دوباره». */
  action?: ReactNode;
  onDismiss?: () => void;
  icon?: ReactNode;
  className?: string;
}

/**
 * One transient message.
 *
 * `role="status"` for the quiet tones and `role="alert"` for danger: an error the operator
 * must act on interrupts, a "saved" confirmation does not. Getting this the other way round
 * produces a screen reader that talks over itself all day and gets muted.
 */
export function Toast({
  tone = 'info',
  title,
  description,
  action,
  onDismiss,
  icon,
  className,
}: ToastProps) {
  const t = useT();
  const ToneIcon = TONE_ICON[tone];

  return (
    <div
      className={cx(styles.toast, styles[tone], className)}
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
    >
      <span className={styles.icon}>{icon ?? <ToneIcon size={16} />}</span>
      <div className={styles.body}>
        <span className={styles.title}>{title}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </div>
      {action ? <div className={styles.actions}>{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label={t('common.dismiss')}
        >
          <CloseIcon size={14} />
        </button>
      ) : null}
    </div>
  );
}

export interface ToastViewportProps {
  children: ReactNode;
  className?: string;
}

/**
 * The stack the toasts live in. Presentational: queueing, timers and dismissal belong to
 * the app, which is the only layer that knows whether a message is still true.
 */
export function ToastViewport({ children, className }: ToastViewportProps) {
  const t = useT();
  return (
    <div className={cx(styles.viewport, className)} role="region" aria-label={t('a11y.notification')}>
      {children}
    </div>
  );
}
