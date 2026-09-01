import type {
  PreflightBridge,
  PreflightReport,
  PrerequisiteStatus,
} from '../../shared/preflight.js';

/**
 * The renderer's half of the prerequisites bridge.
 *
 * The shape is the contract's own `PreflightBridge` — this file does not restate it. What it
 * adds is the thing a type cannot: **the bridge is feature-detected at runtime.** `DesktopApi`
 * declares `preflight` as always present, and in a shipped build it is; but the preload script
 * is a separate file that can lag, and a prerequisites screen that threw because the bridge
 * was one commit behind would be the exact failure the contract exists to prevent — a first
 * screen wired to nothing.
 */

export type PreflightApi = PreflightBridge;

export interface InstallOptions {
  /**
   * The digest the user read on the publisher's own checksum page and confirmed by hand.
   *
   * Present **only** when it came from the confirm control on a `digest-unrecorded` result.
   * Nothing else in this directory sets it, and no code path installs an unverified file
   * without it.
   */
  confirmedSha256?: string;
}

/**
 * Every method is independently optional: the preload may expose `run` before `install`, and
 * a screen that assumed otherwise would break on the intermediate commit.
 */
export type PartialPreflightApi = Partial<PreflightApi>;

export function getPreflightApi(): PartialPreflightApi | null {
  const bridge = (globalThis as { localcast?: unknown }).localcast;
  if (!bridge || typeof bridge !== 'object') return null;
  const candidate = (bridge as { preflight?: unknown }).preflight;
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate as PartialPreflightApi;
}

/** True when the main process can at least tell us what is missing. */
export function canCheck(api: PartialPreflightApi | null): api is PartialPreflightApi {
  return typeof api?.run === 'function';
}

/**
 * Opens a URL in the user's real browser.
 *
 * The renderer has no network access — its CSP forbids it — so the publisher's page can only
 * be shown by the main process. `app.openExternal` already exists for exactly this, which is
 * why the digest panel does not need a new IPC method of its own.
 */
export async function openInBrowser(url: string): Promise<void> {
  const bridge = (globalThis as { localcast?: { app?: { openExternal?(u: string): Promise<void> } } })
    .localcast;
  const open = bridge?.app?.openExternal;
  if (typeof open !== 'function') return;
  await open(url);
}

/**
 * Normalises whatever arrives on the progress channel.
 *
 * The contract names the channel but not its payload, and both readings are reasonable: a
 * single changed item, or the whole report again. Accepting either here means the screen
 * cannot be wrong about which one the main process chose.
 */
export function applyProgress(
  current: PreflightReport | null,
  payload: PrerequisiteStatus | PreflightReport,
): PreflightReport | null {
  if (isReport(payload)) return payload;
  if (!current || !isStatus(payload)) return current;
  const items = current.items.map((item) => (item.id === payload.id ? payload : item));
  return { ...current, items };
}

export function isReport(value: unknown): value is PreflightReport {
  return (
    !!value && typeof value === 'object' && Array.isArray((value as PreflightReport).items)
  );
}

function isStatus(value: unknown): value is PrerequisiteStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as PrerequisiteStatus;
  return typeof status.id === 'string' && typeof status.state === 'string';
}
