/**
 * What this browser actually granted this origin.
 *
 * The app used to assume. It assumed a secure context meant a service worker, and a service
 * worker meant an offline library, and an `https://` scheme meant a secure context. On the
 * local network — where the certificate is one the app signed itself and the user clicked
 * through a warning to get here — every one of those implications is a browser's decision, not
 * a specification's. Chrome is documented to refuse to register a service worker on an origin
 * carrying an outstanding certificate error. Safari on iOS has never been checked.
 *
 * So this module stops assuming and reads. Everything here is an observation of the runtime
 * the page is actually in: `isSecureContext`, whether `navigator.serviceWorker` exists,
 * whether `register()` resolved or threw and with which error *name*, whether `mediaDevices`
 * is exposed, whether IndexedDB can be reached, whether the page was launched from the home
 * screen. Nothing is inferred from a version string and no version string is read — the
 * question is what this browser did, not which browser it is.
 *
 * The functions are pure and take their environment, so every branch below is testable without
 * a phone. Reading the real globals is one small function at the bottom.
 */

export type ServiceWorkerState =
  /** Registration resolved. The offline library works here. */
  | 'registered'
  /** `navigator.serviceWorker` is absent entirely. */
  | 'unsupported'
  /** Not a secure context, so registration was never attempted — the plain-HTTP case. */
  | 'insecure-context'
  /**
   * The browser loaded the page and then refused to register, which on a self-signed origin
   * means it is holding the certificate against us. This is the E2 answer nobody had.
   */
  | 'refused'
  /** Registration threw for another reason; the error's name comes with it. */
  | 'failed'
  /** Still waiting for the attempt to settle. Never reported to the server. */
  | 'pending';

export type CameraState = 'available' | 'unsupported' | 'insecure-context';

export type StorageState = 'indexeddb' | 'memory';

export interface DeviceCapabilities {
  secureContext: boolean;
  serviceWorker: ServiceWorkerState;
  /** The error's `name` only. Its `message` is prose browsers fill with URLs and paths. */
  serviceWorkerError?: string;
  camera: CameraState;
  storage: StorageState;
  standalone: boolean;
}

/** The handful of facts read from the platform, separated so the logic above can be tested. */
export interface CapabilityEnvironment {
  secureContext: boolean;
  hasServiceWorker: boolean;
  hasMediaDevices: boolean;
  /**
   * IndexedDB is reachable. Not the same as "a write succeeded" — proving that would mean
   * opening a database as a side effect of describing the browser, and the app opens its own
   * a moment later anyway.
   */
  hasIndexedDb: boolean;
  standalone: boolean;
}

/** The starting point: everything except the outcome of an attempt that has not happened yet. */
export function initialCapabilities(env: CapabilityEnvironment): DeviceCapabilities {
  return {
    secureContext: env.secureContext,
    serviceWorker: pendingServiceWorkerState(env),
    camera: cameraState(env),
    storage: env.hasIndexedDb ? 'indexeddb' : 'memory',
    standalone: env.standalone,
  };
}

function pendingServiceWorkerState(env: CapabilityEnvironment): ServiceWorkerState {
  // Order matters: an insecure origin hides `navigator.serviceWorker` altogether, and
  // reporting that as "this browser does not support service workers" would send the reader
  // looking for a browser bug instead of at the `http://` in their address bar.
  if (!env.secureContext) return 'insecure-context';
  if (!env.hasServiceWorker) return 'unsupported';
  return 'pending';
}

function cameraState(env: CapabilityEnvironment): CameraState {
  if (!env.secureContext) return 'insecure-context';
  return env.hasMediaDevices ? 'available' : 'unsupported';
}

export type ServiceWorkerOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Fold the result of the registration attempt into the capabilities.
 *
 * A `SecurityError` is singled out because it is the specific answer this whole exercise was
 * built to capture: the page loaded, the certificate warning was accepted, and the browser
 * still would not register a worker on the origin. Everything else is `failed` with the name
 * attached, so an unfamiliar refusal arrives as a fact rather than as a shrug.
 */
export function applyServiceWorkerOutcome(
  capabilities: DeviceCapabilities,
  outcome: ServiceWorkerOutcome,
): DeviceCapabilities {
  if (outcome.ok) {
    const { serviceWorkerError: _dropped, ...rest } = capabilities;
    return { ...rest, serviceWorker: 'registered' };
  }

  const name = errorName(outcome.error);
  // An insecure origin never got as far as a real attempt; keep the accurate reason.
  if (!capabilities.secureContext) {
    return { ...capabilities, serviceWorker: 'insecure-context' };
  }
  return {
    ...capabilities,
    serviceWorker: name === 'SecurityError' ? 'refused' : 'failed',
    serviceWorkerError: name,
  };
}

/** Bounded, because it is sent to the server and shown on a screen. */
function errorName(error: unknown): string {
  const raw =
    typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
      ? (error as { name: string }).name
      : 'Error';
  return raw.slice(0, 64);
}

/** True once the attempt has settled, i.e. once there is something worth reporting. */
export function isSettled(capabilities: DeviceCapabilities): boolean {
  return capabilities.serviceWorker !== 'pending';
}

/** The offline library is exactly one thing: a registered worker with somewhere to write. */
export function hasOfflineLibrary(capabilities: DeviceCapabilities): boolean {
  return capabilities.serviceWorker === 'registered' && capabilities.storage === 'indexeddb';
}

/**
 * Whether the bytes for this page crossed a network in the clear.
 *
 * Separate from `secureContext` because the two disagree in both directions and the user cares
 * about a different one of them in each case. `http://localhost` is a secure context and
 * crosses no network; `https://` on a self-signed certificate is encrypted whatever a browser
 * thinks of the issuer. What this answers is only "could someone else on this Wi-Fi read it",
 * which is the sentence the banner has to be honest about.
 */
export function isEncryptedTransport(location: { protocol: string; hostname: string }): boolean {
  if (location.protocol === 'https:') return true;
  // Loopback never leaves the machine, so plain HTTP there is not an exposure. This is the
  // same line browsers draw when they call `http://localhost` a trustworthy origin.
  const host = location.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Read the real platform.
 *
 * Every access is guarded. A sandboxed iframe throws on `indexedDB`, an old WebView has no
 * `matchMedia`, and a page that crashes while describing itself has described nothing.
 */
export function readEnvironment(win: Window & typeof globalThis = window): CapabilityEnvironment {
  return {
    secureContext: win.isSecureContext === true,
    hasServiceWorker: has(() => win.navigator.serviceWorker !== undefined),
    hasMediaDevices: has(() => win.navigator.mediaDevices?.getUserMedia !== undefined),
    hasIndexedDb: has(() => win.indexedDB !== undefined && win.indexedDB !== null),
    standalone: has(
      () =>
        win.matchMedia?.('(display-mode: standalone)').matches === true ||
        // iOS Safari does not implement the display-mode query for home-screen web apps; this
        // non-standard property is the only way to know there, and it is the platform E1 is
        // written about.
        (win.navigator as Navigator & { standalone?: boolean }).standalone === true,
    ),
  };
}

function has(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}
