import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, QrFrame, Spinner, useT } from '@localcast/ui-kit';
import { parseQrPayload, systemClock } from '@localcast/client-core';
import type { QrDecoder } from '../hooks/useQrScanner.js';
import { useQrScanner } from '../hooks/useQrScanner.js';
import { useClient } from '../client/ClientProvider.js';
import { useAppT } from '../i18n/messages.js';
import { runManualPairing } from '../pairing/manualPairing.js';
import { navigate } from '../router.js';
import { Screen } from '../components/Screen.js';
import styles from './PairRoute.module.css';

/**
 * Screen 08 — pairing.
 *
 * Two ways in, and the second one is not a consolation prize. `getUserMedia` in an installed
 * iOS web app has failed in enough OS versions that the 4-character code has to be a first
 * class path: reachable in one tap from the viewfinder, and the *only* thing on screen the
 * moment the camera is refused or absent. There is no state in which this screen shows a dead
 * black rectangle.
 */

export type PairPhase = 'scanning' | 'manual' | 'claiming' | 'waiting' | 'done';

export interface PairRouteProps {
  /** Injected in tests; production passes `jsQR` through `App`. */
  decode?: QrDecoder;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** The name this device registers under. Editable before the first claim. */
  defaultDeviceName?: string;
  /**
   * `CODE.SECRET`, lifted out of the fragment of a scanned pairing link.
   *
   * Present when the phone's own camera opened the QR — which is the ordinary path now, and
   * the one that needs no camera permission inside the app. The screen claims immediately
   * rather than showing a viewfinder for a code it already has.
   */
  fromLink?: string;
}

export function PairRoute({ decode, getUserMedia, defaultDeviceName, fromLink }: PairRouteProps) {
  const t = useT();
  const at = useAppT();
  const client = useClient();

  const [phase, setPhase] = useState<PairPhase>('scanning');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState(defaultDeviceName ?? at('pair.deviceNameDefault'));
  // A QR sits in front of the camera for several frames, so the decoder fires repeatedly.
  // Without this guard the second frame starts a second claim against a single-use code and
  // the first one's approval is thrown away.
  const busy = useRef(false);

  const onScan = useCallback(
    (text: string) => {
      if (busy.current) return;
      let payload;
      try {
        payload = parseQrPayload(text);
      } catch {
        // A code from something else entirely — a wifi QR, a payment QR. Say so and keep the
        // camera running rather than tearing the screen down.
        setError(at('pair.invalid'));
        return;
      }
      busy.current = true;
      setError(null);
      setPhase('claiming');
      void client
        .pair({ qr: payload, deviceName, platform: 'ios-pwa' })
        .then(() => {
          setPhase('done');
          navigate('/library', { replace: true });
        })
        .catch((cause: unknown) => {
          busy.current = false;
          setPhase('scanning');
          setError(messageOf(cause));
        });
    },
    [at, client, deviceName],
  );

  /**
   * Claim straight away when the link carried the code.
   *
   * `onScan` takes the raw scanned text, and a pairing link is exactly that text — so this
   * reuses the same path rather than a parallel one, and a bug in either is a bug in both.
   * It runs once: `busy` guards a re-render, and the effect has no reason to fire twice.
   */
  useEffect(() => {
    if (fromLink === undefined || fromLink.length === 0) return;
    onScan(`${window.location.origin}/#p=${fromLink}`);
  }, [fromLink, onScan]);

  const scanner = useQrScanner({
    enabled: phase === 'scanning',
    onResult: onScan,
    ...(decode === undefined ? {} : { decode }),
    ...(getUserMedia === undefined ? {} : { getUserMedia }),
  });

  // A camera that cannot be used is not an error state to sit in — it is the reason the typed
  // code exists. Fall through to it without making the user find the link.
  const cameraBlocked = scanner.status === 'denied' || scanner.status === 'unavailable' || scanner.status === 'error';
  const showManual = phase === 'manual' || (phase === 'scanning' && cameraBlocked);

  async function submitManual(): Promise<void> {
    setError(null);
    setPhase('claiming');
    try {
      const session = await runManualPairing({
        api: client.api,
        clock: systemClock,
        code,
        deviceName,
        platform: 'ios-pwa',
        host: window.location.hostname,
        onPhase: (next) => setPhase(next === 'claiming' ? 'claiming' : 'waiting'),
      });
      await client.session.adopt(session);
      setPhase('done');
      navigate('/library', { replace: true });
    } catch (cause: unknown) {
      setPhase('manual');
      setError(messageOf(cause));
    }
  }

  if (phase === 'claiming' || phase === 'waiting' || phase === 'done') {
    return (
      <Screen title={at('pair.title')}>
        <div className={styles.wrap}>
          <Spinner size="lg" labelled />
          <p className={styles.phase} data-testid="pair-phase">
            {phase === 'claiming' ? at('pair.claiming') : phase === 'waiting' ? at('pair.waiting') : at('pair.paired')}
          </p>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title={at('pair.title')}>
      <div className={styles.wrap}>
        {showManual ? (
          <div className={styles.manual}>
            <Input
              label={at('pair.manualTitle')}
              hint={at('pair.manualHint')}
              latin
              maxLength={4}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              fieldClassName={styles.codeInput}
              value={code}
              onChange={(event) => setCode(event.currentTarget.value.toUpperCase().slice(0, 4))}
              data-testid="manual-code"
            />
            <Input
              label={at('servers.deviceName')}
              value={deviceName}
              onChange={(event) => setDeviceName(event.currentTarget.value)}
            />
            {error === null ? null : (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <Button
              variant="primary"
              fullWidth
              disabled={code.trim().length !== 4 || deviceName.trim().length === 0}
              onClick={() => void submitManual()}
            >
              {t('common.confirm')}
            </Button>
            {cameraBlocked ? (
              <p className={styles.hint} data-testid="camera-blocked">
                {scanner.status === 'denied' ? t('pairing.cameraDenied') : at('pair.cameraUnavailable')}
              </p>
            ) : (
              <Button
                variant="ghost"
                fullWidth
                onClick={() => {
                  setError(null);
                  setPhase('scanning');
                }}
              >
                {at('pair.useCamera')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <QrFrame
              prompt={t('pairing.scanPrompt')}
              onUseCode={() => {
                setError(null);
                setPhase('manual');
              }}
              useCodeLabel={t('pairing.codeFallbackAction')}
            >
              <video
                ref={scanner.videoRef}
                className={styles.viewfinder}
                aria-label={t('pairing.viewfinderLabel')}
                playsInline
                muted
              />
              {/* Frames are sampled through this canvas; it is never displayed. */}
              <canvas ref={scanner.canvasRef} className={styles.hidden} aria-hidden="true" />
            </QrFrame>
            <p className={styles.hint}>{at('pair.cameraHint')}</p>
            {error === null ? null : (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Screen>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
