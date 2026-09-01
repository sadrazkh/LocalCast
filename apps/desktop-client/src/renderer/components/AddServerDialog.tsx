import { useState } from 'react';
import { Button, Input, Modal, useT } from '@localcast/ui-kit';
import { isPairableHost } from '@localcast/client-core';
import { S } from '../strings.js';
import styles from './Dialogs.module.css';

/**
 * Adding a server by address.
 *
 * The canvas calls this «افزودن با IP», and the honest version of it is not quite that: a
 * bare IP cannot hold a Let's Encrypt certificate, so a client pointed at one fails at TLS
 * with nothing the user can do. The validation therefore uses `client-core`'s own
 * `isPairableHost` — the same predicate that guards a scanned QR — and the hint says why in
 * one sentence, at the point of typing, rather than letting the user discover it as an
 * unexplained connection failure a minute later.
 */

export interface AddServerDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { host: string; label?: string }) => Promise<void>;
}

export function AddServerDialog({ open, onClose, onSubmit }: AddServerDialogProps) {
  const t = useT();
  const [host, setHost] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const valid = isPairableHost(trimmed);
  // Only complain once there is enough typed to be wrong; a red field under a half-typed
  // host name is noise.
  const showError = trimmed.length > 2 && !valid;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ host: trimmed, label: label.trim() || undefined });
      setHost('');
      setLabel('');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={S.addDialogTitle}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void submit()}>
            {S.addDialogSubmit}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <Input
          label={S.addDialogHostLabel}
          hint={S.addDialogHostHint}
          error={showError ? S.addDialogInvalidHost : undefined}
          latin
          required
          value={host}
          placeholder="ali-pc.tail1234.ts.net"
          onChange={(event) => setHost(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
        <Input
          label={S.addDialogLabelLabel}
          optional
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        {error === null ? null : <p className={styles.error}>{error}</p>}
      </div>
    </Modal>
  );
}
