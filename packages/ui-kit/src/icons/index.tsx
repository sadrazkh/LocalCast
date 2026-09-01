import type { ReactNode, SVGProps } from 'react';
import type { MediaKind } from '@localcast/contract';
import { cx } from '../utils/cx.js';
import styles from './icon.module.css';

/**
 * Inline SVG icons.
 *
 * All of them are 20×20 by default, stroked in `currentColor` at 1.5px, and carry no fill.
 * That is the canvas's icon treatment: thin, quiet, the same optical weight as the 13px
 * label sitting next to them.
 *
 * Icons are decorative by default (`aria-hidden`), because in almost every use here they
 * sit beside a real text label. Passing `title` promotes one to `role="img"` with an
 * accessible name — do that only when the icon is the only thing conveying the meaning.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Edge length in px. 20 is the design default; 16 for dense rows, 24 for empty states. */
  size?: number;
  /** Supplying a title makes the icon an image with an accessible name instead of decor. */
  title?: string;
}

interface BaseProps extends IconProps {
  children: ReactNode;
  /** True only for icons whose meaning is "towards the start/end of the reading order". */
  mirror?: boolean;
}

function Base({ size = 20, className, title, mirror, children, ...rest }: BaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx(styles.icon, mirror ? styles.mirror : undefined, className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

// ── direction-encoding: these mirror under dir="rtl" ─────────────────────────────────

export function ArrowBackIcon(props: IconProps) {
  return (
    <Base mirror {...props}>
      <path d="M16 10H4.5" />
      <path d="M9.5 4.5 4 10l5.5 5.5" />
    </Base>
  );
}

export function ArrowForwardIcon(props: IconProps) {
  return (
    <Base mirror {...props}>
      <path d="M4 10h11.5" />
      <path d="M10.5 4.5 16 10l-5.5 5.5" />
    </Base>
  );
}

export function ChevronStartIcon(props: IconProps) {
  return (
    <Base mirror {...props}>
      <path d="M12.5 4.5 7 10l5.5 5.5" />
    </Base>
  );
}

export function ChevronEndIcon(props: IconProps) {
  return (
    <Base mirror {...props}>
      <path d="M7.5 4.5 13 10l-5.5 5.5" />
    </Base>
  );
}

/** Opening something in an external app; the arrow points "away", so it mirrors. */
export function ExternalIcon(props: IconProps) {
  return (
    <Base mirror {...props}>
      <path d="M11 3.5h5.5V9" />
      <path d="M16.5 3.5 9.5 10.5" />
      <path d="M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8" />
    </Base>
  );
}

// ── neutral: never mirrored ──────────────────────────────────────────────────────────

export function ChevronDownIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 7.5 10 13l5.5-5.5" />
    </Base>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 12.5 10 7l5.5 5.5" />
    </Base>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m5 5 10 10M15 5 5 15" />
    </Base>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m4 10.5 4 4 8-9" />
    </Base>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M10 4v12M4 10h12" />
    </Base>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 10h12" />
    </Base>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="m12.75 12.75 3.75 3.75" />
    </Base>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2.75 5.5a1 1 0 0 1 1-1h3.4l1.6 2h7.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3.75a1 1 0 0 1-1-1z" />
    </Base>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 3.5a1 1 0 0 1 1-1h5l4 4v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
      <path d="M11 2.5v4h4" />
    </Base>
  );
}

export function VideoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.5" y="5" width="11" height="10" rx="1.5" />
      <path d="M13.5 9 17.5 6.5v7L13.5 11z" />
    </Base>
  );
}

export function AudioIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M7.5 13V4.5l8-1.5v8.5" />
      <circle cx="5.5" cy="13.5" r="2" />
      <circle cx="13.5" cy="11.5" r="2" />
    </Base>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="1.5" />
      <circle cx="7.25" cy="8" r="1.5" />
      <path d="m3.5 14 4-4 3.5 3.5L13.5 11l3.25 3.25" />
    </Base>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 3.5a1 1 0 0 1 1-1h5l4 4v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
      <path d="M11 2.5v4h4" />
      <path d="M7.5 11h5M7.5 13.5h3.5" />
    </Base>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.75" y="4" width="14.5" height="3.5" rx="1" />
      <path d="M4.25 7.5v7.5a1 1 0 0 0 1 1h9.5a1 1 0 0 0 1-1V7.5" />
      <path d="M8.25 10.5h3.5" />
    </Base>
  );
}

export function PrinterIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5.5 7.5v-4h9v4" />
      <path d="M5.5 14.5h-2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2" />
      <rect x="5.5" y="11.5" width="9" height="5" rx="1" />
    </Base>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="5.5" y="2.25" width="9" height="15.5" rx="2" />
      <path d="M8.75 15.25h2.5" />
    </Base>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.5" y="3.75" width="15" height="10" rx="1.5" />
      <path d="M7 17h6M10 13.75V17" />
    </Base>
  );
}

