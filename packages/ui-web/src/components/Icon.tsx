import type { SVGProps } from 'react';

/**
 * A small built-in icon set (24 px grid, 2 px stroke, round caps), so the library has no icon
 * dependency and icons match on web and native (NFR-U01). Icons are decorative: the text next to
 * them, or the button's accessible name, carries the meaning.
 */
const PATHS = {
  backspace: 'M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z M17 9l-6 6 M11 9l6 6',
  close: 'M18 6 6 18 M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  checkDouble: 'M18 6 7 17l-5-5 M22 10l-7.5 7.5L13 16',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 6v6l4 2',
  send: 'M22 2 11 13 M22 2l-7 20-4-9-9-4 20-7Z',
  flame:
    'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z',
  handPlatter: 'M3 17h18 M5 17a7 7 0 0 1 14 0 M12 7V5 M2 21h20',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M4.9 4.9l14.2 14.2',
  xCircle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M15 9l-6 6 M9 9l6 6',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 16v-4 M12 8h.01',
  warning:
    'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z M12 9v4 M12 17h.01',
  error: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 8v4 M12 16h.01',
  offline:
    'M2 2l20 20 M8.5 16.5a5 5 0 0 1 7 0 M2 8.8a15 15 0 0 1 4.2-2.6 M10.7 5.1A15 15 0 0 1 22 8.8 M5 12.9a10 10 0 0 1 5.2-2.7 M16.9 10.7a10 10 0 0 1 2.1 2.2 M12 20h.01',
  sync: 'M21 12a9 9 0 0 1-15.5 6.2L3 16 M3 12a9 9 0 0 1 15.5-6.2L21 8 M21 3v5h-5 M3 21v-5h5',
  inbox:
    'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  /** Size in CSS units; defaults to 1.25em so icons follow the text size. */
  size?: number | string;
}

export function Icon({ name, size = '1.25em', className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `rp-icon ${className}` : 'rp-icon'}
      data-icon={name}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
