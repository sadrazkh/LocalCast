import { z } from 'zod';

/**
 * The three access modes from screen 02 of the design canvas: کامل / فقط پخش / بسته.
 *
 * `stream` is a user-interface restriction, NOT a security boundary — anything that can
 * request byte ranges can reassemble the file. `none` is a real boundary: the folder is
 * absent from listings and search, and every path under it is served as 404.
 */
export const accessModeSchema = z.enum(['full', 'stream', 'none']);
export type AccessMode = z.infer<typeof accessModeSchema>;

export const operationSchema = z.enum(['list', 'stream', 'download', 'print', 'upload']);
export type Operation = z.infer<typeof operationSchema>;

const MATRIX: Record<AccessMode, Record<Operation, boolean>> = {
  full: { list: true, stream: true, download: true, print: true, upload: true },
  stream: { list: true, stream: true, download: false, print: false, upload: false },
  none: { list: false, stream: false, download: false, print: false, upload: false },
};

/**
 * Single decision point for every authorization check in the system. The server calls this
 * per request against the mode it just read from SQLite — modes are never carried in a JWT,
 * so revoking access in the panel takes effect on the next request.
 *
 * `upload` additionally requires the folder itself to be writable; that is checked by the
 * caller, because it is a property of the folder rather than of the grant.
 */
export function can(mode: AccessMode, op: Operation): boolean {
  return MATRIX[mode][op];
}

export const folderPermissionSchema = z.object({
  folderId: z.string(),
  mode: accessModeSchema,
});
export type FolderPermission = z.infer<typeof folderPermissionSchema>;
