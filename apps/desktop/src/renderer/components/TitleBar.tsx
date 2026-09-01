import type { ReactNode } from 'react';
import { LogoIcon, cx, useLocale } from '@localcast/ui-kit';
import type { Locale } from '@localcast/ui-kit';
import { useCopy } from '../lib/copy.js';
import styles from './TitleBar.module.css';

/**
 * The 38px strip at the top of the frameless windows.
 *
 * `windows.ts` creates the panel and the wizard with `titleBarStyle: 'hidden'` and a
 * `titleBarOverlay` 38px high, so this bar has to be exactly that tall and has to be
 * draggable — otherwise the window cannot be moved at all. Every interactive thing inside it
 * is marked `no-drag`, because a button inside a drag region swallows its own clicks.
 */

export interface TitleBarProps {
  /** Status, address, whatever the surface wants in the middle. */
  children?: ReactNode;
  /** The tray popover is frameless with no overlay, so it reserves no caption space. */
  reserveCaption?: boolean;
  className?: string;
}

export function TitleBar({ children, reserveCaption = true, className }: TitleBarProps) {
  // The whole strip drags (see the module's `-webkit-app-region: drag`); every control
  // inside it re-declares `no-drag`, or it would swallow its own clicks.
  return (
    <header className={cx(styles.bar, reserveCaption ? styles.reserved : undefined, className)}>
      <span className={styles.brand}>
        <LogoIcon size={16} />
        <span className={styles.brandText}>LocalCast</span>
      </span>
      <div className={styles.slot}>{children}</div>
      <LanguageSwitch />
    </header>
  );
}

/**
 * The language switch from the canvas. Two segments rather than a dropdown: there are
 * exactly two languages and the choice is worth one click, not two.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const c = useCopy();

  const option = (value: Locale, label: string) => (
    <button
      key={value}
      type="button"
      className={cx(styles.lang, locale === value ? styles.langActive : undefined)}
      aria-pressed={locale === value}
      onClick={() => setLocale(value)}
    >
      {label}
    </button>
  );

  return (
    <div className={cx(styles.langGroup, className)} role="group" aria-label={c('shell.language')}>
      {option('fa', c('shell.languageFa'))}
      {option('en', c('shell.languageEn'))}
    </div>
  );
}
