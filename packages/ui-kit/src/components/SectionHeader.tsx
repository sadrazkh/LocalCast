import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import styles from './SectionHeader.module.css';

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Already-formatted count string. Pass `formatCount(n, locale)`, never a raw number. */
  count?: string;
  actions?: ReactNode;
  /** Column-header scale: 12px, muted. Used above dense lists. */
  small?: boolean;
  /** Hairline rule underneath. */
  ruled?: boolean;
  /** Heading level for the document outline. Defaults to `h3`. */
  as?: 'h2' | 'h3' | 'h4';
}

export function SectionHeader({
  title,
  description,
  icon,
  count,
  actions,
  small = false,
  ruled = false,
  as: Heading = 'h3',
  className,
  ...rest
}: SectionHeaderProps) {
  return (
    <div
      className={cx(
        styles.header,
        small ? styles.small : undefined,
        ruled ? styles.ruled : undefined,
        className,
      )}
      {...rest}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <div className={styles.text}>
        <Heading className={styles.title}>{title}</Heading>
        {description ? <span className={styles.description}>{description}</span> : null}
      </div>
      {count !== undefined ? <span className={styles.count}>{count}</span> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
