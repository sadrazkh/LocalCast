import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import { Field } from './Field.js';
import styles from './Radio.module.css';

export interface RadioProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'children'> {
  label: ReactNode;
  /** Second line under the label. Screens 14/15 use it for the mode trade-off sentence. */
  description?: ReactNode;
  /** Card presentation with a border and a tinted selected state. */
  boxed?: boolean;
}

export function Radio({
  label,
  description,
  boxed = false,
  className,
  disabled,
  checked,
  id,
  ...rest
}: RadioProps) {
  const generatedId = useDomId('lc-radio');
  const radioId = id ?? generatedId;
  const descriptionId = description ? `${radioId}-desc` : undefined;

  return (
    <label
      className={cx(
        styles.radio,
        boxed ? styles.boxed : undefined,
        boxed && checked ? styles.boxedChecked : undefined,
        disabled ? styles.disabled : undefined,
        className,
      )}
      htmlFor={radioId}
    >
      <input
        type="radio"
        id={radioId}
        className={styles.input}
        disabled={disabled}
        checked={checked}
        aria-describedby={descriptionId}
        {...rest}
      />
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.body}>
        <span className={styles.label}>{label}</span>
        {description ? (
          <span className={styles.description} id={descriptionId}>
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export interface RadioOption<T extends string = string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string = string> {
  /** Shared `name`; this is what gives the group its native arrow-key behaviour. */
  name: string;
  value: T | null;
  onChange: (value: T) => void;
  options: readonly RadioOption<T>[];
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  boxed?: boolean;
  horizontal?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A radio group built on native inputs sharing a `name`, so Up/Down and Left/Right move
 * between options and wrap, in the correct direction for the document, without a keydown
 * handler here. Hand-rolled `role="radio"` widgets get this wrong in RTL almost every time.
 */
export function RadioGroup<T extends string = string>({
  name,
  value,
  onChange,
  options,
  label,
  hint,
  error,
  boxed = false,
  horizontal = false,
  disabled = false,
  className,
}: RadioGroupProps<T>) {
  const groupId = useDomId('lc-radiogroup');
  const labelId = label ? `${groupId}-label` : undefined;
  const hintId = hint ? `${groupId}-hint` : undefined;
  const errorId = error ? `${groupId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      labelId={labelId}
      hintId={hintId}
      errorId={errorId}
      className={className}
    >
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        className={cx(styles.group, horizontal ? styles.horizontal : undefined)}
      >
        {options.map((option) => (
          <Radio
            key={option.value}
            name={name}
            value={option.value}
            label={option.label}
            description={option.description}
            boxed={boxed}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => onChange(option.value)}
          />
        ))}
      </div>
    </Field>
  );
}
