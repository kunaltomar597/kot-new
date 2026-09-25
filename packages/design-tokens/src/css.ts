/**
 * CSS custom properties generated from the TS tokens (NFR-U01). The build writes the output of
 * `buildTokensCss()` to `dist/tokens.css`; apps import it once (`@rp/design-tokens/tokens.css`).
 *
 * Variable names: `--rp-<group>-<key>` in kebab-case, e.g. `--rp-color-surface-raised`,
 * `--rp-space-4`, `--rp-font-size-2xl`.
 */
import { isHexColor, readableTextColor } from './color.js';
import {
  breakpoint,
  elevation,
  fontFamily,
  fontSize,
  fontWeight,
  kdsFontSize,
  lineHeight,
  motion,
  radius,
  spacing,
  touchTarget,
  zIndex,
} from './scales.js';
import { type ColorRoles, DARK_THEMES, THEME_NAMES, type ThemeName, themes } from './themes.js';

export type CssVariables = Readonly<Record<`--rp-${string}`, string>>;

const PREFIX = 'rp';
const ROOT_FONT_SIZE = 16;

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Custom property name for a token, e.g. `cssVarName('color', 'surfaceRaised')`. */
export function cssVarName(group: string, key: string | number): `--rp-${string}` {
  return `--${PREFIX}-${kebab(group)}-${kebab(String(key))}`;
}

/** `var(...)` reference for a token, for inline styles. */
export function cssVar(group: string, key: string | number): string {
  return `var(${cssVarName(group, key)})`;
}

function rem(px: number): string {
  return `${String(px / ROOT_FONT_SIZE)}rem`;
}

function entries<T extends object>(value: T): [string, T[keyof T]][] {
  return Object.entries(value) as [string, T[keyof T]][];
}

/** Colour variables for one theme. */
export function colorVariables(theme: ThemeName): CssVariables {
  const result: Record<string, string> = {};
  for (const [key, value] of entries<ColorRoles>(themes[theme])) {
    result[cssVarName('color', key)] = value;
  }
  return result;
}

function fontSizeVariables(scale: Readonly<Record<string, number>>): CssVariables {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(scale))
    result[cssVarName('font-size', key)] = rem(value);
  return result;
}

/** Theme-independent variables: spacing, radius, type, elevation, motion, z-index, touch. */
export function staticVariables(): CssVariables {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(spacing))
    result[cssVarName('space', key)] = `${String(value)}px`;
  for (const [key, value] of Object.entries(radius))
    result[cssVarName('radius', key)] = `${String(value)}px`;
  for (const [key, value] of Object.entries(fontFamily)) result[cssVarName('font', key)] = value;
  Object.assign(result, fontSizeVariables(fontSize));
  for (const [key, value] of Object.entries(fontWeight))
    result[cssVarName('font-weight', key)] = String(value);
  for (const [key, value] of Object.entries(lineHeight))
    result[cssVarName('line-height', key)] = String(value);
  for (const [key, value] of Object.entries(elevation))
    result[cssVarName('elevation', key)] = value.shadow;
  for (const [key, value] of Object.entries(motion.duration))
    result[cssVarName('duration', key)] = `${String(value)}ms`;
  for (const [key, value] of Object.entries(motion.easing))
    result[cssVarName('easing', key)] = value;
  for (const [key, value] of Object.entries(zIndex)) result[cssVarName('z', key)] = String(value);
  for (const [key, value] of Object.entries(breakpoint))
    result[cssVarName('breakpoint', key)] = `${String(value)}px`;
  for (const [key, value] of Object.entries(touchTarget))
    result[cssVarName('touch', key)] = `${String(value)}px`;
  // The size interactive components actually use; the KDS theme raises it.
  result[cssVarName('touch', 'target')] = `${String(touchTarget.min)}px`;
  return result;
}

/** Everything a theme sets: its colours plus the KDS density overrides. */
export function themeVariables(theme: ThemeName): CssVariables {
  const result: Record<string, string> = { ...colorVariables(theme) };
  if (theme === 'kds') {
    Object.assign(result, fontSizeVariables(kdsFontSize));
    result[cssVarName('touch', 'target')] = `${String(touchTarget.kds)}px`;
  }
  return result;
}

/**
 * Variables that apply a restaurant's accent colour (NFR-U02), with a readable text colour picked
 * automatically. Set them as inline style on the element that carries `data-theme`.
 */
export function accentVariables(accent: string): CssVariables {
  if (!isHexColor(accent)) {
    throw new RangeError(`Accent colour must be a hex colour like #c2410c, got "${accent}".`);
  }
  return {
    [cssVarName('color', 'accent')]: accent,
    [cssVarName('color', 'onAccent')]: readableTextColor(accent),
  };
}

function block(
  selector: string,
  variables: CssVariables,
  extra: string[] = [],
  indent = '  ',
): string {
  const lines = [
    ...extra.map((line) => `${indent}  ${line}`),
    ...Object.entries(variables).map(([name, value]) => `${indent}  ${name}: ${value};`),
  ];
  return `${indent}${selector} {\n${lines.join('\n')}\n${indent}}`;
}

function colorScheme(theme: ThemeName): string {
  return `color-scheme: ${DARK_THEMES.includes(theme) ? 'dark' : 'light'};`;
}

/**
 * The complete token stylesheet, inside the `rp.tokens` cascade layer so app styles win without
 * specificity fights. Themes are chosen with `data-theme="light|dark|kds"` on any element; with no
 * `data-theme`, the root follows the operating system's light/dark preference.
 */
export function buildTokensCss(): string {
  const zeroDurations: Record<string, string> = {};
  for (const key of Object.keys(motion.duration))
    zeroDurations[cssVarName('duration', key)] = '0ms';

  const parts = [
    block(':root', { ...staticVariables(), ...themeVariables('light') }, [colorScheme('light')]),
    `  @media (prefers-color-scheme: dark) {\n${block(
      ':root:not([data-theme])',
      themeVariables('dark'),
      [colorScheme('dark')],
      '    ',
    )}\n  }`,
    ...THEME_NAMES.map((theme) =>
      block(`[data-theme='${theme}']`, themeVariables(theme), [colorScheme(theme)]),
    ),
    `  @media (prefers-reduced-motion: reduce) {\n${block(':root', zeroDurations, [], '    ')}\n  }`,
  ];
  return `/* Generated by @rp/design-tokens. Do not edit. */\n@layer rp.tokens {\n${parts.join('\n\n')}\n}\n`;
}
