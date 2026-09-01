import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowBackIcon,
  Badge,
  Button,
  CopyIcon,
  EmptyState,
  ExternalIcon,
  Panel,
  Select,
  useFormat,
  useT,
} from '@localcast/ui-kit';
import type { Entry, Folder } from '@localcast/contract';
import type { ServerSummary } from '../../shared/ipc.js';
import { useBridge } from '../bridge.js';
import { TransportBar } from '../components/TransportBar.js';
import { S } from '../strings.js';
import styles from './PlayerScreen.module.css';

/**
 * Screen 07 — the desktop player.
 *
 * Electron's Chromium opens more than Safari does, but it still cannot open every MKV, and
 * phase 1 ships no ffmpeg to transcode one. The server has already decided this per file and
 * says so in `entry.browserPlayable`; this screen honours that answer rather than attaching a
 * source and letting the user watch a black rectangle for ten seconds before concluding the
 * app is broken.
 *
 * The handoff is a WebDAV URL with the device's own DAV password embedded, because VLC and
 * Infuse are handed a URL and nothing else — that is exactly why the WebDAV mount has a
 * password of its own instead of a bearer token.
 */

export interface PlayerScreenProps {
  server: ServerSummary;
  entry: Entry;
  folder: Folder;
  onBack: () => void;
}

type PlaybackState = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

const STATUS_TEXT: Record<PlaybackState, string> = {
  idle: S.playerStatusIdle,
  loading: S.playerStatusLoading,
  buffering: S.playerStatusBuffering,
  playing: S.playerStatusPlaying,
  paused: S.playerStatusPaused,
  ended: S.playerStatusEnded,
  error: S.playerStatusError,
};

interface TrackOption {
  value: string;
  label: string;
}

