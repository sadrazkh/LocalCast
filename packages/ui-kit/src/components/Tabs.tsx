import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useLocale } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import styles from './Tabs.module.css';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Already-formatted trailing text, usually a count. */
  trailing?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accent-coloured active tab, for a primary navigation row. */
  accented?: boolean;
  /** Accessible name for the tablist, e.g. «فعالیت». */
  label?: string;
  className?: string;
}

/**
 * A tablist with roving tabindex.
 *
 * The arrow keys are mapped through the document direction: in Persian the *next* tab is
 * physically to the left, so ArrowLeft moves forward. Hard-coding ArrowRight as "next" is
 * the single most common RTL keyboard bug and it is invisible in an English-only test pass.
 */
export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  accented = false,
  label,
  className,
}: TabsProps<T>) {
  const { dir } = useLocale();
  const baseId = useDomId('lc-tabs');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, delta: number) => {
    const count = items.length;
    for (let step = 1; step <= count; step += 1) {
      const index = (((from + delta * step) % count) + count) % count;
      const item = items[index];
      if (item && !item.disabled) {
        onChange(item.id);
        tabRefs.current[index]?.focus();
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';

    if (event.key === forward) {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === backward) {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      move(-1, 1);
    } else if (event.key === 'End') {
      event.preventDefault();
      move(items.length, -1);
    }
  };

  return (
    <div role="tablist" aria-label={label} className={cx(styles.tablist, className)}>
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${baseId}-panel-${item.id}`}
            // Roving tabindex: exactly one tab is in the tab order; the arrows do the rest.
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            className={cx(
              styles.tab,
              accented ? styles.accented : undefined,
              selected ? styles.active : undefined,
            )}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
            <span>{item.label}</span>
            {item.trailing !== undefined ? (
              <span className={styles.trailing}>{item.trailing}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** Must match the `TabItem.id` this panel belongs to. */
  tabId: string;
  /** The `Tabs` instance id, if the caller renders panels outside the `Tabs` subtree. */
  baseId?: string;
  hidden?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The region a tab controls. Kept separate from `Tabs` because the panel usually lives in a
 * different part of the layout — a full-height content column next to a tab strip.
 */
export function TabPanel({ tabId, baseId, hidden = false, className, children }: TabPanelProps) {
  const generated = useDomId('lc-tabs');
  const base = baseId ?? generated;
  return (
    <div
      role="tabpanel"
      id={`${base}-panel-${tabId}`}
      aria-labelledby={`${base}-tab-${tabId}`}
      hidden={hidden}
      tabIndex={0}
      className={cx(styles.panel, className)}
    >
      {children}
    </div>
  );
}
