import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { EyeIcon, EyeOffIcon } from '../icons/index.js';
import { Input } from './Input.js';
import type { InputProps } from './Input.js';
import styles from './PasswordInput.module.css';

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'endAdornment'> {
  /** Controlled reveal, for a form that wants to hide everything on blur or on save. */
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
}

/**
 * A masked field with a reveal toggle. Used for the Headscale access key, which the operator
 * pastes once and then must be able to check without retyping.
 *
 * `latin` defaults to true: the value is a machine credential, so it is LTR and monospace
 * even inside the RTL settings panel.
 *
 * The toggle is a real `<button type="button">` with a changing `aria-label`, not an icon
 * with a click handler — it has to be reachable by keyboard, and «نمایش مقدار» has to be
 * announced.
 */
export function PasswordInput({
  revealed: controlledRevealed,
  onRevealedChange,
  latin = true,
  ...rest
}: PasswordInputProps) {
  const t = useT();
  const [uncontrolled, setUncontrolled] = useState(false);
  const revealed = controlledRevealed ?? uncontrolled;

  const toggle = () => {
    if (controlledRevealed === undefined) setUncontrolled(!revealed);
    onRevealedChange?.(!revealed);
  };

  return (
    <Input
      {...rest}
      latin={latin}
      type={revealed ? 'text' : 'password'}
      autoComplete="off"
      endAdornment={
        <button
          type="button"
          className={cx(styles.toggle, revealed ? styles.revealed : undefined)}
          onClick={toggle}
          aria-label={revealed ? t('a11y.hidePassword') : t('a11y.revealPassword')}
          aria-pressed={revealed}
          tabIndex={rest.disabled ? -1 : 0}
        >
          {revealed ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
        </button>
      }
    />
  );
}
