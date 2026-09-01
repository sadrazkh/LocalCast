import { PauseIcon, PlayIcon, useFormat } from '@localcast/ui-kit';
import { VolumeIcon, VolumeOffIcon } from './icons.js';
import { S } from '../strings.js';
import styles from './TransportBar.module.css';

/**
 * A real transport bar: a scrubber that seeks, a clock, and a volume control.
 *
 * The scrubber is an `<input type="range">` rather than a styled div, because a video
 * timeline that cannot be driven with the arrow keys is not a control. Its `aria-valuetext`
 * carries the position as a clock time — `0.42` announced as a fraction tells a screen-reader
 * user nothing about where they are in a film.
 *
 * The timeline does not mirror under `dir="rtl"`. Media controls and progress along a
 * timeline are physical, not linguistic: a film still runs from its beginning to its end in
 * the same direction in Persian.
 */

export interface TransportBarProps {
  playing: boolean;
  currentTime: number;
  duration: number;
  /** Seconds buffered ahead of the playhead; drawn as the lighter fill behind the scrubber. */
  buffered: number;
  volume: number;
  muted: boolean;
  disabled?: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (value: number) => void;
  onToggleMute: () => void;
}

export function TransportBar({
  playing,
  currentTime,
  duration,
  buffered,
  volume,
  muted,
  disabled = false,
  onTogglePlay,
  onSeek,
  onVolume,
  onToggleMute,
}: TransportBarProps) {
  const format = useFormat();
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const played = max === 0 ? 0 : Math.min(1, currentTime / max);
  const ahead = max === 0 ? 0 : Math.min(1, buffered / max);

  return (
    <div className={styles.bar}>
      <button
        type="button"
        className={styles.play}
        onClick={onTogglePlay}
        disabled={disabled}
        aria-label={playing ? S.playerPause : S.playerPlay}
      >
        {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
      </button>

      <div className={styles.scrubber}>
        <div
          className={styles.track}
          style={{
            // Two fills on one track: what has been played, and what is safely buffered
            // ahead of it. The second is the only honest way to show why a seek stalled.
            ['--played' as string]: `${played * 100}%`,
            ['--buffered' as string]: `${ahead * 100}%`,
          }}
          aria-hidden="true"
        />
        <input
          className={styles.range}
          type="range"
          min={0}
          max={max === 0 ? 1 : max}
          step={0.1}
          value={Math.min(currentTime, max === 0 ? 1 : max)}
          disabled={disabled || max === 0}
          aria-label={S.playerSeek}
          aria-valuetext={`${format.duration(currentTime)} / ${format.duration(max)}`}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </div>

      {/* ASCII and monospace: a position is compared against the player's own clock. */}
      <span className={styles.clock} dir="ltr">
        {format.duration(currentTime)} / {format.duration(max)}
      </span>

      <button
        type="button"
        className={styles.mute}
        onClick={onToggleMute}
        disabled={disabled}
        aria-label={muted ? S.playerUnmute : S.playerMute}
        aria-pressed={muted}
      >
        {muted || volume === 0 ? <VolumeOffIcon size={18} /> : <VolumeIcon size={18} />}
      </button>

      <input
        className={styles.volume}
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        disabled={disabled}
        aria-label={S.playerVolume}
        onChange={(event) => onVolume(Number(event.target.value))}
      />
    </div>
  );
}
