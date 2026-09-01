import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import styles from './EmptyState.module.css';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}

/**
 * "There is nothing here, and here is why" — never a blank rectangle.
 *
 * The description is the important half: «هیچ دستگاهی جفت نشده است» on its own leaves the
 * operator stuck, while «کد QR را با دوربین گوشی اسکن کنید» tells them what to do next.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  compact = false,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div className={cx(styles.empty, compact ? styles.compact : undefined, className)} {...rest}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
