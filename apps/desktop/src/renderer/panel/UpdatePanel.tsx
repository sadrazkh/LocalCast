import { useCallback, useEffect, useState } from 'react';
import { Button, Panel, ProgressBar, Spinner } from '@localcast/ui-kit';
import styles from './UpdatePanel.module.css';

/**
 * The update section: what version is running, whether a newer one exists, and — where it is
 * possible — a button that installs it.
 *
 * Copy is Persian-first and stays out of release-engineering vocabulary. The one place it
 * gets specific is the refusals, because "could not verify the download" has to be
 * distinguishable from "no network": the first means something is wrong with the file and the
 * user should not go and install it by hand.
 */

type State =
  | { status: 'current'; version: string }
  | { status: 'available'; version: string; latest: string; notes: string; canInstall: boolean; url: string }
  | { status: 'error'; message: string };

const TEXT = {
  title: 'به‌روزرسانی',
  checking: 'در حال بررسی…',
  current: 'آخرین نسخه را دارید',
  available: 'نسخه‌ی تازه‌ای هست',
  installed: 'نسخه‌ی فعلی',
  latest: 'نسخه‌ی تازه',
  check: 'بررسی دوباره',
  install: 'دانلود و نصب',
  open: 'باز کردن صفحه‌ی دانلود',
  downloading: 'در حال دانلود…',
  portable: 'نسخه‌ی پرتابل نمی‌تواند خودش را جایگزین کند؛ فایل تازه را دانلود کنید و به‌جای فایل فعلی بگذارید.',
  failed: 'بررسی به‌روزرسانی ممکن نشد',
} as const;

export function UpdatePanel() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setState(null);
    setError(null);
    setState((await window.localcast.updates.check()) as State);
  }, []);

  useEffect(() => {
    void check();
    return window.localcast.updates.onProgress(({ receivedBytes, totalBytes }) => {
      setProgress(totalBytes > 0 ? receivedBytes / totalBytes : null);
    });
  }, [check]);

  const install = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await window.localcast.updates.install();
    } catch (err) {
      // Surfaced verbatim. A digest mismatch is the one message here the user must actually
      // read, and paraphrasing it into "something went wrong" would bury it.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, []);

  return (
    <Panel title={TEXT.title}>
      {state === null ? (
        <p className={styles.line}>
          <Spinner size="sm" /> {TEXT.checking}
        </p>
      ) : state.status === 'error' ? (
        <p className={styles.muted}>
          {TEXT.failed} — {state.message}
        </p>
      ) : state.status === 'current' ? (
        <p className={styles.line}>
          {TEXT.current} · <span className={styles.version}>{state.version}</span>
        </p>
      ) : (
        <div className={styles.stack}>
          <p className={styles.line}>
            {TEXT.available} · {TEXT.installed}{' '}
            <span className={styles.version}>{state.version}</span> → {TEXT.latest}{' '}
            <span className={styles.version}>{state.latest}</span>
          </p>

          {state.notes ? <pre className={styles.notes}>{state.notes.slice(0, 600)}</pre> : null}

          {!state.canInstall ? <p className={styles.muted}>{TEXT.portable}</p> : null}

          {busy && progress !== null ? (
            <ProgressBar value={progress} label={TEXT.downloading} />
          ) : null}

          <div className={styles.actions}>
            {state.canInstall ? (
              <Button onClick={() => void install()} disabled={busy} loading={busy}>
                {TEXT.install}
              </Button>
            ) : (
              <Button onClick={() => void window.localcast.app.openExternal(state.url)}>
                {TEXT.open}
              </Button>
            )}
          </div>
        </div>
      )}

      {error ? <p className={styles.error}>{error}</p> : null}

      {state !== null && !busy ? (
        <Button variant="ghost" onClick={() => void check()}>
          {TEXT.check}
        </Button>
      ) : null}
    </Panel>
  );
}
