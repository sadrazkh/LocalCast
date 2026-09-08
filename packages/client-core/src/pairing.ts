import { ErrorCode, qrPayloadSchema } from '@localcast/contract';
import type { Platform, QrPayload } from '@localcast/contract';
import type { ApiClient } from './api.js';
import type { BackoffOptions, Sleep } from './backoff.js';
import { backoffDelay, PAIRING_POLL_BACKOFF, systemSleep } from './backoff.js';
import { endpointFromQr } from './certificates.js';
import { CancelledError, LocalCastError, tryParseJson } from './errors.js';
import type { Clock, StoredSession } from './ports.js';

/**
 * The pairing token's TTL from the data model is five minutes, so waiting longer than that
 * for the operator is waiting for something that has already expired.
 */
export const PAIRING_TIMEOUT_MS = 5 * 60_000;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function invalid(reason: string, detail?: Record<string, unknown>): LocalCastError {
  return new LocalCastError(ErrorCode.PAIRING_INVALID, reason, { detail });
}

/**
 * A pairing host must be a MagicDNS FQDN.
 *
 * A bare IP — the mockup's `192.168.1.31` — cannot have a Let's Encrypt certificate, so a QR
 * carrying one leads straight to a TLS error the user cannot act on. Rejecting it while the
 * camera is still open is the only place this can be said clearly. The same check throws out
 * a QR that smuggles in a scheme, a port, credentials or a path, i.e. one that was not
 * produced by this server at all.
 */
export function isPairableHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (/[\s/@:\\?#]/.test(host)) return false;
  if (IPV4.test(host)) return false;
  return DNS_NAME.test(host);
}

/**
 * Reads a pairing URL: `http://192.168.1.24:8420/#p=CODE.SECRET`.
 *
 * The fragment, not the query, and that is deliberate: a fragment is never sent to the server
 * and never appears in a server log, so the pairing secret does not end up written down
 * somewhere it outlives the sixty seconds it is meant to exist for.
 */
function fromPairingUrl(text: string): QrPayload {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid('the scanned code is not a LocalCast pairing link');
  }

  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(fragment);
  const raw = params.get('p') ?? '';
  const [code, secret] = raw.split('.');

  if (!code) throw invalid('that link has no pairing code in it');

  // The same rule the JSON form is held to: HTTPS anywhere, plaintext only on a local address.
  // A link is the easiest of the two forms to hand somebody, so it is the one that most needs
  // to refuse `http://somewhere-on-the-internet`.
  if (!isUsableOrigin(url.origin)) {
    throw invalid('this pairing link points at an address LocalCast cannot use', {
      fields: ['url'],
    });
  }

  return qrPayloadSchema.parse({
    v: 1,
    host: url.hostname,
    code: code.toUpperCase(),
    ...(secret ? { secret } : {}),
    url: url.origin,
  });
}

/**
 * Validate a scanned QR string. Anything malformed comes out as a typed `pairing_invalid`,
 * never as a `SyntaxError` from `JSON.parse` reaching a camera view.
 */
export function parseQrPayload(raw: string): QrPayload {
  const text = raw.trim();
  if (text.length === 0) throw invalid('the scanned code was empty');

  // A URL first, because that is what the QR code now carries.
  //
  // The code used to be a JSON blob. A phone's own camera app cannot do anything with that —
  // it is not a link — so scanning it outside LocalCast did nothing at all, and scanning it
  // inside LocalCast needed the camera, which needs a secure context, which the self-signed
  // certificate was in the way of. The result was a QR code nothing could read.
  //
  // As a URL the camera opens the app, and the app finds the pairing details in the fragment.
  // The JSON form is still accepted so codes already in circulation keep working.
  if (/^https?:\/\//i.test(text)) return fromPairingUrl(text);

  const parsed = tryParseJson(text);
  if (!parsed.ok) throw invalid('the scanned code is not a LocalCast pairing code');

  const result = qrPayloadSchema.safeParse(parsed.value);
  if (!result.success) {
    // Report the failing fields, not prose: `v` wrong means a different LocalCast version,
    // a missing `secret` means a truncated or hand-made QR, and the caller may want to say
    // different things about the two.
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw invalid('this pairing code is not one this app understands', { fields });
  }

  // Only when the payload has no explicit origin. `url` is a validated absolute URL and is
  // the address the client will actually use, so a bare IP there is correct rather than
  // suspect — `host` is only a fallback spelling for the tailnet name.
  if (result.data.url === undefined && !isPairableHost(result.data.host)) {
    throw invalid('this pairing code points at an address LocalCast cannot use', {
      fields: ['host'],
    });
  }
  if (result.data.url !== undefined && !isUsableOrigin(result.data.url)) {
    throw invalid('this pairing code points at an address LocalCast cannot use', {
      fields: ['url'],
    });
  }
  return result.data;
}

/** `10/8`, `172.16/12`, `192.168/16`, loopback, link-local — plus `localhost` and `*.local`. */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!IPV4.test(host)) return false;
  return (
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * An origin a pairing payload may point a client at.
 *
 * `https://` anywhere, and `http://` **only for an address on the local network**.
 *
 * The asymmetry is the point. Plaintext exists in this product as one deliberate, switchable
 * fallback for a device that cannot get past a self-signed certificate's interstitial, and that
 * fallback lives at `http://192.168.x.y:8421` — so refusing plaintext outright would refuse the
 * very address the operator turned on. But `http://` to a routable host is a different thing
 * entirely: nothing in LocalCast ever mints one, so a payload carrying one is either a server
 * from before this rule or somebody trying to talk a client out of TLS on the open internet.
 * That is refused, and the local case is not.
 */
export function isUsableOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHostname(parsed.hostname))) {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') return false;
  // A pairing origin names a server, not a page on one.
  if (parsed.search !== '' || parsed.hash !== '') return false;
  return parsed.pathname === '/' || parsed.pathname === '';
}

