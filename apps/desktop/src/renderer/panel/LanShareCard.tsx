import { useState } from 'react';
import { Button, RefreshIcon, Switch } from '@localcast/ui-kit';
import { AddressField } from '../components/AddressField.js';
import { getApi } from '../lib/api.js';
import { useCopy } from '../lib/copy.js';
import { messageOf } from '../lib/useAsync.js';
import { useShell } from '../state/shell.js';
import styles from './LanShareCard.module.css';

/**
 * The address a phone on this Wi-Fi uses, and the truth about it.
 *
 * This replaces a single field that showed `lanUrl` and nothing else. A null address there meant
 * three different things — sharing is switched off, this machine has no address yet, a port could
 * not be bound — and the screen could only render the least useful of the three interpretations.
 * Two of those are things the user can act on, and one of them names another copy of the app still
 * sitting in the system tray, which nobody would ever guess from a blank field.
 *
 * The encryption switch is here rather than buried in settings because this is the screen somebody
 * is looking at when their phone refuses to connect, and it is the one control that helps.
 */
export function LanShareCard() {
  const c = useCopy();
  const { info, refreshInfo } = useShell();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lan = info?.lan ?? null;
  if (lan === null || lan.state === 'off') return null;

  async function setEncrypted(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await getApi().lan.setEncrypted(next);
      // The address changes with the scheme and the port, so the whole card has to re-read rather
      // than patch its own copy of the status.
      refreshInfo();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function refresh(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await getApi().lan.refresh();
      refreshInfo();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.card}>
      {lan.state === 'listening' && lan.url !== null ? (
        <>
          <AddressField host={lan.url} label={c('pairing.lanAddress')} />
          {/*
            Said before it happens, in one sentence, with no jargon. The connection is protected by
            this computer rather than by an outside company, so the phone asks once whether to
            trust it — and somebody who meets that screen unprepared reads it as "something is
            wrong" and stops. Only shown while the connection actually is encrypted; when it is
            not, there is no warning to prepare for and a different thing to say.
          */}
          <p className={styles.note}>
            {lan.encrypted ? c('pairing.trustOnce') : c('lan.unencryptedWarning')}
          </p>
        </>
      ) : lan.state === 'no-address' ? (
        <p className={styles.problem} role="status">
          {c('lan.noAddress')}
        </p>
      ) : (
        <p className={styles.problem} role="alert">
          {c('lan.failed')}
          {lan.error === null ? null : <span className={styles.detail}>{lan.error}</span>}
        </p>
      )}

      <Switch
        checked={lan.encrypted}
        disabled={busy}
        label={c('lan.encryptedLabel')}
        description={c('lan.encryptedHint')}
        onChange={(next) => void setEncrypted(next)}
      />

      <div className={styles.actions}>
        <Button
          variant="ghost"
          size="sm"
          loading={busy}
          startIcon={<RefreshIcon size={14} />}
          onClick={() => void refresh()}
        >
          {c('lan.recheck')}
        </Button>
      </div>

      {error === null ? null : (
        <p className={styles.problem} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
