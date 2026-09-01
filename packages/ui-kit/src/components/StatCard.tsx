import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import styles from './StatCard.module.css';

export type StatTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  /**
   * Already formatted. Pass `formatCount(n, locale)` for a count and `formatBytes(n)` for a
   * size — the component will not guess, because guessing is how the Persian/ASCII digit
   * rule gets broken one card at a time.
   */
  value: ReactNode;
  /** Set for values that must stay ASCII and LTR: sizes, addresses, uptimes. */
  latin?: boolean;
  icon?: ReactNode;
  footer?: ReactNode;
  tone?: StatTone;
}

/** A single figure with its label: shared folders, connected devices, total size, uptime. */
export function StatCard({
  label,
  value,
  latin = false,
  icon,
  footer,
  tone = 'neutral',
  className,
  ...rest
}: StatCardProps) {
  return (
    <div className={cx(styles.card, styles[`tone-${tone}`], className)} {...rest}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        {icon ? <span className={styles.icon}>{icon}</span> : null}
      </div>
      <div className={cx(styles.value, latin ? styles.latin : undefined)}>{value}</div>
      {footer ? <div className={styles.foot}>{footer}</div> : null}
    </div>
  );
}
