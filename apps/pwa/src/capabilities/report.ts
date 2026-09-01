import type { DeviceCapabilities } from './detect.js';

/**
 * Telling the server what this browser granted, so the Windows panel can say "this phone could
 * not install the offline library" instead of the person finding out on an aeroplane.
 *
 * What is sent is the capability record and nothing else: no user agent, no version, no screen
 * size, no locale. The panel already knows this device's name, because the operator typed it,
 * and its platform, because pairing recorded it. A capability report is not a place to
 * accumulate a fingerprint, and the server does not ask which browser this is — only what it
 * did. Nor does the payload say which address the app was loaded from: the server can see
 * which of its own sockets the request arrived on, and asking the client would be asking it to
 * be honest about the one field it has any reason to be wrong about.
 */

/** Exactly the fields the server's schema accepts; see `apps/server/src/http/capabilities.ts`. */
export interface CapabilityReportBody {
  secureContext: boolean;
  serviceWorker: 'registered' | 'unsupported' | 'insecure-context' | 'refused' | 'failed';
  serviceWorkerError?: string;
  camera: 'available' | 'unsupported' | 'insecure-context';
  storage: 'indexeddb' | 'memory';
  standalone: boolean;
}

/**
 * Returns null while the registration attempt is still in flight. A `pending` report would
 * make the panel say "no offline library" about a device that is three hundred milliseconds
 * away from having one.
 */
export function toReportBody(capabilities: DeviceCapabilities): CapabilityReportBody | null {
  if (capabilities.serviceWorker === 'pending') return null;
  return {
    secureContext: capabilities.secureContext,
    serviceWorker: capabilities.serviceWorker,
    ...(capabilities.serviceWorkerError === undefined
      ? {}
      : { serviceWorkerError: capabilities.serviceWorkerError }),
    camera: capabilities.camera,
    storage: capabilities.storage,
    standalone: capabilities.standalone,
  };
}

export interface PostCapabilityOptions {
  baseUrl: string;
  accessToken: string;
  body: CapabilityReportBody;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Posts the report. Resolves to whether the server accepted it.
 *
 * Deliberately never throws. This is a diagnostic the user did not ask for; a phone that is
 * offline, or paired to a server too old to have the endpoint, must carry on browsing its
 * library exactly as before. Nothing in the app waits on the result.
 */
export async function postCapabilityReport(options: PostCapabilityOptions): Promise<boolean> {
  const request = options.fetchImpl ?? fetch;
  try {
    const res = await request(`${options.baseUrl}/api/v1/capabilities`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.accessToken}`,
      },
      body: JSON.stringify(options.body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
