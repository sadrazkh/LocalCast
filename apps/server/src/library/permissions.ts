import { ApiException, ErrorCode, can, type AccessMode, type Operation } from '@localcast/contract';
import type { Database as Db } from 'better-sqlite3';
import type { PermissionService } from '../kernel.js';

/**
 * Which typed error a refusal becomes. `none` is handled separately and never reaches this
 * table, because a `none` folder must be indistinguishable from one that does not exist.
 */
const REFUSAL: Record<Operation, (typeof ErrorCode)[keyof typeof ErrorCode]> = {
  list: ErrorCode.FORBIDDEN,
  stream: ErrorCode.FORBIDDEN,
  download: ErrorCode.DOWNLOAD_NOT_ALLOWED,
  print: ErrorCode.PRINT_NOT_ALLOWED,
  upload: ErrorCode.UPLOAD_NOT_ALLOWED,
};

export class SqlPermissionService implements PermissionService {
  constructor(private readonly db: Db) {}

  /**
   * Straight from SQLite on every call, never memoised across a request. This is what makes
   * the panel's "بستن" button take effect on the next request rather than at token expiry.
   *
   * The default is `none`: a folder with no row for this device is closed, so adding a
   * folder never silently grants it to every device already paired.
   */
  modeFor(deviceId: string, folderId: string): AccessMode {
    const row = this.db
      .prepare(
        `SELECT p.mode AS mode
           FROM folder_permissions p
           JOIN shared_folders f ON f.id = p.folder_id
          WHERE p.device_id = ? AND p.folder_id = ? AND f.enabled = 1`,
      )
      .get(deviceId, folderId) as { mode: AccessMode } | undefined;
    return row?.mode ?? 'none';
  }

  assertCan(deviceId: string, folderId: string, op: Operation): void {
    const mode = this.modeFor(deviceId, folderId);
    if (mode === 'none') {
      // Deliberately NOT_FOUND. A 403 here would confirm the folder exists and let a caller
      // map the whole permission matrix by probing ids.
      throw new ApiException(ErrorCode.NOT_FOUND, 'Not found');
    }
    if (!can(mode, op)) {
      throw new ApiException(REFUSAL[op], refusalMessage(op));
    }
  }

  visibleFolders(deviceId: string): string[] {
    return this.db
      .prepare(
        `SELECT p.folder_id AS id
           FROM folder_permissions p
           JOIN shared_folders f ON f.id = p.folder_id
          WHERE p.device_id = ? AND p.mode <> 'none' AND f.enabled = 1
          ORDER BY f.label`,
      )
      .all(deviceId)
      .map((r) => (r as { id: string }).id);
  }

  /** Convenience for routes that need the mode alongside the check. */
  requireMode(deviceId: string, folderId: string, op: Operation): AccessMode {
    this.assertCan(deviceId, folderId, op);
    return this.modeFor(deviceId, folderId);
  }
}

function refusalMessage(op: Operation): string {
  switch (op) {
    case 'download':
      return 'This folder is shared for playback only';
    case 'print':
      return 'Printing is not allowed from this folder';
    case 'upload':
      return 'Uploading is not allowed to this folder';
    default:
      return 'Not allowed';
  }
}
