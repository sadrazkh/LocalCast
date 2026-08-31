import { ErrorCode, qrPayloadSchema } from '@localcast/contract';
import type { Platform, QrPayload } from '@localcast/contract';
import type { ApiClient } from './api.js';
import type { BackoffOptions, Sleep } from './backoff.js';
import { backoffDelay, PAIRING_POLL_BACKOFF, systemSleep } from './backoff.js';
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
 * Validate a scanned QR string. Anything malformed comes out as a typed `pairing_invalid`,
 * never as a `SyntaxError` from `JSON.parse` reaching a camera view.
 */
export function parseQrPayload(raw: string): QrPayload {
  const text = raw.trim();
  if (text.length === 0) throw invalid('the scanned code was empty');

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

  if (!isPairableHost(result.data.host)) {
    throw invalid('this pairing code points at an address LocalCast cannot use', {
      fields: ['host'],
    });
  }
  return result.data;
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
  if (!isPairableHost(payload.host)) {
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
      return {
        deviceId: status.device.id,
        accessToken: status.accessToken,
        refreshToken: status.refreshToken,
        expiresAt: status.expiresAt,
        host: payload.host,
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
