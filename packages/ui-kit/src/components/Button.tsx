import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import { Spinner } from './Spinner.js';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Shows a spinner in place of the leading icon and blocks the click. The label stays
   * visible: a button that empties itself mid-action makes the operator wonder what they
   * pressed.
   */
  loading?: boolean;
  /** Square button with no label. `aria-label` is then required — enforced by the types. */
  iconOnly?: boolean;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
  fullWidth?: boolean;
  /** Defaults to `button`; forms that submit must opt in explicitly. */
  type?: 'button' | 'submit' | 'reset';
}

type IconOnlyProps = ButtonProps & {
  iconOnly: true;
  /** An icon-only button carries no text, so it must carry a name for assistive tech. */
  'aria-label': string;
  children?: never;
};

export function Button(props: ButtonProps | IconOnlyProps) {
  const {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconOnly = false,
    startIcon,
    endIcon,
    fullWidth = false,
    type = 'button',
    className,
    disabled,
    children,
    ...rest
  } = props;

  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        iconOnly ? styles.iconOnly : undefined,
        fullWidth ? styles.fullWidth : undefined,
        className,
      )}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'lg' ? 'md' : 'sm'} onAccent={variant === 'primary'} />
      ) : (
        startIcon
      )}
      {iconOnly ? null : <span className={styles.label}>{children}</span>}
      {loading ? null : endIcon}
    </button>
  );
}
