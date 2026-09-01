import { useEffect, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import { CheckIcon, MinusIcon } from '../icons/index.js';
import styles from './Checkbox.module.css';

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'children'> {
  label?: ReactNode;
  description?: ReactNode;
  /** Mixed state, e.g. a folder header whose devices are partly selected. */
  indeterminate?: boolean;
}

export function Checkbox({
  label,
  description,
  indeterminate = false,
  className,
  disabled,
  id,
  ...rest
}: CheckboxProps) {
  const generatedId = useDomId('lc-checkbox');
  const checkboxId = id ?? generatedId;
  const descriptionId = description ? `${checkboxId}-desc` : undefined;
  const ref = useRef<HTMLInputElement>(null);

  // `indeterminate` has no attribute form — it exists only as a DOM property, so it has to
  // be written after every render that could have changed it.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className={cx(styles.checkbox, disabled ? styles.disabled : undefined, className)}
      htmlFor={checkboxId}
    >
      <input
        ref={ref}
        type="checkbox"
        id={checkboxId}
        className={styles.input}
        disabled={disabled}
        aria-describedby={descriptionId}
        {...rest}
      />
      <span className={styles.box} aria-hidden="true">
        <span className={styles.mark}>
          {indeterminate ? <MinusIcon size={12} /> : <CheckIcon size={12} />}
        </span>
      </span>
      {label || description ? (
        <span className={styles.body}>
          {label ? <span className={styles.label}>{label}</span> : null}
          {description ? (
            <span className={styles.description} id={descriptionId}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}
