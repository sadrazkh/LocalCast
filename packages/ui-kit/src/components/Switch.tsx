import type { ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import styles from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Required when there is no visible `label`. */
  'aria-label'?: string;
  className?: string;
  id?: string;
  name?: string;
}

/**
 * `role="switch"` on a real button. Space and Enter toggle it because it is a button;
 * `aria-checked` is what a screen reader reads, and the visible label is wired with
 * `aria-labelledby` rather than wrapping the control in a `<label>` (a `<label>` around a
 * button does not associate anything).
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className,
  id,
  name,
  ...aria
}: SwitchProps) {
  const generatedId = useDomId('lc-switch');
  const switchId = id ?? generatedId;
  const labelId = label ? `${switchId}-label` : undefined;
  const descriptionId = description ? `${switchId}-desc` : undefined;

  return (
    <span className={cx(styles.row, disabled ? styles.disabled : undefined, className)}>
      <button
        type="button"
        role="switch"
        id={switchId}
        name={name}
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        aria-label={aria['aria-label']}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(styles.track, checked ? styles.checked : undefined)}
      >
        <span className={styles.thumb} />
      </button>
      {label || description ? (
        <span className={styles.body}>
          {label ? (
            <span className={styles.label} id={labelId}>
              {label}
            </span>
          ) : null}
          {description ? (
            <span className={styles.description} id={descriptionId}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
