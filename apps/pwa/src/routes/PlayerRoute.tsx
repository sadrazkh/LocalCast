import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertIcon,
  Button,
  CopyIcon,
  ExternalIcon,
  Select,
  Spinner,
  formatBytes,
  useT,
} from '@localcast/ui-kit';
import { ErrorCode, entrySchema } from '@localcast/contract';
import type { Entry } from '@localcast/contract';
import { LocalCastError } from '@localcast/client-core';
import { useClient, useClientContext } from '../client/ClientProvider.js';
import { useAsync } from '../hooks/useAsync.js';
import { useAppT } from '../i18n/messages.js';
import { buildHref } from '../router.js';
import { Screen } from '../components/Screen.js';
import { getProgress, setProgress } from '../storage/progress.js';
import styles from './PlayerRoute.module.css';

/**
 * Screen 10 — the player.
 *
 * The `<video>` element streams straight from `/api/v1/files/:id/content`, with no
 * `Authorization` header on the element and none possible: the service worker attaches the
 * bearer to that request on its way out. That is the whole reason `contentUrl()` returns a
 * bare URL.
 *
 * The branch that matters most is the one where nothing plays. Phase 1 ships no ffmpeg, so an
 * MKV container or an AC3 track is not a degraded experience on iOS — it is silence and a
 * black rectangle. `entry.browserPlayable` says which case this is *before* a `<video>` is
 * ever mounted, and when it is false the screen leads with the WebDAV handoff that VLC and
 * Infuse open natively.
 */
export interface PlayerRouteProps {
  fileId: string;
}

export function PlayerRoute({ fileId }: PlayerRouteProps) {
  const t = useT();
  const at = useAppT();
  const client = useClient();

  const meta = useAsync(
    async (signal) => {
      const fetcher = () => client.api.fileMeta(fileId, { signal });
      if (client.cache === null) return { value: await fetcher(), stale: false };
      return client.cache.withCache('file-meta', fileId, entrySchema, fetcher);
    },
    [client, fileId],
  );

  if (meta.loading && meta.value === null) {
    return (
      <Screen title={t('common.loading')} back={buildHref('/library')}>
        <Spinner labelled />
      </Screen>
    );
  }

  if (meta.value === null) {
    const revoked =
      meta.error instanceof LocalCastError &&
      (meta.error.code === ErrorCode.DEVICE_REVOKED || meta.error.code === ErrorCode.TOKEN_REVOKED);
    return (
      <Screen title={at('player.failed')} back={buildHref('/library')}>
        <p className={styles.error} role="alert">
          {revoked ? t('offline.accessClosed') : messageOf(meta.error)}
        </p>
        <Button variant="secondary" onClick={meta.reload}>
          {t('common.retry')}
        </Button>
      </Screen>
    );
  }

  return <Player entry={meta.value} />;
}

