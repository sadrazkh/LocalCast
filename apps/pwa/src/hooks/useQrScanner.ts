import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `getUserMedia` in an iOS standalone PWA.
 *
 * This is the fragile part of the pairing screen and it is fragile for reasons outside this
 * app's control: the camera is refused outright on a non-secure origin, refused permanently
 * once the user has said no (with no way to re-prompt from script), and has historically
 * failed in a home-screen web app while working in Safari on the same device. Every one of
 * those ends in the same place here — a status the UI can name, and the 4-character code as a
 * path that always works. There is no state in which the user is left looking at a dead
 * viewfinder.
 */
export type CameraStatus =
  | 'idle'
  | 'starting'
  | 'scanning'
  /** The user said no, or a policy says no. Nothing script can do re-opens this. */
  | 'denied'
  /** No camera, no `mediaDevices`, or an insecure origin. */
  | 'unavailable'
  | 'error';

export type QrDecoder = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

export interface QrScannerOptions {
  /** Off while the manual-code sheet is open, so the camera light is not on for nothing. */
  enabled: boolean;
  onResult: (text: string) => void;
  /** Injected in tests; production uses `navigator.mediaDevices.getUserMedia`. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Injected in tests; production passes `jsQR`. */
  decode?: QrDecoder;
  /** How often a frame is sampled. 200 ms is well inside what a hand-held code needs. */
  intervalMs?: number;
}

export interface QrScanner {
  status: CameraStatus;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Try the camera again — useful after a permission was granted in Settings. */
  retry: () => void;
}

function classify(error: unknown): CameraStatus {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'denied';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'unavailable';
  }
  return 'error';
}

export function useQrScanner(options: QrScannerOptions): QrScanner {
  const { enabled, intervalMs = 200 } = options;
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [attempt, setAttempt] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onResultRef = useRef(options.onResult);
  onResultRef.current = options.onResult;
  const decodeRef = useRef(options.decode);
  decodeRef.current = options.decode;
  const getUserMediaRef = useRef(options.getUserMedia);
  getUserMediaRef.current = options.getUserMedia;

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }

    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let live = true;

    const request =
      getUserMediaRef.current ??
      (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined
        ? (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints)
        : null);

    if (request === null) {
      setStatus('unavailable');
      return;
    }

    setStatus('starting');

    void (async () => {
      try {
        // `environment` rather than `exact: environment`: an exact constraint throws
        // `OverconstrainedError` on a device with only a front camera, and scanning a code
        // held up to the front camera is worse than not scanning but better than an error.
        stream = await request({ video: { facingMode: 'environment' }, audio: false });
        if (!live) {
          stopStream(stream);
          return;
        }

        const video = videoRef.current;
        if (video !== null) {
          video.srcObject = stream;
          // Both are required on iOS: without `playsInline` the video takes over the screen
          // in the native player, and without `muted` autoplay is refused.
          video.muted = true;
          video.playsInline = true;
          await video.play().catch(() => undefined);
        }
        setStatus('scanning');

        timer = setInterval(() => {
          const decode = decodeRef.current;
          if (decode === undefined) return;
          const text = sampleFrame(videoRef.current, canvasRef.current, decode);
          if (text === null) return;
          onResultRef.current(text);
        }, intervalMs);
      } catch (error) {
        if (!live) return;
        setStatus(classify(error));
      }
    })();

    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
      stopStream(stream);
      const video = videoRef.current;
      if (video !== null) video.srcObject = null;
    };
  }, [enabled, intervalMs, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { status, videoRef, canvasRef, retry };
}

function stopStream(stream: MediaStream | null): void {
  // Every track, not just the first: a stream left running keeps the camera indicator lit
  // long after the pairing screen has gone, which reads as the app spying.
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Draw the current frame into the offscreen canvas and hand its pixels to the decoder.
 *
 * The canvas is sized to the video's intrinsic resolution rather than the viewfinder's CSS
 * box: the frame is what the decoder needs, and scaling it down to the on-screen size loses
 * exactly the fine modules that make a dense QR readable.
 */
export function sampleFrame(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null,
  decode: QrDecoder,
): string | null {
  if (video === null || canvas === null) return null;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) return null;

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;
  context.drawImage(video, 0, 0, width, height);

  let image: ImageData;
  try {
    image = context.getImageData(0, 0, width, height);
  } catch {
    // A tainted canvas. Cannot happen with a `getUserMedia` stream, but a throw here would
    // kill the interval and freeze the scanner with no indication of why.
    return null;
  }

  const result = decode(image.data, width, height);
  return result === null || result.data.length === 0 ? null : result.data;
}
