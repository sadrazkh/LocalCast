import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import styles from './Dropdown.module.css';

export interface DropdownItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Destructive entries — revoke a device, remove a folder. */
  danger?: boolean;
  /** Draws a rule above this entry. */
  separatorBefore?: boolean;
}

export interface DropdownProps {
  /** Rendered inside the trigger button. */
  trigger: ReactNode;
  items: readonly DropdownItem[];
  align?: 'start' | 'end';
  /** Accessible name for the trigger when its content is only an icon. */
  triggerLabel?: string;
  triggerClassName?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * A menu button.
 *
 * Keyboard contract: ArrowDown opens and lands on the first entry, ArrowUp/ArrowDown move
 * and wrap, Home/End jump, Escape closes and returns focus to the trigger. Up/Down rather
 * than Left/Right because a menu is a vertical list — its axis does not flip with the
 * document direction, only its inline alignment does, and that is handled in CSS.
 */
export function Dropdown({
  trigger,
  items,
  align = 'start',
  triggerLabel,
  triggerClassName,
  className,
  disabled = false,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useDomId('lc-menu');

  // A menu that stays open when the operator clicks elsewhere is a menu that ends up
  // floating over the next screen.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const focusItem = (index: number) => {
    const enabled = items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => !item.disabled)
      .map(({ i }) => i);
    if (enabled.length === 0) return;
    const wrapped = ((index % enabled.length) + enabled.length) % enabled.length;
    const target = enabled[wrapped];
    if (target === undefined) return;
    itemRefs.current[target]?.focus();
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
    const current = enabled.indexOf(
      itemRefs.current.findIndex((node) => node === document.activeElement),
    );

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(enabled.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className={cx(styles.wrapper, className)} ref={wrapperRef}>
      <button
        type="button"
        ref={triggerRef}
        className={cx(styles.trigger, triggerClassName)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            // The menu is not in the DOM until this render commits.
            window.setTimeout(() => focusItem(0), 0);
          }
        }}
      >
        {trigger}
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          className={cx(styles.menu, align === 'end' ? styles.alignEnd : styles.alignStart)}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <div key={item.id}>
              {item.separatorBefore ? <div className={styles.separator} role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                className={cx(styles.item, item.danger ? styles.danger : undefined)}
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect();
                  close(true);
                }}
              >
                {item.icon ? <span className={styles.itemIcon}>{item.icon}</span> : null}
                <span className={styles.itemLabel}>{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
