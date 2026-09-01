import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  CheckIcon,
  FolderIcon,
  LockIcon,
  PairingCode,
  QrFrame,
  Spinner,
  cx,
  useT,
} from '@localcast/ui-kit';
import { TitleBar } from '../components/TitleBar.js';
import { getApi, qrPayloadOf } from '../lib/api.js';
import { useCopy } from '../lib/copy.js';
import { messageOf } from '../lib/useAsync.js';
import { isServing, useShell } from '../state/shell.js';
import styles from './Wizard.module.css';

/**
 * First run, in three steps: pick a folder, sign in once, add the first device.
 *
 * The rule that shapes every string on this screen: **the person doing this has not
 * configured a network and never should have to.** There is no mode, no control server, no
 * address, no certificate and no port anywhere in the copy, and a test scans the rendered
 * text to keep it that way — the promise is the product, not a nicety.
 *
 * Step two has no "next" button on purpose. The wizard moves on when the edge status
 * actually reports `connected`, so it can never march ahead of a sign-in that silently
 * failed in the browser and leave the user staring at a QR code for a server nothing can
 * reach.
 */

const TOTAL_STEPS = 3;

export function Wizard() {
  const [step, setStep] = useState(0);
  const [folderId, setFolderId] = useState<string | null>(null);

  return (
    <div className={styles.window}>
      <TitleBar />
      <main className={styles.body}>
        <StepDots current={step} />
        {step === 0 ? (
          <FolderStep
            onDone={(id) => {
              setFolderId(id);
              setStep(1);
            }}
          />
        ) : null}
        {step === 1 ? <SignInStep onConnected={() => setStep(2)} /> : null}
        {step === 2 ? <PairingStep folderId={folderId} /> : null}
      </main>
    </div>
  );
}

function StepDots({ current }: { current: number }) {
  const c = useCopy();
  return (
    <div className={styles.progress}>
      <span className={styles.stepLabel}>
        {c('wizard.step', { current: current + 1, total: TOTAL_STEPS })}
      </span>
      <span className={styles.dots} aria-hidden="true">
        {Array.from({ length: TOTAL_STEPS }, (_, index) => (
          <span
            key={index}
            className={cx(
              styles.dot,
              index === current ? styles.dotActive : undefined,
              index < current ? styles.dotDone : undefined,
            )}
          />
        ))}
      </span>
    </div>
  );
}

// ─── step 1: choose a folder ──────────────────────────────────────────────────

