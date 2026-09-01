import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { AccessMode } from '@localcast/contract';
import { useLocale, useT } from '../i18n/index.js';
import type { MessageKey } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import styles from './AccessModeSelector.module.css';

export const ACCESS_MODES: readonly AccessMode[] = ['full', 'stream', 'none'];

const MODE_LABEL: Record<AccessMode, MessageKey> = {
  full: 'access.full',
  stream: 'access.stream',
  none: 'access.none',
};

const MODE_HINT: Record<AccessMode, MessageKey> = {
  full: 'access.fullHint',
  stream: 'access.streamHint',
  none: 'access.noneHint',
};

export interface AccessModeSelectorProps {
  value: AccessMode;
  onChange: (mode: AccessMode) => void;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  fullWidth?: boolean;
  /** Explains what the selected mode allows. Off inside the matrix, where 30 cells share one. */
  showHint?: boolean;
  /** Accessible name for the group. Defaults to «حالت دسترسی». */
  'aria-label'?: string;
  /** Use when the name lives elsewhere, e.g. the matrix's row and column headers. */
  'aria-labelledby'?: string;
  className?: string;
}

/**
 * The کامل / فقط پخش / بسته segmented control from screen 02.
 *
 * ARIA radiogroup semantics, not three toggle buttons: exactly one value is always selected,
 * and a screen reader should say "2 of 3". Keyboard follows the radiogroup pattern — arrows
 * move *and* select, Home/End jump to the ends, and only the selected segment is in the tab
 * order, so tabbing through a 5×6 permission matrix takes 30 stops rather than 90.
 *
 * The arrow mapping goes through the document direction: in Persian the next segment is
 * physically to the left.
 */
export function AccessModeSelector({
  value,
  onChange,
  size = 'md',
  disabled = false,
  fullWidth = false,
  showHint = false,
  className,
  ...aria
}: AccessModeSelectorProps) {
  const t = useT();
  const { dir } = useLocale();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, delta: number) => {
    const count = ACCESS_MODES.length;
    const index = (((from + delta) % count) + count) % count;
    const mode = ACCESS_MODES[index];
    if (!mode) return;
    onChange(mode);
    refs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';

    switch (event.key) {
      case forward:
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case backward:
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        move(-1, 1);
        break;
      case 'End':
        event.preventDefault();
        move(0, -1);
        break;
      case ' ':
      case 'Enter': {
        event.preventDefault();
        const mode = ACCESS_MODES[index];
        if (mode) onChange(mode);
        break;
      }
      default:
        break;
    }
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label={aria['aria-labelledby'] ? undefined : (aria['aria-label'] ?? t('access.label'))}
        aria-labelledby={aria['aria-labelledby']}
        className={cx(
          styles.group,
          styles[size],
          fullWidth ? styles.fullWidth : undefined,
          className,
        )}
      >
        {ACCESS_MODES.map((mode, index) => {
          const selected = mode === value;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              ref={(node) => {
                refs.current[index] = node;
              }}
              className={cx(
                styles.segment,
                selected ? styles.selected : undefined,
                mode === 'none' ? styles.none : undefined,
              )}
              onClick={() => onChange(mode)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {t(MODE_LABEL[mode])}
            </button>
          );
        })}
      </div>
      {showHint ? <p className={styles.hint}>{t(MODE_HINT[value])}</p> : null}
    </div>
  );
}