function Player({ entry }: { entry: Entry }) {
  const t = useT();
  const at = useAppT();
  const { client, session } = useClientContext();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [quality, setQuality] = useState<string | null>(null);
  const [textTracks, setTextTracks] = useState<{ value: string; label: string }[]>([]);
  const [activeText, setActiveText] = useState('off');
  const [audioTracks, setAudioTracks] = useState<{ value: string; label: string }[]>([]);
  const [activeAudio, setActiveAudio] = useState('');
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const contentUrl = client.api.contentUrl(entry.id);
  const davUrl =
    session === null
      ? client.api.davUrl(entry.folderId, entry.path)
      : client.api.davUrl(entry.folderId, entry.path, {
          credentials: { deviceId: session.deviceId, davPassword: session.davPassword },
        });

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;

    // The quality readout is measured, not claimed. Nothing in the contract says how tall a
    // file is, and the index deliberately does not probe — so the only honest source is the
    // decoder, once it has actually opened the stream.
    setQuality(video.videoHeight > 0 ? `${video.videoWidth}×${video.videoHeight}` : null);

    const tracks: { value: string; label: string }[] = [];
    for (let index = 0; index < video.textTracks.length; index += 1) {
      const track = video.textTracks[index];
      if (track === undefined) continue;
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      tracks.push({ value: String(index), label: track.label || track.language || String(index + 1) });
    }
    setTextTracks(tracks);

    const audio = video.audioTracks;
    if (audio !== undefined) {
      const list: { value: string; label: string }[] = [];
      for (let index = 0; index < audio.length; index += 1) {
        const track = audio[index];
        if (track === undefined) continue;
        list.push({ value: String(index), label: track.label || track.language || String(index + 1) });
        if (track.enabled) setActiveAudio(String(index));
      }
      setAudioTracks(list);
    }

    // Resume where this device left off. Per-device by construction: the API has no notion of
    // watch position, so pretending it is shared would be a lie about the other devices.
    const saved = getProgress(entry.id);
    if (saved !== null && saved.seconds > 0 && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(saved.seconds, video.duration - 1);
    }
  }, [entry.id]);

  const selectTextTrack = useCallback((value: string) => {
    setActiveText(value);
    const video = videoRef.current;
    if (video === null) return;
    for (let index = 0; index < video.textTracks.length; index += 1) {
      const track = video.textTracks[index];
      if (track === undefined) continue;
      track.mode = String(index) === value ? 'showing' : 'disabled';
    }
  }, []);

  const selectAudioTrack = useCallback((value: string) => {
    setActiveAudio(value);
    const audio = videoRef.current?.audioTracks;
    if (audio === undefined) return;
    for (let index = 0; index < audio.length; index += 1) {
      const track = audio[index];
      if (track === undefined) continue;
      // Exactly one enabled: enabling a second gives Safari two audio streams to mix, which
      // it does, audibly.
      track.enabled = String(index) === value;
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    let last = 0;
    const onTimeUpdate = () => {
      // Once a second is plenty; `timeupdate` fires four times that and this writes to
      // `localStorage` synchronously.
      const now = Date.now();
      if (now - last < 1_000) return;
      last = now;
      setProgress(entry.id, video.currentTime, Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      setProgress(entry.id, video.currentTime, Number.isFinite(video.duration) ? video.duration : 0);
    };
  }, [entry.id]);

  async function copyDav(): Promise<void> {
    try {
      await navigator.clipboard.writeText(davUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  const handoff = (
    <div className={styles.handoff}>
      <div className={styles.handoffActions}>
        <Button
          variant={entry.browserPlayable ? 'secondary' : 'primary'}
          startIcon={<ExternalIcon />}
          onClick={() => {
            window.location.href = davUrl;
          }}
          data-testid="native-handoff"
        >
          {t('files.openInNativePlayer')}
        </Button>
        <Button variant="ghost" startIcon={<CopyIcon />} onClick={() => void copyDav()}>
          {copied ? t('common.copied') : at('player.nativeCopy')}
        </Button>
      </div>
      <p className={styles.note}>{at('player.nativeHint')}</p>
    </div>
  );

  return (
    <Screen title={entry.name} back={buildHref(`/library/${encodeURIComponent(entry.folderId)}`)} flush>
      {entry.browserPlayable ? (
        <div className={styles.stage}>
          <video
            ref={videoRef}
            className={styles.video}
            src={contentUrl}
            controls
            playsInline
            preload="metadata"
            // The AirPlay affordance. Safari renders the picker in its own controls when this
            // attribute is present; there is no JavaScript API that substitutes for it.
            x-webkit-airplay="allow"
            onLoadedMetadata={onLoadedMetadata}
            onError={() => setPlaybackError(at('player.failed'))}
            data-testid="player-video"
          />
        </div>
      ) : (
        <div className={styles.panel}>
          <div className={styles.unplayable} data-testid="unplayable">
            <AlertIcon size={28} className={styles.unplayableIcon} />
            <p className={styles.unplayableTitle}>{t('files.notPlayable')}</p>
            {/* The handoff, not the explanation, is the primary action here. */}
            {handoff}
          </div>
        </div>
      )}

      <div className={styles.panel}>
        <h2 className={styles.name}>{entry.name}</h2>

        <div className={styles.facts}>
          <span className={styles.fact}>
            <span>{t('files.size')}</span>
            <span className={styles.factValue}>{entry.size === null ? '—' : formatBytes(entry.size)}</span>
          </span>
          <span className={styles.fact}>
            <span>{at('player.quality')}</span>
            <span className={styles.factValue} data-testid="quality-readout">
              {quality ?? at('player.qualityUnknown')}
            </span>
          </span>
          {entry.ext === null ? null : (
            <span className={styles.fact}>
              <span>{t('files.kind')}</span>
              <span className={styles.factValue}>{entry.ext}</span>
            </span>
          )}
        </div>

        {entry.browserPlayable && (textTracks.length > 0 || audioTracks.length > 0) ? (
          <div className={styles.selectors}>
            {textTracks.length === 0 ? null : (
              <Select
                label={at('player.subtitles')}
                selectSize="sm"
                options={[{ value: 'off', label: at('player.subtitlesOff') }, ...textTracks]}
                value={activeText}
                onChange={(event) => selectTextTrack(event.currentTarget.value)}
              />
            )}
            {audioTracks.length === 0 ? null : (
              <Select
                label={at('player.audioTrack')}
                selectSize="sm"
                options={audioTracks}
                value={activeAudio}
                onChange={(event) => selectAudioTrack(event.currentTarget.value)}
              />
            )}
          </div>
        ) : null}

        {playbackError === null ? null : (
          <p className={styles.error} role="alert">
            {playbackError}
          </p>
        )}

        {entry.browserPlayable ? handoff : null}
        <p className={styles.note}>{at('player.noPosterExplained')}</p>
      </div>
    </Screen>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
