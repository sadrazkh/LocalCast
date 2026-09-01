import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Leading dot, for a state that is also carried by colour. */
  dot?: boolean;
  /** Square corners instead of a pill — used inside dense table cells. */
  square?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

/**
 * A static status label: «در صف», «فعال», «در دسترس نیست».
 *
 * Never interactive — if it can be clicked it is a `Chip`. Colour is never the only carrier
 * of meaning here; the text always says the same thing the tone does.
 */
export function Badge({
  tone = 'neutral',
  dot = false,
  square = false,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cx(styles.badge, styles[tone], square ? styles.square : undefined, className)}
      {...rest}
    >
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {icon}
      {children}
    </span>
  );
}
