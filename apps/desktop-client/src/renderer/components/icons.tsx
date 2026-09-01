import type { SVGProps } from 'react';

/**
 * Two icons `@localcast/ui-kit` does not publish.
 *
 * The kit has `PlayIcon` and `PauseIcon` but nothing for volume — it was drawn for the panel
 * and the PWA, neither of which has a desktop transport bar. Rather than editing a package
 * three surfaces share for the sake of one control, they are drawn here to the kit's own
 * treatment: a 20×20 viewBox, `currentColor`, 1.5px stroke, no fill, decorative by default.
 *
 * If the kit later grows them, these are deleted and the import changes; nothing else moves.
 */

interface LocalIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

function Base({ size = 20, children, ...rest }: LocalIconProps & { children: React.ReactNode }) {
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
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function VolumeIcon(props: LocalIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7.5h2.5L10 4.5v11L6.5 12.5H4z" />
      <path d="M13 7.5a3.5 3.5 0 0 1 0 5" />
      <path d="M15.25 5.25a6.5 6.5 0 0 1 0 9.5" />
    </Base>
  );
}

export function VolumeOffIcon(props: LocalIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7.5h2.5L10 4.5v11L6.5 12.5H4z" />
      <path d="m13 8 4 4M17 8l-4 4" />
    </Base>
  );
}
