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
  checkNow: 'بررسی به‌روزرسانی',
  idle: 'برای دیدن اینکه نسخه‌ی تازه‌ای هست، یک‌بار بررسی کنید. تا آن لحظه هیچ درخواستی از این دستگاه بیرون نمی‌رود.',
  install: 'دانلود و نصب',
  open: 'باز کردن صفحه‌ی دانلود',
  downloading: 'در حال دانلود…',
  portable: 'نسخه‌ی پرتابل نمی‌تواند خودش را جایگزین کند؛ فایل تازه را دانلود کنید و به‌جای فایل فعلی بگذارید.',
  failed: 'بررسی به‌روزرسانی ممکن نشد',
} as const;

export function UpdatePanel() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setState((await window.localcast.updates.check()) as State);
    } finally {
      setChecking(false);
    }
  }, []);

  /**
   * Subscribe, but do not check.
   *
   * Checking on mount meant that opening Settings — including from the tray, which routes
   * here — contacted GitHub without anyone asking for it. The product's first promise is that
   * nothing leaves the machine unless the user chose it, and an update check is traffic
   * leaving the machine. It is one button press away instead.
   */
  useEffect(
    () =>
      window.localcast.updates.onProgress(({ receivedBytes, totalBytes }) => {
        setProgress(totalBytes > 0 ? receivedBytes / totalBytes : null);
      }),
    [],
  );

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
      {checking ? (
        <p className={styles.line}>
          <Spinner size="sm" /> {TEXT.checking}
        </p>
      ) : state === null ? (
        <p className={styles.muted}>{TEXT.idle}</p>
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

      {!checking && !busy ? (
        <Button variant={state === null ? 'secondary' : 'ghost'} onClick={() => void check()}>
          {state === null ? TEXT.checkNow : TEXT.check}
        </Button>
      ) : null}
    </Panel>
  );
}
