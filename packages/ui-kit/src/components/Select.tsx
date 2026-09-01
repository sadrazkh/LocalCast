import type { ReactNode, SelectHTMLAttributes } from 'react';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import { ChevronDownIcon } from '../icons/index.js';
import { Field } from './Field.js';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Rendered after the label in a muted tone, e.g. «پیش‌فرض» or «خاموش». */
  note?: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'children'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  options: readonly SelectOption[];
  /**
   * Shown as a disabled first entry with an empty value. `PrintDialog` relies on this:
   * until the operator picks a real printer the value is `''` and submit stays disabled.
   */
  placeholder?: string;
  selectSize?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  optional?: boolean;
  fieldClassName?: string;
}

/**
 * A native `<select>`. Not a custom listbox: the native control gets keyboard behaviour,
 * type-ahead and the iOS wheel picker for free, and the PWA runs on iOS where a hand-rolled
 * listbox in a scrolling sheet is a reliable source of misery.
 */
export function Select({
  label,
  hint,
  error,
  options,
  placeholder,
  selectSize = 'md',
  fullWidth = true,
  optional = false,
  required,
  disabled,
  value,
  className,
  fieldClassName,
  id,
  ...rest
}: SelectProps) {
  const generatedId = useDomId('lc-select');
  const selectId = id ?? generatedId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <Field
      label={label}
      htmlFor={selectId}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      hintId={hintId}
      errorId={errorId}
      className={fieldClassName}
    >
      <div className={cx(styles.wrapper, fullWidth ? styles.fullWidth : undefined)}>
        <select
          id={selectId}
          className={cx(
            styles.select,
            styles[selectSize],
            error ? styles.invalid : undefined,
            className,
          )}
          disabled={disabled}
          required={required}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        >
          {placeholder !== undefined ? (
            <option value="" disabled className={styles.placeholder}>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              className={styles.option}
            >
              {option.note ? `${option.label} — ${option.note}` : option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon size={16} className={styles.chevron} />
      </div>
    </Field>
  );
}
