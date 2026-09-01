import type { ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import styles from './NavRail.module.css';

export interface NavRailItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon: ReactNode;
  /** Already-formatted count — `formatCount(n, locale)`, never a raw number. */
  count?: string;
  disabled?: boolean;
}

export interface NavRailProps<T extends string = string> {
  items: readonly NavRailItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Product mark and the connection dot. */
  header?: ReactNode;
  footer?: ReactNode;
  label?: string;
  className?: string;
}

/**
 * The Windows panel's left (in Persian, right) navigation rail.
 *
 * `<nav>` + `<ul>` + buttons carrying `aria-current="page"`, so assistive tech treats it as
 * navigation and announces which destination is open. The rule sits on `border-inline-end`,
 * which puts it against the content column in both directions with no override.
 */
export function NavRail<T extends string = string>({
  items,
  value,
  onChange,
  header,
  footer,
  label,
  className,
}: NavRailProps<T>) {
  const t = useT();

  return (
    <nav className={cx(styles.rail, className)} aria-label={label ?? t('nav.primary')}>
      {header ? <div className={styles.header}>{header}</div> : null}
      <ul className={styles.list}>
        {items.map((item) => {
          const active = item.id === value;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={cx(styles.item, active ? styles.active : undefined)}
                aria-current={active ? 'page' : undefined}
                disabled={item.disabled}
                onClick={() => onChange(item.id)}
              >
                <span className={styles.icon}>{item.icon}</span>
                <span className={styles.label}>{item.label}</span>
                {item.count !== undefined ? (
                  <span className={styles.count}>{item.count}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </nav>
  );
}
