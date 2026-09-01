import { useEffect, useState } from 'react';
import {
  Button,
  ConnectionDot,
  FileIcon,
  FolderIcon,
  Panel,
  PhoneIcon,
  ClockIcon,
  StatCard,
  formatDuration,
  useFormat,
  useT,
} from '@localcast/ui-kit';
import type { MessageKey } from '@localcast/ui-kit';
import type { EdgeState } from '@localcast/contract';
import { AddressField } from '../components/AddressField.js';
import { getApi } from '../lib/api.js';
import { useCopy } from '../lib/copy.js';
import { useConfirm, useToast } from '../lib/feedback.js';
import { messageOf } from '../lib/useAsync.js';
import { REMOTE_ACCESS_ENABLED } from '../../shared/features.js';
import { useLibrary } from '../state/library.js';
import { connectionOf, isServerOn, serverAddress, useShell } from '../state/shell.js';
import styles from './HostingScreen.module.css';

const EDGE_STATE_LABEL: Record<EdgeState, MessageKey> = {
  stopped: 'edge.stopped',
  starting: 'edge.starting',
  'login-required': 'edge.login-required',
  connecting: 'edge.connecting',
  'obtaining-certificate': 'edge.obtaining-certificate',
  connected: 'edge.connected',
  error: 'edge.error',
};

/**
 * «میزبانی» — the overview the panel opens on: is the server serving, at what address, and
 * how much is behind it.
 *
 * Turning the server off is confirmed. It is not destructive in the sense of losing data,
 * but it is destructive in the sense the operator cares about: every device loses access
 * mid-stream, and from the phone's side that is indistinguishable from a fault.
 *
 * Every control on the hero — the state word, the sign-in prompt, on and off — acts on the
 * *sidecar*, not on the local server, and there is no sidecar while remote access is switched
 * off. So they are behind the flag: a stop button that throws and a state word stuck on
 * «قطع» would be worse than no control at all. What stays is the part that is still true of a
 * local-only build: whether this machine is serving, at what address, and how much is behind
 * it.
 */
export function HostingScreen() {
  const t = useT();
  const c = useCopy();
  const format = useFormat();
  const confirm = useConfirm();
  const toast = useToast();
  const { status, info, connectedSince } = useShell();
  const { folders, devices } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (connectedSince === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [connectedSince]);

  const serving = isServerOn(status, info);
  const needsSignIn = REMOTE_ACCESS_ENABLED && status?.state === 'login-required';
  const activeDevices = devices.filter((device) => device.status === 'active').length;
  const indexedFiles = folders.reduce((total, folder) => total + (folder.fileCount ?? 0), 0);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast({ tone: 'danger', title: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    const accepted = await confirm({
      title: c('hosting.turnOff'),
      body: c('hosting.turnOffConfirm'),
      confirmLabel: c('hosting.turnOff'),
      danger: true,
    });
    if (!accepted) return;
    await run(() => getApi().edge.stop());
  };

  return (
    <div className={styles.screen}>
      <Panel title={c('hosting.title')}>
        <div className={styles.hero}>
          <div className={styles.heroText}>
            <span className={styles.heroTitle}>
              {serving ? c('hosting.serverOn') : c('hosting.serverOff')}
            </span>
            <span className={styles.heroState}>
              <ConnectionDot state={connectionOf(status, info)} showLabel={false} />
              {/* The seven-state edge vocabulary («ورود لازم است», «در حال گرفتن گواهی») is
                  the sidecar's, and describes nothing in a local-only build. */}
              {REMOTE_ACCESS_ENABLED ? (
                <span>{t(EDGE_STATE_LABEL[status?.state ?? 'starting'])}</span>
              ) : null}
            </span>
            {REMOTE_ACCESS_ENABLED && status?.errorMessage ? (
              <span className={styles.heroError} role="alert">
                {status.errorMessage}
              </span>
            ) : null}
            {needsSignIn ? (
              <span className={styles.heroHint}>{c('hosting.signInNeeded')}</span>
            ) : null}
          </div>

          <div className={styles.heroActions}>
            <AddressField host={serverAddress(status, info)} />
            {!REMOTE_ACCESS_ENABLED ? null : needsSignIn ? (
              <Button variant="primary" loading={busy} onClick={() => void run(() => getApi().edge.login())}>
                {c('hosting.signIn')}
              </Button>
            ) : serving ? (
              <Button variant="danger" loading={busy} onClick={() => void stop()}>
                {c('hosting.turnOff')}
              </Button>
            ) : (
              <Button variant="primary" loading={busy} onClick={() => void run(() => getApi().edge.start())}>
                {c('hosting.turnOn')}
              </Button>
            )}
          </div>
        </div>
      </Panel>

      <div className={styles.stats}>
        <StatCard
          label={c('hosting.devices')}
          value={format.count(activeDevices)}
          icon={<PhoneIcon size={16} />}
        />
        <StatCard
          label={c('hosting.folders')}
          value={format.count(folders.length)}
          icon={<FolderIcon size={16} />}
        />
        <StatCard
          label={c('hosting.files')}
          value={format.count(indexedFiles)}
          icon={<FileIcon size={16} />}
        />
        <StatCard
          label={c('hosting.uptime')}
          // ASCII on purpose: an uptime is compared against a clock, not read as prose.
          value={connectedSince === null ? '—' : formatDuration((now - connectedSince) / 1000)}
          latin
          icon={<ClockIcon size={16} />}
        />
      </div>
    </div>
  );
}
