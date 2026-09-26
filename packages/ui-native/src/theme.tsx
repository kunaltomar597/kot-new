import { type ColorRoles, type ThemeName, themes, type Tone } from '@rp/design-tokens';
import { createContext, type ReactNode, use, useMemo } from 'react';
import type { TextStyle } from 'react-native';

export interface NativeTheme {
  readonly name: ThemeName;
  readonly colors: ColorRoles;
}

/** The restaurant's accent colour pair (NFR-U02), from the Control Plane branding. */
export interface AccentColors {
  readonly accent: string;
  readonly onAccent: string;
}

const ThemeContext = createContext<NativeTheme>({ name: 'light', colors: themes.light });

export interface ThemeProviderProps {
  theme?: ThemeName;
  accent?: AccentColors;
  children: ReactNode;
}

/**
 * The colour roles from `@rp/design-tokens` for the chosen theme, the same values `@rp/ui-web`
 * writes as CSS variables, so the apps and the console look alike (NFR-U01).
 */
export function ThemeProvider({ theme = 'light', accent, children }: ThemeProviderProps) {
  const value = useMemo<NativeTheme>(
    () => ({ name: theme, colors: { ...themes[theme], ...accent } }),
    [theme, accent],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): NativeTheme {
  return use(ThemeContext);
}

/** Strong, subtle and text colours of a tone. */
export function toneColors(
  colors: ColorRoles,
  tone: Tone,
): { readonly solid: string; readonly on: string; readonly subtle: string; readonly text: string } {
  return {
    solid: colors[tone],
    on: colors[`on${capitalise(tone)}`],
    subtle: colors[`${tone}Subtle`],
    text: colors[`${tone}Text`],
  };
}

function capitalise<T extends string>(word: T): Capitalize<T> {
  return (word.charAt(0).toUpperCase() + word.slice(1)) as Capitalize<T>;
}

/** A token font weight (a number) as React Native's string weight. */
export function weight(value: number): TextStyle['fontWeight'] {
  return String(value) as TextStyle['fontWeight'];
}
