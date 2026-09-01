import { ErrorCode } from '@localcast/contract';
import type { Platform } from '@localcast/contract';
import {
  LocalCastError,
  PAIRING_POLL_BACKOFF,
  PAIRING_TIMEOUT_MS,
  backoffDelay,
  systemSleep,
} from '@localcast/client-core';
import type { ApiClient, Clock, Sleep, StoredSession } from '@localcast/client-core';

/**
 * Pairing by typed 4-character code.
 *
 * `client-core`'s `runPairing` is the path for a scanned QR and is used unchanged for it.
 * It cannot serve this path, and the reason is in the contract rather than in an oversight:
 * `runPairing` takes a `QrPayload`, whose `secret` is a mandatory 32-byte value, while
 * `pairClaimRequestSchema.secret` is explicitly *optional* — "omitted when pairing by typed
 * code; then only the rate-limited code guards entry". There is no honest way to satisfy the
 * QR schema from four characters, so this function claims and polls with the same shape and
 * the same backoff, minus the secret.
 *
 * Everything else still comes from the package: the poll ladder, the timeout, the error
 * codes, and — through `SessionManager.adopt` at the call site — the token storage.
 */
export interface ManualPairingOptions {
  api: ApiClient;
  clock: Clock;
  /** Four characters from the Windows panel's «پیرینگ QR» screen. */
  code: string;
  deviceName: string;
  platform: Platform;
  /**
   * The host to record in the session.
   *
   * The PWA is served by the LocalCast server itself, so the origin it was loaded from *is*
   * the server — there is nothing to ask the user for. This is why the manual path needs no
   * address field: a typed hostname would only be a second chance to get it wrong.
   */
  host: string;
  signal?: AbortSignal;
  onPhase?: (phase: 'claiming' | 'waiting-for-approval') => void;
  timeoutMs?: number;
  sleep?: Sleep;
  random?: () => number;
}

export async function runManualPairing(options: ManualPairingOptions): Promise<StoredSession> {
  const {
    api,
    clock,
    deviceName,
    platform,
    host,
    signal,
    onPhase,
    timeoutMs = PAIRING_TIMEOUT_MS,
    sleep = systemSleep,
    random = Math.random,
  } = options;

  // The panel's alphabet is unambiguous and upper case; a phone keyboard is neither.
  const code = options.code.trim().toUpperCase();
  if (code.length !== 4) {
    throw new LocalCastError(ErrorCode.PAIRING_INVALID, 'a pairing code is four characters');
  }

  onPhase?.('claiming');
  const claim = await api.claimPairing({ code, deviceName, platform }, { signal });

  const startedAt = clock.now();
  onPhase?.('waiting-for-approval');

  for (let attempt = 0; ; attempt += 1) {
    const status = await api.pairingStatus(claim.deviceId, claim.claimTicket, { signal });

    if (status.status === 'approved') {
      return {
        deviceId: status.device.id,
        accessToken: status.accessToken,
        refreshToken: status.refreshToken,
        expiresAt: status.expiresAt,
        host,
        davPassword: status.davPassword,
      };
    }
    if (status.status === 'rejected') {
      throw new LocalCastError(ErrorCode.PAIRING_INVALID, 'the operator did not approve this device');
    }
    if (clock.now() - startedAt >= timeoutMs) {
      throw new LocalCastError(
        ErrorCode.PAIRING_EXPIRED,
        'the pairing code expired before it was approved',
      );
    }
    await sleep(backoffDelay(attempt, PAIRING_POLL_BACKOFF, random), signal);
  }
}
