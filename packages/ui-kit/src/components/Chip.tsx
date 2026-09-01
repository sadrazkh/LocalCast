import type { MouseEvent, ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { CloseIcon } from '../icons/index.js';
import styles from './Chip.module.css';

export interface ChipProps {
  children: ReactNode;
  icon?: ReactNode;
  /** Makes the chip a toggle button with `aria-pressed`. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  selected?: boolean;
  disabled?: boolean;
  /** Adds a trailing × . Pass `removeLabel` when «برداشتن» is not specific enough. */
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
  title?: string;
}

/**
 * An interactive token: a search filter, a selected folder, a media-kind facet.
 *
 * When `onClick` is present the chip toggles through a real `<button>` with `aria-pressed`,
 * so it is reachable by Tab and toggled with Space — a `<div onClick>` here would leave
 * keyboard users unable to filter anything.
 *
 * A removable *and* clickable chip renders as a container holding two sibling buttons rather
 * than a button inside a button, which is invalid HTML and which browsers resolve by
 * dropping the inner control from the tab order.
 */
export function Chip({
  children,
  icon,
  onClick,
  selected = false,
  disabled = false,
  onRemove,
  removeLabel,
  className,
  title,
}: ChipProps) {
  const t = useT();
  const interactive = Boolean(onClick);

  const classes = cx(
    styles.chip,
    interactive ? styles.interactive : undefined,
    selected ? styles.selected : undefined,
    disabled ? styles.disabled : undefined,
    className,
  );

  const removeButton = onRemove ? (
    <button
      type="button"
      className={styles.remove}
      aria-label={removeLabel ?? t('common.remove')}
      disabled={disabled}
      onClick={onRemove}
    >
      <CloseIcon size={12} />
    </button>
  ) : null;

  if (!interactive) {
    return (
      <span className={classes} title={title}>
        {icon}
        <span>{children}</span>
        {removeButton}
      </span>
    );
  }

  if (!onRemove) {
    return (
      <button
        type="button"
        className={classes}
        onClick={onClick}
        aria-pressed={selected}
        disabled={disabled}
        title={title}
      >
        {icon}
        <span>{children}</span>
      </button>
    );
  }

  return (
    <span className={classes} title={title}>
      <button
        type="button"
        className={styles.body}
        onClick={onClick}
        aria-pressed={selected}
        disabled={disabled}
      >
        {icon}
        <span>{children}</span>
      </button>
      {removeButton}
    </span>
  );
}
