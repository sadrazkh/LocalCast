import { z } from 'zod';

/**
 * What a device reports it can actually do, and where the report arrived from.
 *
 * The point of this file is to stop the product guessing. Two of its features — the offline
 * library and QR scanning — depend on grants that only a browser can make, and that browsers
 * make differently: a service worker needs a secure context *and* a browser willing to
 * register one on an origin carrying an outstanding certificate error, and `getUserMedia`
 * needs a secure context and a user. Nothing on the developer's machine can settle either.
 * Rather than write a paragraph of "probably", the app asks the device and the device answers.
 *
 * Two rules shaped the payload:
 *
 *   1. **Observed facts only.** Every field is something the page read from its own runtime —
 *      `isSecureContext`, whether `register()` resolved or threw, whether `mediaDevices`
 *      exists. Nothing is inferred and nothing is asked for that the app does not already
 *      need: no user agent, no version, no screen metrics, no locale. A capability report is
 *      not a place to accumulate a fingerprint, and the panel already knows the device's name
 *      and platform because the operator typed the first and pairing recorded the second.
 *   2. **The transport is observed here, not claimed there.** Which listener a request arrived
 *      on is a property of our own socket; asking the client would be asking it to be honest
 *      about the one field it has a reason to lie about.
 */

/** How the attempt to register the service worker ended. This is the answer E2 wants. */
export const serviceWorkerStateSchema = z.enum([
  /** `register()` resolved. The offline library works on this device, on this origin. */
  'registered',
  /** `navigator.serviceWorker` is absent — an old browser, or a private window in some. */
  'unsupported',
  /** The page is not a secure context, so registration was never attempted. */
  'insecure-context',
  /**
   * The browser refused on an origin it otherwise loaded: a `SecurityError` on a certificate
   * it has not been taught to trust. This is the documented Chrome behaviour and the exact
   * case the acceptance checklist could not settle from here.
   */
  'refused',
  /** Registration threw for some other reason; the name of the error comes with it. */
  'failed',
]);
export type ServiceWorkerState = z.infer<typeof serviceWorkerStateSchema>;

export const cameraStateSchema = z.enum([
  /** `getUserMedia` exists and the context is secure. Not the same as permission granted. */
  'available',
  /** No `mediaDevices` at all. */
  'unsupported',
  /** The API is hidden because the origin is not secure — the plain-HTTP case. */
  'insecure-context',
]);

export const storageStateSchema = z.enum([
  /** IndexedDB opened. The offline library has somewhere to live. */
  'indexeddb',
  /** IndexedDB threw or is missing (Safari private browsing); state dies with the tab. */
  'memory',
]);

export const deviceCapabilityReportSchema = z.object({
  /** `window.isSecureContext`. The gate under both features below. */
  secureContext: z.boolean(),
  serviceWorker: serviceWorkerStateSchema,
  /**
   * The `name` of the error registration threw — `SecurityError`, `NotSupportedError` — and
   * never its `message`, which is prose that browsers fill with URLs and paths.
   */
  serviceWorkerError: z.string().max(64).optional(),
  camera: cameraStateSchema,
  storage: storageStateSchema,
  /** Launched from the home screen rather than a browser tab. Answers half of E1. */
  standalone: z.boolean(),
});
export type DeviceCapabilityReport = z.infer<typeof deviceCapabilityReportSchema>;

/** Which of the server's sockets the report came in on. Observed, never claimed. */
export type ObservedListener = 'loopback' | 'lan-tls' | 'lan-plaintext';

export interface StoredCapabilityReport extends DeviceCapabilityReport {
  deviceId: string;
  /** Epoch milliseconds the report arrived. */
  at: number;
  listener: ObservedListener;
}

/**
 * The reports, in memory, one per device.
 *
 * Deliberately not persisted. A capability report describes a browser at a moment — after an
 * iOS update, after the user accepted the certificate, after the app was reinstalled, the same
 * phone answers differently. A row surviving a restart would let the panel state something
 * about a device that has not been seen since, which is the failure this whole endpoint exists
 * to remove. What is durable is the activity entry written when the answer changes.
 */
export class CapabilityReports {
  readonly #byDevice = new Map<string, StoredCapabilityReport>();
  readonly #limit: number;

  constructor(limit = 64) {
    this.#limit = limit;
  }

  /**
   * Stores the report and says whether it differs from what this device last said. Callers use
   * that to write one activity entry per real change instead of one per app launch.
   */
  record(
    deviceId: string,
    report: DeviceCapabilityReport,
    listener: ObservedListener,
    now = Date.now(),
  ): { changed: boolean; stored: StoredCapabilityReport } {
    const previous = this.#byDevice.get(deviceId);
    const stored: StoredCapabilityReport = { ...report, deviceId, at: now, listener };
    const changed = previous === undefined || !sameAnswer(previous, stored);

    // Re-inserted rather than mutated so the Map's insertion order stays a recency order,
    // which is what makes the eviction below drop the device nobody has heard from.
    this.#byDevice.delete(deviceId);
    this.#byDevice.set(deviceId, stored);
    while (this.#byDevice.size > this.#limit) {
      const oldest = this.#byDevice.keys().next();
      if (oldest.done === true) break;
      this.#byDevice.delete(oldest.value);
    }

    return { changed, stored };
  }

  get(deviceId: string): StoredCapabilityReport | null {
    return this.#byDevice.get(deviceId) ?? null;
  }

  /** Newest first, which is the order the panel wants to render. */
  list(): StoredCapabilityReport[] {
    return [...this.#byDevice.values()].sort((a, b) => b.at - a.at);
  }

  forget(deviceId: string): void {
    this.#byDevice.delete(deviceId);
  }
}

/** Equal on the capabilities themselves; the timestamp always differs and never matters. */
function sameAnswer(a: StoredCapabilityReport, b: StoredCapabilityReport): boolean {
  return (
    a.secureContext === b.secureContext &&
    a.serviceWorker === b.serviceWorker &&
    a.serviceWorkerError === b.serviceWorkerError &&
    a.camera === b.camera &&
    a.storage === b.storage &&
    a.standalone === b.standalone &&
    a.listener === b.listener
  );
}

/**
 * Which socket a request arrived on.
 *
 * `viaLan` and `viaPlaintext` are set by the listeners themselves before Express sees the
 * request, so neither can be spoofed by a header.
 */
export function observedListener(req: {
  viaLan?: boolean;
  viaPlaintext?: boolean;
}): ObservedListener {
  if (req.viaPlaintext === true) return 'lan-plaintext';
  return req.viaLan === true ? 'lan-tls' : 'loopback';
}
