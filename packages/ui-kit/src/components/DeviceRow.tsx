import type { ReactNode } from 'react';
import type { Platform } from '@localcast/contract';
import { useFormat, useT } from '../i18n/index.js';
import type { MessageKey } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { LibraryIcon, MonitorIcon, PhoneIcon, ServerIcon } from '../icons/index.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { PairingCode } from './PairingCode.js';
import styles from './DeviceRow.module.css';

export type DeviceStatus = 'pending' | 'active' | 'revoked';

export interface DeviceRowDevice {
  id: string;
  name: string;
  platform: Platform;
  status: DeviceStatus;
  lastSeenAt: number | null;
  /** Present only while the device is waiting for approval. */
  pairingCode?: string | null;
}

export interface DeviceRowProps {
  device: DeviceRowDevice;
  onApprove?: (deviceId: string) => void;
  onReject?: (deviceId: string) => void;
  onRevoke?: (deviceId: string) => void;
  /** Extra trailing controls, e.g. a `Dropdown` of less common operations. */
  actions?: ReactNode;
  className?: string;
}

const PLATFORM_ICON: Record<Platform, (props: { size?: number }) => ReactNode> = {
  'ios-pwa': PhoneIcon,
  'android-pwa': PhoneIcon,
  windows: MonitorIcon,
  web: LibraryIcon,
  webdav: ServerIcon,
};

const PLATFORM_LABEL: Record<Platform, MessageKey> = {
  'ios-pwa': 'devices.platform.ios-pwa',
  'android-pwa': 'devices.platform.android-pwa',
  windows: 'devices.platform.windows',
  web: 'devices.platform.web',
  webdav: 'devices.platform.webdav',
};

const STATUS: Record<DeviceStatus, { key: MessageKey; tone: 'warning' | 'success' | 'neutral' }> = {
  pending: { key: 'devices.pending', tone: 'warning' },
  active: { key: 'devices.active', tone: 'success' },
  revoked: { key: 'devices.revoked', tone: 'neutral' },
};

/**
 * One device in the «دستگاه‌ها» list: name, platform, status, last seen, and — while it is
 * waiting — its pairing code with approve and reject.
 *
 * The pairing code is shown next to the approve button on purpose: the operator's job is to
 * check that the code on the phone in front of them matches the one on screen before
 * approving. Hiding it behind a details view turns approval into a rubber stamp.
 *
 * The last-seen timestamp uses Persian digits and the Persian calendar under `fa`; it is
 * read, not copied. Nothing about the transport appears here — no address, no relay.
 */
export function DeviceRow({ device, onApprove, onReject, onRevoke, actions, className }: DeviceRowProps) {
  const t = useT();
  const format = useFormat();
  const Icon = PLATFORM_ICON[device.platform];
  const status = STATUS[device.status];

  return (
    <div
      className={cx(
        styles.row,
        device.status === 'pending' ? styles.pending : undefined,
        device.status === 'revoked' ? styles.revoked : undefined,
        className,
      )}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon size={16} />
      </span>

      <div className={styles.body}>
        <div className={styles.nameRow}>
          <span className={styles.name} title={device.name}>
            {device.name}
          </span>
          <Badge tone={status.tone} dot>
            {t(status.key)}
          </Badge>
        </div>
        <div className={styles.meta}>
          <span>{t(PLATFORM_LABEL[device.platform])}</span>
          <span className={styles.separator} aria-hidden="true">
            ·
          </span>
          <span>
            {t('devices.lastSeen')}:{' '}
            {device.lastSeenAt === null
              ? t('devices.neverSeen')
              : format.date(device.lastSeenAt, 'datetime')}
          </span>
        </div>
      </div>

      {device.status === 'pending' && device.pairingCode ? (
        <PairingCode
          code={device.pairingCode}
          size="sm"
          label={t('devices.pairingCode')}
          className={styles.code}
        />
      ) : null}

      <div className={styles.actions}>
        {device.status === 'pending' && onApprove ? (
          <Button variant="primary" size="sm" onClick={() => onApprove(device.id)}>
            {t('devices.approve')}
          </Button>
        ) : null}
        {device.status === 'pending' && onReject ? (
          <Button variant="ghost" size="sm" onClick={() => onReject(device.id)}>
            {t('devices.reject')}
          </Button>
        ) : null}
        {device.status === 'active' && onRevoke ? (
          <Button variant="danger" size="sm" onClick={() => onRevoke(device.id)}>
            {t('devices.revoke')}
          </Button>
        ) : null}
        {actions}
      </div>
    </div>
  );
}
