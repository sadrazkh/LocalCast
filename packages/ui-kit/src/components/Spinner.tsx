import type { HTMLAttributes } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import styles from './Spinner.module.css';

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  size?: SpinnerSize;
  /** Renders the ring against an accent-filled background instead of a dark surface. */
  onAccent?: boolean;
  /**
   * Announce the busy state. Off when the spinner sits inside a control that already says
   * `aria-busy` — otherwise a screen reader hears "Working" twice for one action.
   */
  labelled?: boolean;
}

export function Spinner({
  size = 'md',
  onAccent = false,
  labelled = false,
  className,
  ...rest
}: SpinnerProps) {
  const t = useT();
  return (
    <span
      className={cx(styles.spinner, styles[size], onAccent ? styles.onAccent : undefined, className)}
      role={labelled ? 'status' : undefined}
      aria-label={labelled ? t('a11y.busy') : undefined}
      aria-hidden={labelled ? undefined : true}
      {...rest}
    />
  );
}