export type PairingPhase = 'claiming' | 'waiting-for-approval';

export interface PairingOptions {
  api: ApiClient;
  clock: Clock;
  /** The scanned string, or an already-parsed payload when the code was typed by hand. */
  qr: string | QrPayload;
  deviceName: string;
  platform: Platform;
  /** Caller-supplied cancellation: the user backing out of the pairing screen. */
  signal?: AbortSignal;
  onPhase?: (phase: PairingPhase) => void;
  timeoutMs?: number;
  backoff?: BackoffOptions;
  sleep?: Sleep;
  random?: () => number;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CancelledError('pairing');
}

/**
 * claim → poll until the operator approves.
 *
 * The poll backs off, but gently (see `PAIRING_POLL_BACKOFF`): the operator is standing at
 * the Windows panel tapping "approve" while looking at the phone, so a long gap before the
 * phone reacts reads as a broken pairing rather than as patience.
 */
export async function runPairing(options: PairingOptions): Promise<StoredSession> {
  const {
    api,
    clock,
    deviceName,
    platform,
    signal,
    onPhase,
    timeoutMs = PAIRING_TIMEOUT_MS,
    backoff = PAIRING_POLL_BACKOFF,
    sleep = systemSleep,
    random = Math.random,
  } = options;

  const payload = typeof options.qr === 'string' ? parseQrPayload(options.qr) : options.qr;
  /**
   * The host is only checked when there is no explicit origin to use instead.
   *
   * `isPairableHost` refuses a bare IP, and correctly so for the field it was written for:
   * `host` is a MagicDNS name, and a name that cannot hold a public certificate cannot be
   * reached over the tailnet. But a local-network payload puts `192.168.8.92` in `host` and the
   * address it actually wants in `url` — so this check, applied unconditionally, rejected every
   * pairing link a phone's camera ever opened. `parseQrPayload` already had the conditional
   * form; this one did not, which is why scanning appeared to work and then sent the user back
   * to typing the four characters by hand.
   */
  if (payload.url === undefined && !isPairableHost(payload.host)) {
    throw invalid('this pairing code points at an address LocalCast cannot use', {
      fields: ['host'],
    });
  }

  throwIfCancelled(signal);
  onPhase?.('claiming');
  const claim = await api.claimPairing(
    { code: payload.code, secret: payload.secret, deviceName, platform },
    { signal },
  );

  const startedAt = clock.now();
  onPhase?.('waiting-for-approval');

  for (let attempt = 0; ; attempt += 1) {
    throwIfCancelled(signal);
    const status = await api.pairingStatus(claim.deviceId, claim.claimTicket, { signal });

    if (status.status === 'approved') {
      // Carried into the session so a reconnect uses the same origin and pins the same
      // certificate. Recomputing either later would mean guessing, and the wrong guess is
      // either a connection that fails or one that trusts something it should not.
      const endpoint = endpointFromQr(payload);
      return {
        deviceId: status.device.id,
        accessToken: status.accessToken,
        refreshToken: status.refreshToken,
        expiresAt: status.expiresAt,
        host: payload.host,
        ...(payload.url === undefined ? {} : { baseUrl: endpoint.baseUrl }),
        ...(endpoint.pinnedFingerprint === null
          ? {}
          : { fingerprint: endpoint.pinnedFingerprint }),
        davPassword: status.davPassword,
      };
    }
    if (status.status === 'rejected') {
      throw new LocalCastError(
        ErrorCode.PAIRING_INVALID,
        'the operator did not approve this device',
      );
    }

    if (clock.now() - startedAt >= timeoutMs) {
      throw new LocalCastError(
        ErrorCode.PAIRING_EXPIRED,
        'the pairing code expired before it was approved',
      );
    }
    await sleep(backoffDelay(attempt, backoff, random), signal);
  }
}
