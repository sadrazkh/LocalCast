import type { ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { AlertIcon, QrIcon } from '../icons/index.js';
import styles from './QrFrame.module.css';

export interface QrFrameProps {
  /** The `<video>`, `<canvas>` or rendered QR image. Omit to show the placeholder. */
  children?: ReactNode;
  /** Frame edge length in px. 260 on the phone, 200 in the panel. */
  size?: number;
  /** Instruction under the frame. Defaults to «کد را با دوربین گوشی اسکن کنید». */
  prompt?: ReactNode;
  /** Camera refused, no camera, insecure context — shown instead of the prompt. */
  error?: ReactNode;
  /** Wires the «کد ۴ رقمی» affordance. Omit only where typing a code is impossible. */
  onUseCode?: () => void;
  useCodeLabel?: ReactNode;
  className?: string;
}

/**
 * The camera viewfinder frame with its four corner marks, and the «کد ۴ رقمی» fallback.
 *
 * The fallback button is not conditional on an error. iOS Safari will not re-prompt for a
 * camera permission the user has refused once, and there is no API to detect that reliably,
 * so a manual-code route that only appears "when something goes wrong" is a route that some
 * users can never reach.
 */
export function QrFrame({
  children,
  size = 260,
  prompt,
  error,
  onUseCode,
  useCodeLabel,
  className,
}: QrFrameProps) {
  const t = useT();

  return (
    <div className={cx(styles.wrapper, className)}>
      <div
        className={styles.frame}
        style={{ inlineSize: size }}
        role="img"
        aria-label={t('pairing.viewfinderLabel')}
      >
        {children ? (
          <div className={styles.media}>{children}</div>
        ) : (
          <div className={styles.placeholder}>
            <QrIcon size={28} />
            <span>{t('pairing.scanPrompt')}</span>
          </div>
        )}
        <span className={cx(styles.corner, styles.topStart)} />
        <span className={cx(styles.corner, styles.topEnd)} />
        <span className={cx(styles.corner, styles.bottomStart)} />
        <span className={cx(styles.corner, styles.bottomEnd)} />
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          <AlertIcon size={14} />
          <span>{error}</span>
        </p>
      ) : (
        <p className={styles.prompt}>{prompt ?? t('pairing.scanPrompt')}</p>
      )}

      {onUseCode ? (
        <button type="button" className={styles.fallback} onClick={onUseCode}>
          {useCodeLabel ?? t('pairing.codeFallbackAction')}
        </button>
      ) : null}
    </div>
  );
}
