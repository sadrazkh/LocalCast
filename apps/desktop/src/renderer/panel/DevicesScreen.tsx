import { useMemo } from 'react';
import {
  ActivityIcon,
  DeviceRow,
  EmptyState,
  Panel,
  PermissionMatrix,
  PhoneIcon,
  PlayIcon,
  SectionHeader,
  StatCard,
  formatBytes,
  useFormat,
  useT,
} from '@localcast/ui-kit';
import type { AccessMode, DeviceSummary } from '@localcast/contract';
import { getApi, withPermission } from '../lib/api.js';
import type { ActivityEntry } from '../lib/api.js';
import { useCopy } from '../lib/copy.js';
import { useConfirm, useToast } from '../lib/feedback.js';
import { messageOf } from '../lib/useAsync.js';
import { useLibrary } from '../state/library.js';
import { useShell } from '../state/shell.js';
import styles from './DevicesScreen.module.css';

const HOUR_MS = 60 * 60 * 1000;

/**
 * What the activity feed can honestly say about throughput.
 *
 * The server records pairing, approvals, uploads, prints and WebDAV browsing — it does not
 * record a byte counter for range requests, and it does not record when a stream starts or
 * stops. So «داده‌های جابه‌جاشده» is the sum of the byte counts the feed *does* carry
 * (uploads), and «پخش‌های در جریان» has no source at all and says so rather than inventing a
 * plausible number. A stat card with a made-up figure on it is worse than an empty one: the
 * operator will believe it.
 */
function recentBytes(activity: readonly ActivityEntry[], since: number): number | null {
  let total = 0;
  let sawOne = false;
  for (const entry of activity) {
    if (entry.at < since) continue;
    const detail = entry.detail as { bytes?: unknown; totalBytes?: unknown } | null;
    const bytes = typeof detail?.bytes === 'number' ? detail.bytes : detail?.totalBytes;
    if (typeof bytes === 'number' && Number.isFinite(bytes)) {
      total += bytes;
      sawOne = true;
    }
  }
  return sawOne ? total : null;
}

/**
 * Screen 02 — «دستگاه‌ها»: the device list and the device × folder permission matrix.
 *
 * Approving is one click, because the operator has already done the checking — the pairing
 * code is printed next to the button precisely so they can compare it with the phone in
 * front of them. Rejecting and revoking both confirm, because both are irreversible from the
 * device's point of view: it has to pair again.
 */
export function DevicesScreen() {
  const t = useT();
  const c = useCopy();
  const format = useFormat();
  const confirm = useConfirm();
  const toast = useToast();
  const { status } = useShell();
  const { devices, folders, activity, reloadDevices } = useLibrary();

  const pending = devices.filter((device) => device.status === 'pending');
  const settled = devices.filter((device) => device.status !== 'pending');

  const bytes = useMemo(() => recentBytes(activity, Date.now() - HOUR_MS), [activity]);

  const report = (err: unknown) => toast({ tone: 'danger', title: messageOf(err) });

  const approve = async (id: string) => {
    try {
      await getApi().devices.approve(id);
      await reloadDevices();
    } catch (err) {
      report(err);
    }
  };

  const reject = async (device: DeviceSummary) => {
    const accepted = await confirm({
      title: t('devices.reject'),
      body: c('devices.rejectConfirm', { name: device.name }),
      confirmLabel: t('devices.reject'),
      danger: true,
    });
    if (!accepted) return;
    try {
      await getApi().devices.reject(device.id);
      await reloadDevices();
    } catch (err) {
      report(err);
    }
  };

  const revoke = async (device: DeviceSummary) => {
    const accepted = await confirm({
      title: t('devices.revoke'),
      body: c('devices.revokeConfirm', { name: device.name }),
      confirmLabel: t('devices.revoke'),
      danger: true,
    });
    if (!accepted) return;
    try {
      await getApi().devices.revoke(device.id);
      await reloadDevices();
    } catch (err) {
      report(err);
    }
  };

  const setMode = async (deviceId: string, folderId: string, mode: AccessMode) => {
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (!device) return;
    try {
      // The operator API replaces a device's whole grant list, so one cell is sent as the
      // full set with that entry swapped.
      await getApi().devices.setPermissions(deviceId, withPermission(device, folderId, mode));
      await reloadDevices();
    } catch (err) {
      report(err);
    }
  };

  return (
    <div className={styles.screen}>
      <div className={styles.stats}>
        <StatCard
          label={c('devices.statActive')}
          value={format.count(status?.peers ?? 0)}
          icon={<PhoneIcon size={16} />}
          tone={status?.peers ? 'success' : 'neutral'}
        />
        <StatCard
          label={c('devices.statStreams')}
          value="—"
          latin
          icon={<PlayIcon size={16} />}
          footer={c('devices.statNotMeasured')}
        />
        <StatCard
          label={c('devices.statTraffic')}
          value={bytes === null ? '—' : formatBytes(bytes)}
          latin
          icon={<ActivityIcon size={16} />}
          footer={bytes === null ? c('devices.statNotMeasured') : c('devices.statWindow')}
        />
      </div>

      {pending.length > 0 ? (
        <Panel title={c('devices.pendingTitle')} description={c('devices.pendingHint')}>
          <div className={styles.rows}>
            {pending.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onApprove={() => void approve(device.id)}
                onReject={() => void reject(device)}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title={c('devices.listTitle')}>
        {settled.length === 0 ? (
          <EmptyState
            icon={<PhoneIcon size={22} />}
            title={t('devices.empty')}
            description={t('devices.emptyHint')}
          />
        ) : (
          <div className={styles.rows}>
            {settled.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onRevoke={() => void revoke(device)}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel title={t('permissions.title')} description={c('devices.matrixTitle')} flush scrollBody>
        <SectionHeader
          title={t('access.label')}
          description={`${t('access.fullHint')} · ${t('access.streamHint')} · ${t('access.noneHint')}`}
          small
          ruled
          className={styles.legend}
        />
        <PermissionMatrix
          devices={devices}
          folders={folders.map((folder) => ({
            id: folder.id,
            label: folder.label,
            note: folder.available ? undefined : t('folders.unavailable'),
          }))}
          onChange={(deviceId, folderId, mode) => void setMode(deviceId, folderId, mode)}
        />
      </Panel>
    </div>
  );
}
