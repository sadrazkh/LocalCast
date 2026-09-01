import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessModeSelector,
  Button,
  EmptyState,
  FolderIcon,
  PairingCode,
  Panel,
  QrFrame,
  RefreshIcon,
  Spinner,
  useT,
} from '@localcast/ui-kit';
import type { AccessMode } from '@localcast/contract';
import { AddressField } from '../components/AddressField.js';
import { getApi, qrPayloadOf } from '../lib/api.js';
import { useCopy } from '../lib/copy.js';
import { messageOf } from '../lib/useAsync.js';
import { REMOTE_ACCESS_ENABLED } from '../../shared/features.js';
import { useLibrary } from '../state/library.js';
import { useShell } from '../state/shell.js';
import styles from './PairingScreen.module.css';

/** The operator API mints with a five-minute TTL; the meter needs the same number. */
const TTL_SECONDS = 300;

interface Minted {
  code: string;
  expiresAt: number;
  dataUrl: string;
}

/**
 * Screen 03 — «پیرینگ QR».
 *
 * The default permissions are chosen *before* the code is minted, and the code carries them:
 * the operator API applies them the moment the device is approved. That ordering is why
 * changing a folder's default here does not silently change an already-minted code — a new
 * code has to be asked for, and the screen says so.
 */
export function PairingScreen() {
  const t = useT();
  const c = useCopy();
  const { status, info } = useShell();
  const { folders, loading } = useLibrary();

  const [defaults, setDefaults] = useState<Record<string, AccessMode>>({});
  const [minted, setMinted] = useState<Minted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const seeded = useRef(false);

  // A first device that can see nothing is a support call. Every shared folder starts at
  // «کامل»; the operator narrows it here or in the matrix afterwards.
  useEffect(() => {
    if (seeded.current || loading) return;
    seeded.current = true;
    setDefaults(Object.fromEntries(folders.map((folder) => [folder.id, 'full' as AccessMode])));
  }, [folders, loading]);

  const mint = useCallback(
    async (permissions: Record<string, AccessMode>) => {
      setBusy(true);
      setError(null);
      try {
        const api = getApi();
        const result = await api.pairing.mint(
          Object.entries(permissions).map(([folderId, mode]) => ({ folderId, mode })),
        );
        const dataUrl = await api.pairing.qrDataUrl(qrPayloadOf(result));
        setMinted({ code: result.code, expiresAt: result.expiresAt, dataUrl });
      } catch (err) {
        setError(`${c('pairing.failed')} — ${messageOf(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [c],
  );

  const requested = useRef(false);
  useEffect(() => {
    if (requested.current || !seeded.current) return;
    requested.current = true;
    void mint(defaults);
  }, [defaults, mint]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = minted ? Math.max(0, Math.round((minted.expiresAt - now) / 1000)) : null;
  const expired = remaining === 0;

  return (
    <div className={styles.screen}>
      <Panel
        title={t('pairing.title')}
        description={t('pairing.scanPrompt')}
        actions={
          <Button
            variant="secondary"
            loading={busy}
            startIcon={<RefreshIcon size={14} />}
            onClick={() => void mint(defaults)}
          >
            {t('pairing.regenerate')}
          </Button>
        }
      >
        <div className={styles.split}>
          <div className={styles.qrColumn}>
            <QrFrame size={260} error={error ?? undefined}>
              {minted && !expired ? <img className={styles.qr} src={minted.dataUrl} alt="" /> : null}
            </QrFrame>

            {minted ? (
              <PairingCode
                code={minted.code}
                secondsRemaining={remaining}
                ttlSeconds={TTL_SECONDS}
                expired={expired}
                label={t('pairing.codeFallback')}
              />
            ) : error ? null : (
              <p className={styles.waiting} role="status">
                <Spinner size="sm" />
                <span>{c('pairing.minting')}</span>
              </p>
            )}
          </div>

          <div className={styles.sideColumn}>
            <div className={styles.addresses}>
              {/*
                Both of these are addresses the coordination server hands out, so while remote
                access is switched off they are permanently «هنوز آماده نیست» — an empty field
                promising something that is not coming. The Wi-Fi address below is the one a
                phone actually uses in that build, and it is enough on its own.
              */}
              {REMOTE_ACCESS_ENABLED ? <AddressField host={status?.host ?? null} /> : null}
              {REMOTE_ACCESS_ENABLED && status?.funnelUrl ? (
                <AddressField host={status.funnelUrl} label={t('network.publicAddress')} />
              ) : null}
              {info?.lanUrl ? (
                <>
                  <AddressField host={info.lanUrl} label={c('pairing.lanAddress')} />
                  {/*
                    The warning is named before it happens, in one sentence, with no jargon.
                    The connection is protected by this computer rather than by an outside
                    company, so the phone asks once whether to trust it — and a person who
                    meets that screen unprepared reads it as "something is wrong" and stops.
                  */}
                  <p className={styles.trustNote}>{c('pairing.trustOnce')}</p>
                </>
              ) : null}
            </div>

            <section className={styles.defaults}>
              <h3 className={styles.defaultsTitle}>{c('pairing.defaultsTitle')}</h3>
              <p className={styles.defaultsHint}>{c('pairing.defaultsHint')}</p>

              {folders.length === 0 ? (
                <EmptyState
                  icon={<FolderIcon size={20} />}
                  title={c('pairing.noFolders')}
                  compact
                />
              ) : (
                <ul className={styles.folderList}>
                  {folders.map((folder) => (
                    <li key={folder.id} className={styles.folderRow}>
                      <span className={styles.folderLabel} title={folder.label}>
                        {folder.label}
                      </span>
                      <AccessModeSelector
                        size="sm"
                        value={defaults[folder.id] ?? 'none'}
                        aria-label={t('permissions.cellLabel', {
                          device: c('pairing.defaultsTitle'),
                          folder: folder.label,
                        })}
                        onChange={(mode) =>
                          setDefaults((current) => ({ ...current, [folder.id]: mode }))
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </Panel>
    </div>
  );
}
