import type { ReactNode } from 'react';
import { useFormat, useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import styles from './ProgressBar.module.css';

export type ProgressTone = 'accent' | 'success' | 'warning' | 'danger';

export interface ProgressBarProps {
  /** 0…1. Pass `null` for work whose size is unknown — an upload before the first PATCH. */
  value: number | null;
  label?: ReactNode;
  /** Shows the percentage at the trailing end, in the locale's digits. */
  showValue?: boolean;
  /** Overrides the percentage text — e.g. `4.2 GB / 18 GB`, which must stay ASCII. */
  valueText?: ReactNode;
  tone?: ProgressTone;
  size?: 'sm' | 'md';
  className?: string;
}

export function ProgressBar({
  value,
  label,
  showValue = false,
  valueText,
  tone = 'accent',
  size = 'md',
  className,
}: ProgressBarProps) {
  const t = useT();
  const format = useFormat();
  const indeterminate = value === null || !Number.isFinite(value);
  const clamped = indeterminate ? 0 : Math.min(1, Math.max(0, value));

  const trailing =
    valueText ?? (showValue && !indeterminate ? format.percent(clamped) : undefined);

  return (
    <div className={cx(styles.wrapper, styles[`tone-${tone}`], className)}>
      {label || trailing ? (
        <div className={styles.labelRow}>
          {label ? <span className={styles.label}>{label}</span> : null}
          {trailing ? <span className={styles.valueText}>{trailing}</span> : null}
        </div>
      ) : null}
      <div
        className={cx(styles.track, styles[size])}
        role="progressbar"
        aria-label={label ? undefined : t('a11y.progress')}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate ? undefined : Math.round(clamped * 100)}
      >
        <div
          className={cx(styles.fill, indeterminate ? styles.indeterminate : undefined)}
          style={indeterminate ? undefined : { inlineSize: `${clamped * 100}%` }}
        />
      </div>
    </div>
  );
}
