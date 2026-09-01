import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import styles from './Card.module.css';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> {
  padding?: CardPadding;
  /** Turns the card into a `<button>`; do not put other buttons inside one. */
  onClick?: () => void;
  selected?: boolean;
  /** Greyed presentation for a subject that exists but is currently unavailable. */
  muted?: boolean;
  children: ReactNode;
}

export function Card({
  padding = 'md',
  onClick,
  selected = false,
  muted = false,
  className,
  children,
  ...rest
}: CardProps) {
  const classes = cx(
    styles.card,
    styles[`padding-${padding}`],
    onClick ? styles.interactive : undefined,
    selected ? styles.selected : undefined,
    muted ? styles.muted : undefined,
    className,
  );

  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} aria-pressed={selected}>
        {children}
      </button>
    );
  }

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
