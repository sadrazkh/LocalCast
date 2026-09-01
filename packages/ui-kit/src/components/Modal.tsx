import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent, ReactNode } from 'react';
import { useLocale, useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import { CloseIcon } from '../icons/index.js';
import styles from './Modal.module.css';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Trailing action group. */
  footer?: ReactNode;
  /** Leading footer content — a hint, a job count, a warning. */
  footerStart?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Off for a dialogue that must be answered, e.g. a destructive confirmation. */
  dismissible?: boolean;
  className?: string;
}

/**
 * A modal dialogue rendered into `document.body`.
 *
 * Deliberately not `<dialog showModal()>`: the Electron tray window renders into a
 * transparent frameless BrowserWindow where the native top layer and the rounded window
 * mask fight each other, and jsdom does not implement `showModal` at all, so every test
 * touching a dialogue would have to stub it. The focus trap, the Escape handler and the
 * focus restore are therefore explicit below.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  footerStart,
  size = 'md',
  dismissible = true,
  className,
}: ModalProps) {
  const t = useT();
  const { dir } = useLocale();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useDomId('lc-modal-title');
  const descriptionId = useDomId('lc-modal-desc');

  // Remember where focus was, move it into the dialogue, and put it back on close.
  // Without the restore, closing a dialogue drops focus onto <body> and the keyboard user
  // has to Tab from the top of the panel again.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    return () => {
      restoreFocusTo.current?.focus?.();
    };
  }, [open]);

  // The page behind a modal must not scroll; on iOS a scrolling background under a sheet
  // is the difference between a dialogue and a mess.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [dismissible, onClose],
  );

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={styles.scrim}
      // The portal escapes `.lc-root`, so the tokens and the direction have to be
      // re-established here or the dialogue renders unstyled and LTR.
      dir={dir}
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(styles.dialog, styles[size], className)}
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
            {description ? (
              <span className={styles.description} id={descriptionId}>
                {description}
              </span>
            ) : null}
          </div>
          {dismissible ? (
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              aria-label={t('a11y.closeDialog')}
            >
              <CloseIcon size={16} />
            </button>
          ) : null}
        </header>

        <div className={styles.body}>{children}</div>

        {footer || footerStart ? (
          <footer className={styles.footer}>
            {footerStart}
            {footer ? <div className={styles.footerActions}>{footer}</div> : null}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
