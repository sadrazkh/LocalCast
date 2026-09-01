import type { ReactNode } from 'react';
import { useFormat, useT, useTNode } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { ClockIcon } from '../icons/index.js';
import { ProgressBar } from './ProgressBar.js';
import styles from './PairingCode.module.css';

export interface PairingCodeProps {
  /** The raw code; normalised to ASCII upper case before it is shown. */
  code: string;
  /** Seconds left before it expires. Omit or pass null to hide the countdown. */
  secondsRemaining?: number | null;
  /** Total TTL, so the countdown can also be a meter. The API mints 300s. */
  ttlSeconds?: number;
  size?: 'sm' | 'lg';
  /** Replaces the countdown with «کد منقضی شد» and greys the characters. */
  expired?: boolean;
  label?: ReactNode;
  /** Rendered under the countdown — usually a «کد تازه» button. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The large four-character pairing code with its countdown.
 *
 * Characters are laid out in individual boxes because the code is read aloud and typed by
 * hand: separating them stops `II` being read as `H` and makes the fourth character
 * unambiguous. Monospace, ASCII digits, LTR-isolated — see `formatCode`.
 */
export function PairingCode({
  code,
  secondsRemaining = null,
  ttlSeconds,
  size = 'lg',
  expired = false,
  label,
  actions,
  className,
}: PairingCodeProps) {
  const t = useT();
  const tn = useTNode();
  const format = useFormat();
  const normalised = format.code(code);
  const characters = [...normalised];

  const showCountdown = !expired && secondsRemaining !== null && secondsRemaining >= 0;
  const fraction =
    showCountdown && ttlSeconds && ttlSeconds > 0
      ? Math.min(1, Math.max(0, (secondsRemaining ?? 0) / ttlSeconds))
      : null;

  return (
    <div
      className={cx(
        styles.wrapper,
        size === 'sm' ? styles.sm : undefined,
        expired ? styles.expired : undefined,
        className,
      )}
    >
      <span className={styles.label}>{label ?? t('pairing.codeLabel')}</span>

      {/* One accessible name for the whole code; a screen reader reading four separate
          boxes would spell it as four unrelated letters. */}
      <div className={styles.code} role="group" aria-label={`${t('pairing.codeLabel')}: ${normalised}`}>
        {characters.map((character, index) => (
          // Positional key. The list is a fixed-length code whose characters repeat and are
          // never reordered, so the index is the only stable identity available.
          <span key={index} className={styles.char} aria-hidden="true">
            {character}
          </span>
        ))}
      </div>

      {expired ? (
        <span className={cx(styles.countdown, styles.expiredText)}>{t('pairing.expired')}</span>
      ) : showCountdown ? (
        <span className={styles.countdown}>
          <ClockIcon size={14} />
          {tn('pairing.expiresIn', {
            time: <span className={styles.time}>{format.duration(secondsRemaining ?? 0)}</span>,
          })}
        </span>
      ) : null}

      {fraction !== null ? (
        <ProgressBar
          value={fraction}
          size="sm"
          tone={fraction < 0.25 ? 'warning' : 'accent'}
          className={styles.meter}
        />
      ) : null}

      {actions}
    </div>
  );
}
