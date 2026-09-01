import type { ReactNode } from 'react';
import type { AccessMode, FolderPermission } from '@localcast/contract';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { AccessModeSelector } from './AccessModeSelector.js';
import { EmptyState } from './EmptyState.js';
import { PhoneIcon } from '../icons/index.js';
import styles from './PermissionMatrix.module.css';

export interface PermissionMatrixDevice {
  id: string;
  name: string;
  /** `pending` and `revoked` rows are shown but not editable. */
  status?: 'pending' | 'active' | 'revoked';
  permissions: readonly FolderPermission[];
  /** Second line under the name — platform, last seen, anything short. */
  note?: ReactNode;
}

export interface PermissionMatrixFolder {
  id: string;
  label: string;
  /** Second line under the column header, e.g. «در دسترس نیست». */
  note?: ReactNode;
}

export interface PermissionMatrixProps {
  devices: readonly PermissionMatrixDevice[];
  folders: readonly PermissionMatrixFolder[];
  onChange: (deviceId: string, folderId: string, mode: AccessMode) => void;
  disabled?: boolean;
  empty?: ReactNode;
  className?: string;
}

/** A folder with no explicit grant is closed. `none` is the default, never `full`. */
function modeFor(device: PermissionMatrixDevice, folderId: string): AccessMode {
  return device.permissions.find((permission) => permission.folderId === folderId)?.mode ?? 'none';
}

/**
 * The device × folder grid from screen 02.
 *
 * A real `<table>` with `<th scope>` on both axes, so a screen reader announces "آیفون علی,
 * فیلم‌ها, کامل" when it lands on a cell rather than reading a wall of unlabelled controls.
 *
 * Keyboard model: each cell holds one `AccessModeSelector`, which is an ARIA radiogroup and
 * therefore has exactly one tab stop. Arrow keys change the mode *within* a cell; Tab and
 * Shift+Tab move *between* cells in reading order. This is the standard grid-of-radiogroups
 * behaviour, and it is why the selector uses a roving tabindex — without it a six-folder,
 * five-device matrix would need ninety Tab presses to cross.
 */
export function PermissionMatrix({
  devices,
  folders,
  onChange,
  disabled = false,
  empty,
  className,
}: PermissionMatrixProps) {
  const t = useT();

  if (devices.length === 0 || folders.length === 0) {
    return (
      <>
        {empty ?? (
          <EmptyState
            icon={<PhoneIcon size={22} />}
            title={t('permissions.empty')}
            description={t('devices.emptyHint')}
            compact
          />
        )}
      </>
    );
  }

  return (
    <div className={cx(styles.scroll, className)}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.corner}>
              {t('permissions.deviceColumn')}
            </th>
            {folders.map((folder) => (
              <th key={folder.id} scope="col" className={styles.columnHeader}>
                <span className={styles.folderLabel} title={folder.label}>
                  {folder.label}
                </span>
                {folder.note ? <span className={styles.folderNote}>{folder.note}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            const locked = disabled || device.status === 'revoked' || device.status === 'pending';
            return (
              <tr key={device.id} className={cx(styles.row, locked ? styles.locked : undefined)}>
                <th scope="row" className={styles.rowHeader}>
                  <span className={styles.deviceName} title={device.name}>
                    {device.name}
                  </span>
                  {device.note ? <span className={styles.deviceNote}>{device.note}</span> : null}
                </th>
                {folders.map((folder) => (
                  <td key={folder.id} className={styles.cell}>
                    <AccessModeSelector
                      size="sm"
                      value={modeFor(device, folder.id)}
                      disabled={locked}
                      aria-label={t('permissions.cellLabel', {
                        device: device.name,
                        folder: folder.label,
                      })}
                      onChange={(mode) => onChange(device.id, folder.id, mode)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