export function QrIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.75" y="2.75" width="5.5" height="5.5" rx="1" />
      <rect x="11.75" y="2.75" width="5.5" height="5.5" rx="1" />
      <rect x="2.75" y="11.75" width="5.5" height="5.5" rx="1" />
      <path d="M11.75 11.75h2.5v2.5h-2.5zM17.25 17.25h-2.5v-2.5" />
    </Base>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 6h14M3 14h14" />
      <circle cx="7.5" cy="6" r="2" />
      <circle cx="12.5" cy="14" r="2" />
    </Base>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" />
      <path d="M17 3v3.5h-3.5" />
    </Base>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M1.75 10S4.75 4.75 10 4.75 18.25 10 18.25 10 15.25 15.25 10 15.25 1.75 10 1.75 10Z" />
      <circle cx="10" cy="10" r="2.5" />
    </Base>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8 5.1A7.5 7.5 0 0 1 10 4.75c5.25 0 8.25 5.25 8.25 5.25a15 15 0 0 1-2.6 3.2" />
      <path d="M12.6 12.4a2.5 2.5 0 0 1-3.5-3.5" />
      <path d="M5.1 6.6A15 15 0 0 0 1.75 10S4.75 15.25 10 15.25c1 0 1.9-.2 2.7-.5" />
      <path d="m3 3 14 14" />
    </Base>
  );
}

export function PlayIcon(props: IconProps) {
  // Playback direction is a property of the media, not of the reading order: never mirror.
  return (
    <Base {...props}>
      <path d="M6.5 4.25 15 10l-8.5 5.75z" />
    </Base>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M7.25 4.5v11M12.75 4.5v11" />
    </Base>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M10 3v9" />
      <path d="M6 8.5 10 12.5l4-4" />
      <path d="M3.5 16h13" />
    </Base>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M10 12.5v-9" />
      <path d="M6 7.5 10 3.5l4 4" />
      <path d="M3.5 16h13" />
    </Base>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8.5 11.5a3 3 0 0 0 4.3.1l2.3-2.3a3 3 0 0 0-4.2-4.2l-1.3 1.3" />
      <path d="M11.5 8.5a3 3 0 0 0-4.3-.1l-2.3 2.3a3 3 0 0 0 4.2 4.2l1.3-1.3" />
    </Base>
  );
}

export function CloudOffIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 15.25h8.25a3.25 3.25 0 0 0 .8-6.4 4.75 4.75 0 0 0-7-3.1" />
      <path d="M5.2 7.6A3.75 3.75 0 0 0 6 15.25" />
      <path d="m3 3 14 14" />
    </Base>
  );
}

export function LibraryIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.75" y="2.75" width="6" height="6" rx="1" />
      <rect x="11.25" y="2.75" width="6" height="6" rx="1" />
      <rect x="2.75" y="11.25" width="6" height="6" rx="1" />
      <rect x="11.25" y="11.25" width="6" height="6" rx="1" />
    </Base>
  );
}

export function ServerIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.75" y="3.25" width="14.5" height="5.5" rx="1.5" />
      <rect x="2.75" y="11.25" width="14.5" height="5.5" rx="1.5" />
      <path d="M5.75 6h.01M5.75 14h.01" />
    </Base>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M10 3.25 18 16.75H2z" />
      <path d="M10 8v3.5M10 14.25h.01" />
    </Base>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 9v4.5M10 6.5h.01" />
    </Base>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 10h.01M10 10h.01M15.5 10h.01" />
    </Base>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 5.5h13" />
      <path d="M7.5 5.5V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
      <path d="M5.5 5.5v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-10" />
      <path d="M8.5 8.5v5M11.5 8.5v5" />
    </Base>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M13 7V4.5a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" />
    </Base>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="4" y="8.5" width="12" height="8.5" rx="1.5" />
      <path d="M6.75 8.5V6.25a3.25 3.25 0 0 1 6.5 0V8.5" />
    </Base>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2.5 10h3.25l2-5 4 10 2-5h3.75" />
    </Base>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 5.75V10l3 1.75" />
    </Base>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
    </Base>
  );
}

/**
 * The icon that stands in for a file of a given kind.
 *
 * Phase 1 ships no ffmpeg, so a video has no poster frame and this icon is what the library
 * shows for most rows. It is the normal case, not a failure case — see `FileGridItem`.
 */
export const mediaKindIcons: Record<MediaKind, (props: IconProps) => ReactNode> = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  document: DocumentIcon,
  archive: ArchiveIcon,
  other: FileIcon,
};

export function MediaKindIcon({ kind, ...props }: IconProps & { kind: MediaKind }) {
  const Component = mediaKindIcons[kind];
  return <Component {...props} />;
}

/** The LocalCast mark: a cast wave over a base. Never mirrored — a logo is not direction. */
export function LogoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3.25 16.75h.01" />
      <path d="M3.25 13a3.75 3.75 0 0 1 3.75 3.75" />
      <path d="M3.25 9.25a7.5 7.5 0 0 1 7.5 7.5" />
      <path d="M3.25 5.5a11.25 11.25 0 0 1 11.25 11.25" />
    </Base>
  );
}
