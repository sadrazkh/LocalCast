import type { ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import styles from './TabBar.module.css';

export interface TabBarItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon: ReactNode;
  /** A dot over the icon — an offline queue with items in it, a failed job. */
  attention?: boolean;
  disabled?: boolean;
}

export interface TabBarProps<T extends string = string> {
  items: readonly TabBarItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Pins the bar to the bottom of the viewport. Off when the app owns the layout. */
  fixed?: boolean;
  label?: string;
  className?: string;
}

/**
 * The mobile bottom bar: کتابخانه / جست‌وجو / آفلاین / سرورها.
 *
 * `<nav>` with `aria-current="page"` rather than a tablist, because these are destinations
 * and not panels of one view — a screen reader user should hear "navigation", and the back
 * gesture should mean what it usually means.
 *
 * Labels are always visible. Icon-only bottom bars test badly in Persian, where the icon
 * metaphors are less established and «آفلاین» versus «سرورها» is not guessable from a glyph.
 */
export function TabBar<T extends string = string>({
  items,
  value,
  onChange,
  fixed = false,
  label,
  className,
}: TabBarProps<T>) {
  const t = useT();

  return (
    <nav
      className={cx(styles.bar, fixed ? styles.fixed : undefined, className)}
      aria-label={label ?? t('nav.primary')}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            className={cx(styles.item, active ? styles.active : undefined)}
            aria-current={active ? 'page' : undefined}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
          >
            <span className={styles.icon}>{item.icon}</span>
            <span className={styles.label}>{item.label}</span>
            {item.attention ? <span className={styles.dot} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </nav>
  );
}