/** `path.basename` for a Windows or POSIX path, without pulling Node into the renderer. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function FolderStep({ onDone }: { onDone: (folderId: string | null) => void }) {
  const t = useT();
  const c = useCopy();
  const [chosen, setChosen] = useState<{ id: string; path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await getApi().folders.pick();
      // A cancelled dialogue is not a failure and must not leave an error on screen.
      if (!path) return;
      const folder = await getApi().folders.add({
        path,
        label: baseName(path),
        kind: 'mixed',
        writable: false,
      });
      setChosen({ id: folder.id, path });
    } catch (err) {
      setError(`${c('wizard.folderFailed')} — ${messageOf(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.step}>
      <span className={styles.stepIcon}>
        <FolderIcon size={26} />
      </span>
      <h1 className={styles.title}>{c('wizard.folderTitle')}</h1>
      <p className={styles.lede}>{c('wizard.folderBody')}</p>

      {chosen ? (
        <div className={styles.chosen}>
          <span className={styles.chosenLabel}>{c('wizard.folderChosen')}</span>
          <span className={styles.chosenPath} title={chosen.path}>
            {chosen.path}
          </span>
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.actions}>
        <Button variant={chosen ? 'secondary' : 'primary'} loading={busy} onClick={() => void pick()}>
          {chosen ? t('common.edit') : c('wizard.folderChoose')}
        </Button>
        {chosen ? (
          <Button variant="primary" onClick={() => onDone(chosen.id)}>
            {t('common.next')}
          </Button>
        ) : (
          // Always offered, never hidden behind an error: someone who wants to look around
          // before handing over a folder should not have to invent one to get past step one.
          <Button variant="ghost" onClick={() => onDone(null)}>
            {c('wizard.folderLater')}
          </Button>
        )}
      </div>
    </section>
  );
}

// ─── step 2: one sign-in button ───────────────────────────────────────────────

function SignInStep({ onConnected }: { onConnected: () => void }) {
  const c = useCopy();
  const { status } = useShell();
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = isServing(status);

  const signIn = async () => {
    setError(null);
    try {
      // Opens the user's real browser. Nothing is typed into this window, and nothing here
      // needs to know what the sign-in page is.
      await getApi().edge.login();
      setOpened(true);
    } catch (err) {
      setError(`${c('wizard.signInFailed')} — ${messageOf(err)}`);
    }
  };

  // The only way forward. The button opens a browser; the status stream is what says the
  // sign-in actually took.
  useEffect(() => {
    if (connected) onConnected();
  }, [connected, onConnected]);

  return (
    <section className={styles.step}>
      <span className={styles.stepIcon}>
        {connected ? <CheckIcon size={26} /> : <LockIcon size={26} />}
      </span>
      <h1 className={styles.title}>{c('wizard.signInTitle')}</h1>
      <p className={styles.lede}>{c('wizard.signInBody')}</p>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {opened && !connected ? (
        <p className={styles.waiting} role="status">
          <Spinner size="sm" />
          <span>{c('wizard.signInWaiting')}</span>
        </p>
      ) : null}

      <div className={styles.actions}>
        <Button variant="primary" size="lg" onClick={() => void signIn()}>
          {opened ? c('wizard.signInAgain') : c('wizard.signInAction')}
        </Button>
      </div>
    </section>
  );
}

// ─── step 3: the first device ─────────────────────────────────────────────────

interface Minted {
  code: string;
  expiresAt: number;
  dataUrl: string;
}

function PairingStep({ folderId }: { folderId: string | null }) {
  const t = useT();
  const c = useCopy();
  const [minted, setMinted] = useState<Minted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requested = useRef(false);

  const mint = useCallback(async () => {
    setError(null);
    try {
      const api = getApi();
      // The folder chosen in step one is what the first device gets, at full access. A
      // pairing code that grants nothing produces a device that can see an empty library.
      const defaults = folderId ? [{ folderId, mode: 'full' }] : [];
      const result = await api.pairing.mint(defaults);
      const dataUrl = await api.pairing.qrDataUrl(qrPayloadOf(result));
      setMinted({ code: result.code, expiresAt: result.expiresAt, dataUrl });
    } catch (err) {
      setError(`${c('wizard.qrFailed')} — ${messageOf(err)}`);
    }
  }, [folderId, c]);

  useEffect(() => {
    // Strict mode mounts effects twice in development; minting twice would burn a code and
    // show the user the one that is already dead.
    if (requested.current) return;
    requested.current = true;
    void mint();
  }, [mint]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const finish = async () => {
    await getApi().app.completeWizard();
    // main watches for this window closing and opens the panel behind it.
    window.close();
  };

  const remaining = minted ? Math.max(0, Math.round((minted.expiresAt - now) / 1000)) : null;

  return (
    <section className={styles.step}>
      <h1 className={styles.title}>{c('wizard.qrTitle')}</h1>
      <p className={styles.lede}>{c('wizard.qrBody')}</p>

      <div className={styles.pairing}>
        <QrFrame size={196} prompt={c('wizard.qrBody')} error={error ?? undefined}>
          {minted ? <img className={styles.qr} src={minted.dataUrl} alt="" /> : null}
        </QrFrame>

        {minted ? (
          <PairingCode
            code={minted.code}
            secondsRemaining={remaining}
            ttlSeconds={300}
            expired={remaining === 0}
            label={c('wizard.qrFallback')}
            actions={
              remaining === 0 ? (
                <Button variant="secondary" size="sm" onClick={() => void mint()}>
                  {t('pairing.regenerate')}
                </Button>
              ) : null
            }
          />
        ) : error ? null : (
          <p className={styles.waiting} role="status">
            <Spinner size="sm" />
            <span>{c('pairing.minting')}</span>
          </p>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="primary" onClick={() => void finish()}>
          {c('wizard.finish')}
        </Button>
      </div>
    </section>
  );
}
