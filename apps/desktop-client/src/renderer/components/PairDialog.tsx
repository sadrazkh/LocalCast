import { useState } from 'react';
// formatCode lives in ui-kit, not client-core: it is the same helper that enforces the
// ASCII-digit rule for codes and addresses across every surface.
import { Button, Input, Modal, Spinner, formatCode, useT } from '@localcast/ui-kit';
import type { PairResult, ServerSummary } from '../../shared/ipc.js';
import { errorText, fill, S } from '../strings.js';
import styles from './Dialogs.module.css';

/**
 * Pairing by typed code — the desktop's only pairing path.
 *
 * There is no camera here and no QR to scan, which the spec accounts for: the four-character
 * code is the manual fallback and `client-core`'s `runPairing` takes it directly. What the
 * long secret in a QR buys is unguessability; without it the code alone is what guards entry,
 * which is why the server rate-limits it globally, per code, and with exponential backoff.
 *
 * The input is normalised with the shared `formatCode` on every keystroke: an iOS or Windows
 * Persian keyboard produces «۱۲۳۴» and the server only ever minted `1234`. Comparing the two
 * without this step is a pairing failure that looks like a wrong code.
 */

export interface PairDialogProps {
  open: boolean;
  server: ServerSummary | null;
  deviceName: string;
  onClose: () => void;
  /** The server is passed back rather than captured, so this can never fire without one. */
  onSubmit: (code: string, server: ServerSummary) => Promise<PairResult>;
}

export function PairDialog({ open, server, deviceName, onClose, onSubmit }: PairDialogProps) {
  const t = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalised = formatCode(code).slice(0, 4);
  const ready = normalised.length === 4 && server !== null;

  const submit = async () => {
    if (!ready || busy || server === null) return;
    setBusy(true);
    setError(null);
    const result = await onSubmit(normalised, server);
    setBusy(false);
    if (result.ok) {
      setCode('');
      onClose();
      return;
    }
    setError(errorText(result.errorCode));
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={S.pairDialogTitle}
      description={server === null ? undefined : server.label}
      size="sm"
      dismissible={!busy}
      footerStart={
        busy ? (
          <span className={styles.waiting}>
            <Spinner size="sm" />
            {/* The operator has to press «تأیید» on the other machine; saying so is the
                difference between waiting and assuming it has hung. */}
            {S.pairDialogWaiting}
          </span>
        ) : (
          <span className={styles.hint}>{fill(S.pairDialogDeviceName, { name: deviceName })}</span>
        )
      }
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void submit()}>
            {S.pairDialogSubmit}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.body}>{S.pairDialogBody}</p>
        <Input
          label={S.pairDialogCodeLabel}
          latin
          required
          inputSize="lg"
          value={normalised}
          maxLength={4}
          autoFocus
          className={styles.codeInput}
          error={error ?? undefined}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </div>
    </Modal>
  );
}
