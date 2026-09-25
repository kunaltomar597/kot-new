/**
 * Colour maths used to check themes against WCAG 2.2 contrast rules (NFR-U05) and to pick a
 * readable text colour for the restaurant accent (NFR-U02). Pure functions, no platform APIs.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** Parses `#rgb` or `#rrggbb`. Throws on anything else so bad branding data fails loudly. */
export function parseHexColor(value: string): Rgb {
  if (!isHexColor(value)) {
    throw new RangeError(`Expected a colour like #1d4ed8, got "${value}".`);
  }
  const hex =
    value.length === 4
      ? value
          .slice(1)
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : value.slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.2 relative luminance of a hex colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.2 contrast ratio between two hex colours, 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Black or white, whichever reads better on `background`. */
export function readableTextColor(background: string): '#000000' | '#ffffff' {
  return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background)
    ? '#000000'
    : '#ffffff';
}
