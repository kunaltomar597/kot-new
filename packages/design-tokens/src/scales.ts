/**
 * Non-colour tokens (NFR-U01). Numbers are CSS pixels on the web and density-independent pixels
 * (dp) in React Native, so both component libraries read the same values. The web CSS emits font
 * sizes in rem so text scales with the browser setting (NFR-U05).
 */

/** Spacing scale on a 4 px grid. */
export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

/**
 * Minimum touch target sizes (NFR-U03, KDS-011). `kds` is larger for wet or gloved hands at the
 * pass; the KDS theme switches the default to it.
 */
export const touchTarget = {
  min: 48,
  comfortable: 56,
  kds: 64,
} as const;

export const fontFamily = {
  // System fonts only: nothing is downloaded, so the UI renders offline (NFR-A01) and every
  // platform uses its own well-hinted face (Segoe UI on Windows, Roboto on Android).
  sans: "system-ui, 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue', Arial, sans-serif",
  mono: "ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', 'Roboto Mono', Menlo, Consolas, monospace",
} as const;

/** Font sizes in px (converted to rem for the web). */
export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
} as const;

/** Larger type for the kitchen display, readable from 2 m (KDS-011). */
export const kdsFontSize: Readonly<Record<keyof typeof fontSize, number>> = {
  xs: 16,
  sm: 18,
  md: 20,
  lg: 24,
  xl: 28,
  '2xl': 32,
  '3xl': 40,
  '4xl': 48,
};

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const lineHeight = {
  tight: 1.2,
  snug: 1.35,
  normal: 1.5,
} as const;

/**
 * Elevation levels. `shadow` is a CSS box-shadow for the web; `androidElevation` is the matching
 * React Native `elevation` value so both libraries look alike.
 */
export const elevation = {
  0: { shadow: 'none', androidElevation: 0 },
  1: { shadow: '0 1px 2px rgb(0 0 0 / 0.12), 0 1px 3px rgb(0 0 0 / 0.08)', androidElevation: 1 },
  2: { shadow: '0 2px 4px rgb(0 0 0 / 0.12), 0 4px 12px rgb(0 0 0 / 0.1)', androidElevation: 4 },
  3: {
    shadow: '0 8px 16px rgb(0 0 0 / 0.16), 0 16px 40px rgb(0 0 0 / 0.14)',
    androidElevation: 12,
  },
} as const;

/** Motion guidelines: short, purposeful transitions; disabled when the user asks for reduced motion. */
export const motion = {
  duration: {
    instant: 0,
    fast: 120,
    normal: 200,
    slow: 320,
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    enter: 'cubic-bezier(0, 0, 0, 1)',
    exit: 'cubic-bezier(0.3, 0, 1, 1)',
  },
} as const;

export const zIndex = {
  base: 0,
  sticky: 100,
  banner: 200,
  overlay: 300,
  dialog: 400,
  toast: 500,
} as const;

/** Layout breakpoints in px (phone, tablet, desktop). */
export const breakpoint = {
  sm: 600,
  md: 900,
  lg: 1200,
} as const;
