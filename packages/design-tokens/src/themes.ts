/**
 * Semantic colour roles for every theme (NFR-U01, NFR-U02). Components use roles, never raw
 * colours, so a theme or the restaurant accent can change without touching components.
 *
 * Final brand colours wait for OI-01; the values here are a neutral slate/blue system that meets
 * WCAG 2.2 AA (checked by tests), with the KDS theme at AAA for body text (KDS-011).
 */

export const THEME_NAMES = ['light', 'dark', 'kds'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
export type Tone = (typeof TONES)[number];

export interface ColorRoles {
  /** Page background. */
  readonly background: string;
  /** Cards, panels, table rows. */
  readonly surface: string;
  /** Dialogs, sheets, toasts, menus. */
  readonly surfaceRaised: string;
  /** Wells, inputs, keypad backgrounds. */
  readonly surfaceSunken: string;
  /** Decorative dividers (not relied on to identify controls). */
  readonly border: string;
  /** Control outlines (inputs, secondary buttons); at least 3:1 against surfaces. */
  readonly borderStrong: string;
  readonly text: string;
  readonly textMuted: string;
  /** Disabled text (exempt from contrast rules, always paired with another cue). */
  readonly textDisabled: string;
  readonly textInverse: string;
  readonly primary: string;
  readonly primaryHover: string;
  readonly primaryActive: string;
  readonly onPrimary: string;
  /** Restaurant accent slot; defaults to primary and is overridden per restaurant (NFR-U02). */
  readonly accent: string;
  readonly onAccent: string;
  readonly focusRing: string;
  /** Scrim behind dialogs and sheets. */
  readonly overlay: string;
  readonly neutral: string;
  readonly onNeutral: string;
  readonly neutralSubtle: string;
  readonly neutralText: string;
  readonly info: string;
  readonly onInfo: string;
  readonly infoSubtle: string;
  readonly infoText: string;
  readonly success: string;
  readonly onSuccess: string;
  readonly successSubtle: string;
  readonly successText: string;
  readonly warning: string;
  readonly onWarning: string;
  readonly warningSubtle: string;
  readonly warningText: string;
  readonly danger: string;
  readonly onDanger: string;
  readonly dangerSubtle: string;
  readonly dangerText: string;
}

const light: ColorRoles = {
  background: '#f8fafc',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceSunken: '#f1f5f9',
  border: '#e2e8f0',
  borderStrong: '#64748b',
  text: '#0f172a',
  textMuted: '#475569',
  textDisabled: '#94a3b8',
  textInverse: '#f8fafc',
  primary: '#1d4ed8',
  primaryHover: '#1e40af',
  primaryActive: '#1e3a8a',
  onPrimary: '#ffffff',
  accent: '#1d4ed8',
  onAccent: '#ffffff',
  focusRing: '#2563eb',
  overlay: 'rgb(15 23 42 / 0.55)',
  neutral: '#475569',
  onNeutral: '#ffffff',
  neutralSubtle: '#e2e8f0',
  neutralText: '#334155',
  info: '#0369a1',
  onInfo: '#ffffff',
  infoSubtle: '#e0f2fe',
  infoText: '#075985',
  success: '#15803d',
  onSuccess: '#ffffff',
  successSubtle: '#dcfce7',
  successText: '#166534',
  warning: '#b45309',
  onWarning: '#ffffff',
  warningSubtle: '#fef3c7',
  warningText: '#92400e',
  danger: '#b91c1c',
  onDanger: '#ffffff',
  dangerSubtle: '#fee2e2',
  dangerText: '#991b1b',
};

const dark: ColorRoles = {
  background: '#0f172a',
  surface: '#1e293b',
  surfaceRaised: '#273449',
  surfaceSunken: '#0b1222',
  border: '#334155',
  borderStrong: '#94a3b8',
  text: '#f1f5f9',
  textMuted: '#cbd5e1',
  textDisabled: '#64748b',
  textInverse: '#0f172a',
  primary: '#60a5fa',
  primaryHover: '#93c5fd',
  primaryActive: '#bfdbfe',
  onPrimary: '#0f172a',
  accent: '#60a5fa',
  onAccent: '#0f172a',
  focusRing: '#93c5fd',
  overlay: 'rgb(2 6 23 / 0.7)',
  neutral: '#94a3b8',
  onNeutral: '#0f172a',
  neutralSubtle: '#334155',
  neutralText: '#e2e8f0',
  info: '#38bdf8',
  onInfo: '#0f172a',
  infoSubtle: '#0c4a6e',
  infoText: '#bae6fd',
  success: '#4ade80',
  onSuccess: '#052e16',
  successSubtle: '#14532d',
  successText: '#bbf7d0',
  warning: '#fbbf24',
  onWarning: '#1c1917',
  warningSubtle: '#78350f',
  warningText: '#fde68a',
  danger: '#f87171',
  onDanger: '#0f172a',
  dangerSubtle: '#7f1d1d',
  dangerText: '#fecaca',
};

/** Kitchen display: near-black background, saturated status colours, AAA text (KDS-011). */
const kds: ColorRoles = {
  background: '#000000',
  surface: '#121212',
  surfaceRaised: '#1f1f1f',
  surfaceSunken: '#000000',
  border: '#333333',
  borderStrong: '#a3a3a3',
  text: '#ffffff',
  textMuted: '#d4d4d4',
  textDisabled: '#737373',
  textInverse: '#000000',
  primary: '#60a5fa',
  primaryHover: '#93c5fd',
  primaryActive: '#bfdbfe',
  onPrimary: '#000000',
  accent: '#60a5fa',
  onAccent: '#000000',
  focusRing: '#fde047',
  overlay: 'rgb(0 0 0 / 0.75)',
  neutral: '#a3a3a3',
  onNeutral: '#000000',
  neutralSubtle: '#333333',
  neutralText: '#f5f5f5',
  info: '#38bdf8',
  onInfo: '#000000',
  infoSubtle: '#0c4a6e',
  infoText: '#e0f2fe',
  success: '#22c55e',
  onSuccess: '#000000',
  successSubtle: '#14532d',
  successText: '#dcfce7',
  warning: '#facc15',
  onWarning: '#000000',
  warningSubtle: '#713f12',
  warningText: '#fef9c3',
  danger: '#ef4444',
  onDanger: '#000000',
  dangerSubtle: '#7f1d1d',
  dangerText: '#fee2e2',
};

export const themes: Readonly<Record<ThemeName, ColorRoles>> = { light, dark, kds };

/** Themes whose surfaces are dark; used for `color-scheme` (native form controls, scrollbars). */
export const DARK_THEMES: readonly ThemeName[] = ['dark', 'kds'];
