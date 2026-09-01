import type { AccessMode, DeviceSummary, Folder } from '@localcast/contract';
// Type-only, but the import is load-bearing: it is what pulls `src/shared/ipc.ts` into the
// renderer's program, and with it the `declare global { interface Window { localcast } }`
// that makes `window.localcast` typed at all.
import type { AppInfo, DesktopApi, PairingMintResult } from '../../shared/ipc.js';

export type { AppInfo, DesktopApi, PairingMintResult };

/**
 * The renderer's whole backend is `window.localcast`. There is no fetch, no socket and no
 * Node access here — every privileged action goes through the narrow preload bridge.
 */
export function getApi(): DesktopApi {
  const api = window.localcast;
  if (!api) {
    throw new Error(
      'window.localcast is missing. The renderer was loaded outside Electron, or the preload ' +
        'script failed — either way nothing on this screen can work.',
    );
  }
  return api;
}

/**
 * The operator API answers `{ folders: [...] }`, `{ devices: [...] }` and
 * `{ entries: [...] }`, and the main process forwards those envelopes verbatim even though
 * `DesktopApi` declares the methods as returning bare arrays. Rather than render a blank
 * table when the declared type and the wire disagree, every list call is unwrapped here —
 * one place, tolerant of both shapes, so the fix in main (whenever it lands) needs no change
 * on this side.
 */
function unwrapList<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

/**
 * What `/operator/v1/folders` actually returns. It is richer than the contract's `Folder`
 * (it carries the absolute path, the auto-index flag and the operator's enable switch) and
 * poorer in one way — there is no `mode`, because a folder's access mode is a property of a
 * `(device, folder)` pair, not of the folder.
 */
export interface AdminFolder extends Omit<Folder, 'mode'> {
  path: string;
  autoIndex: boolean;
  enabled: boolean;
  createdAt?: number;
}

export interface ActivityEntry {
  at: number;
  kind: string;
  deviceId: string | null;
  deviceName?: string | null;
  detail: unknown;
}

export async function listFolders(): Promise<AdminFolder[]> {
  const raw: unknown = await getApi().folders.list();
  return unwrapList<AdminFolder>(raw, 'folders');
}

export async function listDevices(): Promise<DeviceSummary[]> {
  const raw: unknown = await getApi().devices.list();
  return unwrapList<DeviceSummary>(raw, 'devices');
}

export async function listActivity(limit = 100): Promise<ActivityEntry[]> {
  const raw: unknown = await getApi().app.activity(limit);
  return unwrapList<ActivityEntry>(raw, 'entries');
}

/**
 * The QR payload as a single string.
 *
 * `PairingMintResult` declares `payload: string`, but the operator API returns the parsed
 * `qr` object. Both are accepted: a string is passed through untouched (the spec is explicit
 * that the renderer must not reformat what the server minted), and an object is serialised
 * once, here, rather than in three call sites.
 */
/**
 * What the QR image should encode.
 *
 * The link first, always. It is an ordinary URL, so the phone's own camera opens it and the
 * web app loads at the right address with the pairing details in the fragment — no scanner
 * inside LocalCast, no camera permission, no secure context needed to *begin*.
 *
 * The JSON payload is the fallback for a machine with no local address to publish. It can
 * only be read by LocalCast's own scanner, which is exactly the trap this replaced: encoding
 * it meant a code that a camera app looks at and does nothing with.
 */
export function qrPayloadOf(minted: PairingMintResult): string {
  const loose = minted as unknown as { link?: unknown; payload?: unknown; qr?: unknown };
  if (typeof loose.link === 'string' && loose.link.length > 0) return loose.link;
  if (typeof loose.payload === 'string') return loose.payload;
  if (loose.qr && typeof loose.qr === 'object') return JSON.stringify(loose.qr);
  return '';
}

export type FolderPatch = Partial<{
  label: string;
  writable: boolean;
  autoIndex: boolean;
  /** The share toggle on screen 01. */
  enabled: boolean;
}>;

/**
 * `DesktopApi.folders.update` narrows the patch to label/writable/autoIndex, but the operator
 * API's `PATCH /folders/:id` also accepts `enabled`, and the main process forwards the body
 * verbatim. The cast records that mismatch in one place rather than at every call site.
 */
export function updateFolder(id: string, patch: FolderPatch) {
  type Declared = Parameters<DesktopApi['folders']['update']>[1];
  return getApi().folders.update(id, patch as Declared);
}

export type PermissionPatch = { folderId: string; mode: AccessMode };

/**
 * Applies one cell of the permission matrix.
 *
 * The operator API replaces the whole permission set for a device, so a single cell change
 * has to be sent as the device's complete grant list with that one entry swapped. Doing it
 * here keeps the screen from having to remember that.
 */
export function withPermission(
  device: DeviceSummary,
  folderId: string,
  mode: AccessMode,
): PermissionPatch[] {
  const next = device.permissions.filter((permission) => permission.folderId !== folderId);
  next.push({ folderId, mode });
  return next;
}
