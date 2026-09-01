import type { ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { AlertIcon } from '../icons/index.js';
import styles from './Field.module.css';

export interface FieldProps {
  label?: ReactNode;
  /** Id of the control this label points at. Omit for a group (radios, segmented control). */
  htmlFor?: string;
  hint?: ReactNode;
  /** A string or node; when present the control should also carry `aria-invalid`. */
  error?: ReactNode;
  required?: boolean;
  /** Marks the field «اختیاری». Mutually exclusive with `required` in practice. */
  optional?: boolean;
  hintId?: string;
  errorId?: string;
  labelId?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Label + hint + error scaffolding shared by every form control.
 *
 * It exists so the `aria-describedby` wiring is written once. Every control in this kit
 * points its `aria-describedby` at `hintId` and `errorId`, which is the difference between a
 * screen-reader user hearing why the save button is blocked and hearing nothing at all.
 *
 * When `htmlFor` is omitted the label renders as a plain element with `labelId`, so a
 * grouped control can reference it with `aria-labelledby` — a `<label>` can only point at
 * one input, and a radio group has several.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  optional = false,
  hintId,
  errorId,
  labelId,
  className,
  children,
}: FieldProps) {
  const t = useT();

  const labelNode =
    label === undefined ? null : (
      <div className={styles.labelRow}>
        {htmlFor ? (
          <label className={styles.label} htmlFor={htmlFor} id={labelId}>
            {label}
          </label>
        ) : (
          <span className={styles.label} id={labelId}>
            {label}
          </span>
        )}
        {required ? (
          <span className={cx(styles.marker, styles.required)}>{t('common.required')}</span>
        ) : null}
        {optional ? <span className={styles.marker}>{t('common.optional')}</span> : null}
      </div>
    );

  return (
    <div className={cx(styles.field, className)}>
      {labelNode}
      {children}
      {hint ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} id={errorId} role="alert">
          <AlertIcon size={14} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
