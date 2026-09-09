import { useState } from 'react';
import { CheckIcon, CopyIcon, copyText, cx, formatAddress, useT } from '@localcast/ui-kit';
import { useCopy } from '../lib/copy.js';
import styles from './AddressField.module.css';

/**
 * The server address, as its own labelled field.
 *
 * This is the counterpart of the rule the `ConnectionDot` enforces: the indicator is a dot
 * and a word and carries no transport detail, so the address — which the user genuinely
 * needs, and needs to be able to copy — gets a place of its own with a label on it, instead
 * of being smuggled in next to the dot as decoration.
 *
 * ASCII and LTR-isolated in both locales. An address in Persian digits cannot be typed back
 * into anything.
 */
export interface AddressFieldProps {
  host: string | null;
  /** Overrides «نشانی سرور» — the pairing screen labels the public Funnel URL with it. */
  label?: string;
  className?: string;
}

export function AddressField({ host, label, className }: AddressFieldProps) {
  const t = useT();
  const c = useCopy();
  const [copied, setCopied] = useState(false);

  const value = host ? formatAddress(host) : null;

  const onCopy = () => {
    if (!value) return;
    // «کپی شد» only when something was actually copied. The old handler said it regardless,
    // which on a page without `navigator.clipboard` was a button that lied.
    void copyText(value).then((ok) => {
      setCopied(ok);
      if (ok) window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <div className={cx(styles.field, className)}>
      <span className={styles.label}>{label ?? c('shell.address')}</span>
      {value ? (
        <>
          <span className={styles.value} title={value}>
            {value}
          </span>
          <button
            type="button"
            className={styles.copy}
            onClick={onCopy}
            aria-label={c('shell.copyAddress')}
          >
            {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            <span className={styles.copyText}>{copied ? t('common.copied') : t('common.copy')}</span>
          </button>
        </>
      ) : (
        <span className={styles.pending}>{c('shell.addressUnknown')}</span>
      )}
    </div>
  );
}
