import type { CopyKey } from './copy.js';

/**
 * The activity kinds the server records today, mapped to something an operator can read.
 *
 * An unknown kind is shown as its raw identifier rather than swallowed: a new event type
 * added to the server should show up in the feed looking unfinished, which is a bug report,
 * instead of vanishing, which is not.
 */
const KIND_KEY: Record<string, CopyKey> = {
  'device.claimed': 'act.device.claimed',
  'device.approved': 'act.device.approved',
  'device.rejected': 'act.device.rejected',
  'device.revoked': 'act.device.revoked',
  'device.paired': 'act.device.paired',
  'device.deleted': 'act.device.deleted',
  'folder.added': 'act.folder.added',
  'folder.removed': 'act.folder.removed',
  'folder.updated': 'act.folder.updated',
  'pairing.minted': 'act.pairing.minted',
  'permissions.updated': 'act.permissions.updated',
  'print.queued': 'act.print.queued',
  'upload.started': 'act.upload.started',
  'upload.completed': 'act.upload.completed',
  'upload.aborted': 'act.upload.aborted',
  'dav.propfind': 'act.dav.propfind',
};

export function activityKey(kind: string): CopyKey | null {
  return KIND_KEY[kind] ?? null;
}

/**
 * A one-line gloss of the entry's detail: the label of the folder, the name of the file, the
 * code that was minted. Anything longer than that belongs in a log, not in a feed.
 */
export function activityDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  for (const key of ['label', 'name', 'relativePath', 'fileName', 'path', 'code']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * What a device is doing right now, for the tray popover's connected list.
 *
 * Derived from the most recent activity entry attributed to the device, because that is the
 * only per-device signal the API carries — there is no "current stream" endpoint. A device
 * with nothing recent is «بی‌کار», which is honest; claiming it is streaming because it is
 * connected would not be.
 */
export function doingKey(kind: string | null): CopyKey | null {
  if (!kind) return null;
  if (kind.startsWith('upload.')) return 'doing.uploading';
  if (kind.startsWith('print.')) return 'doing.printing';
  if (kind.startsWith('dav.')) return 'doing.browsing';
  return null;
}
