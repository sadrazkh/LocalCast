import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import { Field } from './Field.js';
import styles from './Input.module.css';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'children'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** `size` on `<input>` means "visible character count"; this is the visual scale. */
  inputSize?: InputSize;
  startAdornment?: ReactNode;
  endAdornment?: ReactNode;
  fullWidth?: boolean;
  /**
   * The value is a machine string — a URL, a key, a domain, a page range. Forces LTR,
   * monospace, no autocorrect and no autocapitalisation, so a Persian keyboard cannot
   * quietly mangle it.
   */
  latin?: boolean;
  optional?: boolean;
  className?: string;
  /** Class for the outer field, when the caller needs to place it in a grid. */
  fieldClassName?: string;
}

export function Input({
  label,
  hint,
  error,
  inputSize = 'md',
  startAdornment,
  endAdornment,
  fullWidth = true,
  latin = false,
  optional = false,
  required,
  disabled,
  className,
  fieldClassName,
  id,
  ...rest
}: InputProps) {
  const generatedId = useDomId('lc-input');
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <Field
      label={label}
      htmlFor={inputId}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      hintId={hintId}
      errorId={errorId}
      className={fieldClassName}
    >
      <div
        className={cx(
          styles.control,
          styles[inputSize],
          fullWidth ? styles.fullWidth : undefined,
          error ? styles.invalid : undefined,
          disabled ? styles.disabled : undefined,
          className,
        )}
      >
        {startAdornment ? <span className={styles.affix}>{startAdornment}</span> : null}
        <input
          id={inputId}
          className={cx(styles.input, latin ? styles.latin : undefined)}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          dir={latin ? 'ltr' : undefined}
          spellCheck={latin ? false : undefined}
          autoCapitalize={latin ? 'none' : undefined}
          autoCorrect={latin ? 'off' : undefined}
          {...rest}
        />
        {endAdornment ? <span className={styles.affix}>{endAdornment}</span> : null}
      </div>
    </Field>
  );
}
