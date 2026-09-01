import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Button,
  ConnectionDot,
  FolderIcon,
  LogoIcon,
  PairingCode,
  PhoneIcon,
  QrFrame,
  QrIcon,
  SettingsIcon,
  Spinner,
  cx,
  formatDuration,
  useFormat,
  useT,
} from '@localcast/ui-kit';
import { AddressField } from '../components/AddressField.js';
import { doingKey } from '../lib/activity.js';
import { getApi, listActivity, listDevices, listFolders, qrPayloadOf } from '../lib/api.js';
import { useCopy } from '../lib/copy.js';
import { messageOf, useAsync } from '../lib/useAsync.js';
import { REMOTE_ACCESS_ENABLED } from '../../shared/features.js';
import { connectionOf, isServerOn, serverAddress, useShell } from '../state/shell.js';
import styles from './TrayApp.module.css';

const TTL_SECONDS = 300;
/** A device seen inside this window is treated as connected right now. */
const RECENT_MS = 5 * 60 * 1000;

type View = 'home' | 'pair' | 'folders' | 'menuOnly';

/**
 * Screen 04 — the 340×460 tray popover, in both of its states.
 *
 * **Server on**: the address, which network it is on, how long it has been up, and who is
 * connected with what each of them is doing.
 *
 * **Server off**: the one thing the user actually needs to know, which is that turning it
 * back on does not cost them their devices — everything already paired reconnects on its
 * own, with nothing to scan again. Without that sentence, "off" reads as "start over", and
 * people leave servers running they would rather not.
 */
export function TrayApp() {
  const t = useT();
  const c = useCopy();
  const format = useFormat();
  const { status, info, connectedSince } = useShell();
  const [view, setView] = useState<View>('home');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The local server, not the sidecar, while remote access is switched off — otherwise this
  // popover reports «سرور خاموش است» over a server that is serving. See `isServerOn`.
  const serving = isServerOn(status, info);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await getApi().edge.start();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.popover}>
      <header className={styles.header}>
        <span className={styles.brand}>
          <LogoIcon size={15} />
          <span className={styles.brandText}>LocalCast</span>
        </span>
        {/* A dot and a word. No address, no relay, no protocol — the address is its own
            labelled field below, where it can be read and copied. */}
        <ConnectionDot state={connectionOf(status, info)} size="sm" />
      </header>

      <div className={styles.body}>
        {view === 'home' ? (
          serving ? (
            <ServerOn now={now} connectedSince={connectedSince} />
          ) : (
            <ServerOff busy={busy} error={error} onStart={() => void start()} />
          )
        ) : null}

        {view === 'pair' ? <TrayPairing /> : null}
        {view === 'folders' ? <TrayFolders /> : null}

        {view === 'menuOnly' ? (
          <p className={styles.menuOnly} role="status">
            {c('tray.menuOnly')}
          </p>
        ) : null}
      </div>

      <footer className={styles.footer}>
        {view === 'home' ? (
          <>
            <TrayAction icon={<QrIcon size={14} />} onClick={() => setView('pair')}>
              {c('tray.addDevice')}
            </TrayAction>
            <TrayAction icon={<FolderIcon size={14} />} onClick={() => setView('folders')}>
              {c('tray.folders')}
            </TrayAction>
            <TrayAction icon={<SettingsIcon size={14} />} onClick={() => setView('menuOnly')}>
              {c('tray.settings')}
            </TrayAction>
            <TrayAction onClick={() => setView('menuOnly')}>{c('tray.quit')}</TrayAction>
          </>
        ) : (
          <TrayAction onClick={() => setView('home')}>{t('common.back')}</TrayAction>
        )}
      </footer>
    </div>
  );
}

