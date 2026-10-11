import { photoUrl, type PhotoWidth } from '@rp/contracts';
import { readableTextColor } from '@rp/design-tokens';
import type { AccentColors } from '@rp/ui-native';

/**
 * The restaurant's brand on the tablet (TAB-003, P3-01b): its accent colour with black or white
 * text, whichever reads better on it (NFR-U02, NFR-U05); none keeps the standard colours.
 */
export function accentColorsOf(accent: string | null | undefined): AccentColors | undefined {
  if (accent === null || accent === undefined) return undefined;
  try {
    return { accent, onAccent: readableTextColor(accent) };
  } catch {
    return undefined;
  }
}

/** A photo from the restaurant server (photos are public: menu pictures and the logo). */
export function photoSource(
  serverUrl: string | undefined,
  photoId: string,
  width: PhotoWidth,
): { uri: string } | undefined {
  return serverUrl === undefined ? undefined : { uri: `${serverUrl}${photoUrl(photoId, width)}` };
}

/** Taps in the hidden corner within this window open the staff panel (TAB-001). */
export const STAFF_TAPS = 5;
export const STAFF_TAP_WINDOW_MS = 3_000;

/** The taps still inside the window, with this one; STAFF_TAPS of them open the panel. */
export function staffGesture(taps: readonly number[], now: number): number[] {
  return [...taps.filter((at) => now - at < STAFF_TAP_WINDOW_MS), now];
}