export function PlayerScreen({ server, entry, folder, onBack }: PlayerScreenProps) {
  const api = useBridge();
  const t = useT();
  const format = useFormat();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [davUrl, setDavUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<PlaybackState>('idle');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [textTracks, setTextTracks] = useState<TrackOption[]>([]);
  const [activeText, setActiveText] = useState('');
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [activeAudio, setActiveAudio] = useState('');

  // The engine's own verdict, which may differ from the server's: a file the index called
  // playable can still fail on a codec this build was compiled without.
  const [engineRefused, setEngineRefused] = useState(false);
  const handoff = !entry.browserPlayable || engineRefused;

  // The DAV URL is fetched for every file, playable or not — the handoff button has to be
  // ready the moment the engine gives up, and it is also the answer for a file that plays
  // but that the user would rather watch elsewhere.
  useEffect(() => {
    let live = true;
    void api.library
      .davUrl(server.id, folder.id, entry.path)
      .then((url) => {
        if (live) setDavUrl(url);
      })
      .catch(() => {
        if (live) setDavUrl(null);
      });
    return () => {
      live = false;
    };
  }, [api, server.id, folder.id, entry.path]);

  useEffect(() => {
    if (!entry.browserPlayable) return;
    let live = true;
    setState('loading');
    void api.library
      .mediaUrl(server.id, entry.id)
      .then((url) => {
        if (live) setMediaUrl(url);
      })
      .catch(() => {
        if (live) {
          setEngineRefused(true);
          setState('error');
        }
      });
    return () => {
      live = false;
    };
  }, [api, server.id, entry.id, entry.browserPlayable]);

  const readTracks = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;

    const text: TrackOption[] = [];
    for (let i = 0; i < video.textTracks.length; i += 1) {
      const track = video.textTracks[i];
      if (track === undefined) continue;
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      text.push({ value: String(i), label: track.label || track.language || `#${i + 1}` });
    }
    setTextTracks(text);

    // `audioTracks` is not in the DOM lib and Chromium only exposes it behind a flag, so it
    // is probed rather than assumed. When it is absent the selector says so plainly instead
    // of offering a control that silently does nothing — and the native handoff below is the
    // real answer for a file with a second audio track.
    const list = (video as unknown as { audioTracks?: AudioTrackListLike }).audioTracks;
    if (list === undefined) {
      setAudioTracks([]);
      return;
    }
    const audio: TrackOption[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const track = list[i];
      if (track === undefined) continue;
      audio.push({ value: String(i), label: track.label || track.language || `#${i + 1}` });
      if (track.enabled) setActiveAudio(String(i));
    }
    setAudioTracks(audio);
  }, []);

  const selectTextTrack = (value: string) => {
    setActiveText(value);
    const video = videoRef.current;
    if (video === null) return;
    for (let i = 0; i < video.textTracks.length; i += 1) {
      const track = video.textTracks[i];
      if (track === undefined) continue;
      track.mode = String(i) === value ? 'showing' : 'disabled';
    }
  };

  const selectAudioTrack = (value: string) => {
    setActiveAudio(value);
    const video = videoRef.current;
    if (video === null) return;
    const list = (video as unknown as { audioTracks?: AudioTrackListLike }).audioTracks;
    if (list === undefined) return;
    for (let i = 0; i < list.length; i += 1) {
      const track = list[i];
      if (track !== undefined) track.enabled = String(i) === value;
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused) void video.play().catch(() => setEngineRefused(true));
    else video.pause();
  };

  const openExternally = async () => {
    if (davUrl === null) return;
    await api.app.openExternal(davUrl);
  };

  const copyLink = async () => {
    if (davUrl === null) return;
    await navigator.clipboard.writeText(davUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <Button variant="ghost" size="sm" startIcon={<ArrowBackIcon size={16} />} onClick={onBack}>
          {S.playerBack}
        </Button>
        <span className={styles.title} title={entry.name}>
          {entry.name}
        </span>
        {entry.browserPlayable ? null : (
          <Badge tone="warning" square>
            {t('files.notPlayable')}
          </Badge>
        )}
      </header>

      <div className={styles.stage}>
        {handoff ? (
          <div className={styles.handoff} data-testid="external-handoff">
            <EmptyState
              icon={<ExternalIcon size={24} />}
              title={S.playerHandoffTitle}
              description={
                engineRefused && entry.browserPlayable
                  ? S.playerBrowserPlayableButFailed
                  : S.playerHandoffBody
              }
              actions={
                <>
                  <Button
                    variant="primary"
                    disabled={davUrl === null}
                    startIcon={<ExternalIcon size={16} />}
                    onClick={() => void openExternally()}
                  >
                    {t('files.openInNativePlayer')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={davUrl === null}
                    startIcon={<CopyIcon size={16} />}
                    onClick={() => void copyLink()}
                  >
                    {copied ? t('common.copied') : S.playerCopyLink}
                  </Button>
                </>
              }
            />
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              className={styles.video}
              data-testid="player-video"
              src={mediaUrl ?? undefined}
              controls={false}
              preload="metadata"
              // AirPlay on the same attribute the PWA uses; harmless where unsupported.
              x-webkit-airplay="allow"
              onLoadedMetadata={(event) => {
                setDuration(event.currentTarget.duration);
                setState(event.currentTarget.paused ? 'paused' : 'playing');
                readTracks();
              }}
              onTimeUpdate={(event) => {
                const video = event.currentTarget;
                setCurrentTime(video.currentTime);
                const ranges = video.buffered;
                setBuffered(ranges.length === 0 ? 0 : ranges.end(ranges.length - 1));
              }}
              onPlaying={() => setState('playing')}
              onPause={() => setState('paused')}
              onWaiting={() => setState('buffering')}
              onEnded={() => setState('ended')}
              onVolumeChange={(event) => {
                setVolume(event.currentTarget.volume);
                setMuted(event.currentTarget.muted);
              }}
              onError={() => {
                // The index said this file was playable and the engine disagreed. Say so, and
                // offer the handoff — that is a more useful answer than "playback error".
                setEngineRefused(true);
                setState('error');
              }}
            />
            <TransportBar
              playing={state === 'playing'}
              currentTime={currentTime}
              duration={duration}
              buffered={buffered}
              volume={volume}
              muted={muted}
              disabled={mediaUrl === null}
              onTogglePlay={togglePlay}
              onSeek={(seconds) => {
                const video = videoRef.current;
                if (video !== null) video.currentTime = seconds;
                setCurrentTime(seconds);
              }}
              onVolume={(value) => {
                const video = videoRef.current;
                if (video === null) return;
                video.volume = value;
                video.muted = value === 0;
              }}
              onToggleMute={() => {
                const video = videoRef.current;
                if (video !== null) video.muted = !video.muted;
              }}
            />
          </>
        )}
      </div>

      <Panel title={S.playerStatusHeading} className={styles.readout}>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>{S.playerStatusHeading}</dt>
            <dd>{STATUS_TEXT[state]}</dd>
          </div>
          <div className={styles.fact}>
            <dt>{t('files.size')}</dt>
            <dd className={styles.latin}>{format.bytes(entry.size ?? 0)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>{S.playerSeek}</dt>
            <dd className={styles.latin}>
              {format.duration(currentTime)} / {format.duration(duration)}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>{t('files.kind')}</dt>
            <dd>{entry.ext ?? t('common.unknown')}</dd>
          </div>
        </dl>

        <div className={styles.tracks}>
          <Select
            label={S.playerSubtitles}
            selectSize="sm"
            options={[{ value: '', label: S.playerNoSubtitles }, ...textTracks]}
            value={activeText}
            disabled={handoff}
            onChange={(event) => selectTextTrack(event.target.value)}
          />
          <Select
            label={S.playerAudioTrack}
            selectSize="sm"
            options={audioTracks}
            value={activeAudio}
            placeholder={audioTracks.length === 0 ? S.playerTracksUnavailable : undefined}
            disabled={handoff || audioTracks.length < 2}
            hint={audioTracks.length < 2 ? S.playerHandoffBody : undefined}
            onChange={(event) => selectAudioTrack(event.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={davUrl === null}
            startIcon={<ExternalIcon size={16} />}
            onClick={() => void openExternally()}
          >
            {t('files.openInNativePlayer')}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/**
 * The shape of `HTMLMediaElement.audioTracks` where it exists.
 *
 * Declared locally rather than added to the global `lib.dom` types: it is not in the standard
 * DOM lib, Chromium hides it behind a flag, and widening the global would tell every other
 * file in this app that the property is always there.
 */
interface AudioTrackListLike {
  readonly length: number;
  [index: number]: { id: string; label: string; language: string; enabled: boolean } | undefined;
}