function TrayAction({
  icon,
  onClick,
  children,
}: {
  icon?: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={styles.action} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

// ─── server on ────────────────────────────────────────────────────────────────

function ServerOn({ now, connectedSince }: { now: number; connectedSince: number | null }) {
  const c = useCopy();
  const t = useT();
  const format = useFormat();
  const { status, info } = useShell();
  const devices = useAsync(listDevices, []);
  const activity = useAsync(() => listActivity(60), []);
  // Which coordination server is in use is a remote-access fact, and asking for it means an
  // IPC round trip to a sidecar that is not running.
  const config = useAsync(
    async () => (REMOTE_ACCESS_ENABLED ? getApi().edge.getConfig() : null),
    [],
  );

  // The most recent activity entry per device is the only per-device signal the API carries;
  // there is no "currently streaming" endpoint. A device with nothing recent is «بی‌کار»,
  // which is honest — inventing a busy state from a connection count is not.
  const lastKind = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of activity.data ?? []) {
      if (entry.deviceId && !map.has(entry.deviceId)) map.set(entry.deviceId, entry.kind);
    }
    return map;
  }, [activity.data]);

  const connected = (devices.data ?? []).filter(
    (device) =>
      device.status === 'active' &&
      device.lastSeenAt !== null &&
      now - device.lastSeenAt < RECENT_MS,
  );

  return (
    <>
      <p className={styles.state}>{c('tray.on')}</p>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>{c('shell.address')}</dt>
          <dd>
            <AddressField host={serverAddress(status, info)} label="" />
          </dd>
        </div>
        {REMOTE_ACCESS_ENABLED ? (
          <div className={styles.fact}>
            <dt>{c('tray.network')}</dt>
            <dd>
              {config.data?.mode === 'custom' ? c('tray.networkCustom') : c('tray.networkDefault')}
            </dd>
          </div>
        ) : null}
        <div className={styles.fact}>
          <dt>{c('tray.uptime')}</dt>
          <dd className={styles.latin}>
            {connectedSince === null ? '—' : formatDuration((now - connectedSince) / 1000)}
          </dd>
        </div>
      </dl>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          {c('tray.connected')}
          <span className={styles.count}>{format.count(connected.length)}</span>
        </h2>

        {connected.length === 0 ? (
          <p className={styles.nobody}>{c('tray.nobody')}</p>
        ) : (
          <ul className={styles.deviceList}>
            {connected.map((device) => {
              const key = doingKey(lastKind.get(device.id) ?? null);
              return (
                <li key={device.id} className={styles.device}>
                  <PhoneIcon size={14} />
                  <span className={styles.deviceName} title={device.name}>
                    {device.name}
                  </span>
                  <span className={styles.doing}>{key ? c(key) : c('tray.idle')}</span>
                </li>
              );
            })}
          </ul>
        )}
        {devices.error ? <p className={styles.error}>{t('common.retry')}</p> : null}
      </section>
    </>
  );
}

// ─── server off ───────────────────────────────────────────────────────────────

function ServerOff({
  busy,
  error,
  onStart,
}: {
  busy: boolean;
  error: string | null;
  onStart: () => void;
}) {
  const c = useCopy();
  return (
    <div className={styles.off}>
      <p className={styles.state}>{c('tray.off')}</p>
      <p className={styles.offBody}>{c('tray.offBody')}</p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {/*
        The button starts the *sidecar*. With remote access switched off there is nothing for
        it to start — the local server is started by the app itself — so it would be a button
        whose only possible outcome is an error message. The sentence above it still holds:
        paired devices come back on their own.
      */}
      {REMOTE_ACCESS_ENABLED ? (
        <Button variant="primary" fullWidth loading={busy} onClick={onStart}>
          {c('tray.turnOn')}
        </Button>
      ) : null}
    </div>
  );
}

// ─── inline views ─────────────────────────────────────────────────────────────

/**
 * "Add a device" happens inside the popover rather than by opening the panel: the bridge in
 * `preload` has no way to raise another window, and minting a code here is what the user
 * wanted anyway.
 */
function TrayPairing() {
  const t = useT();
  const c = useCopy();
  const [minted, setMinted] = useState<{ code: string; expiresAt: number; dataUrl: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const mint = useCallback(async () => {
    setError(null);
    try {
      const api = getApi();
      const folders = await listFolders();
      const result = await api.pairing.mint(
        folders.map((folder) => ({ folderId: folder.id, mode: 'full' })),
      );
      const dataUrl = await api.pairing.qrDataUrl(qrPayloadOf(result));
      setMinted({ code: result.code, expiresAt: result.expiresAt, dataUrl });
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void mint();
  }, [mint]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = minted ? Math.max(0, Math.round((minted.expiresAt - now) / 1000)) : null;

  return (
    <div className={styles.pair}>
      <QrFrame size={168} error={error ?? undefined}>
        {minted ? <img className={styles.qr} src={minted.dataUrl} alt="" /> : null}
      </QrFrame>
      {minted ? (
        <PairingCode
          code={minted.code}
          size="sm"
          secondsRemaining={remaining}
          ttlSeconds={TTL_SECONDS}
          expired={remaining === 0}
          label={t('pairing.codeFallback')}
        />
      ) : error ? null : (
        <Spinner labelled />
      )}
    </div>
  );
}

function TrayFolders() {
  const t = useT();
  const format = useFormat();
  const folders = useAsync(listFolders, []);

  if (folders.loading) return <Spinner labelled />;

  const rows = folders.data ?? [];
  if (rows.length === 0) return <p className={styles.nobody}>{t('folders.empty')}</p>;

  return (
    <ul className={styles.folderList}>
      {rows.map((folder) => (
        <li
          key={folder.id}
          className={cx(styles.folder, folder.enabled ? undefined : styles.notShared)}
        >
          <FolderIcon size={14} />
          <span className={styles.deviceName} title={folder.path}>
            {folder.label}
          </span>
          <span className={styles.latin}>
            {folder.totalBytes === null ? '—' : format.bytes(folder.totalBytes)}
          </span>
        </li>
      ))}
    </ul>
  );
}
