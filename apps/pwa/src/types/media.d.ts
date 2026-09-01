/**
 * Safari-only media attributes and APIs that React and `lib.dom` do not know about.
 *
 * These are not conveniences — `x-webkit-airplay` is the entire AirPlay mechanism for a
 * `<video>` element, and `audioTracks` is the only way to offer an audio-track picker for a
 * file with a Persian and an English track. Declaring them here keeps the casts out of the
 * component, where a cast would quietly become the place a future bug hides.
 */
import 'react';

declare module 'react' {
  interface VideoHTMLAttributes<T> {
    /** `allow` puts the AirPlay button in Safari's native controls. There is no other way. */
    'x-webkit-airplay'?: 'allow' | 'deny';
    /** The pre-iOS-10 spelling. Harmless where unsupported, and still read by older WebKits. */
    'webkit-playsinline'?: boolean | 'true';
    /** Opting *out* of remote playback, which LocalCast never does. Declared for completeness. */
    disableRemotePlayback?: boolean;
  }
}

/** One entry of Safari's `HTMLMediaElement.audioTracks`. */
export interface WebKitAudioTrack {
  id: string;
  kind: string;
  label: string;
  language: string;
  enabled: boolean;
}

export interface WebKitAudioTrackList {
  readonly length: number;
  [index: number]: WebKitAudioTrack;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

declare global {
  interface HTMLVideoElement {
    audioTracks?: WebKitAudioTrackList;
    /** Opens the AirPlay target picker from a control of our own. */
    webkitShowPlaybackTargetPicker?: () => void;
    /** True once at least one AirPlay-capable target has been seen on the network. */
    webkitCurrentPlaybackTargetIsWireless?: boolean;
  }
}
