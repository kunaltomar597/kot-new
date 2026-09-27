import { fontSize, fontWeight, radius, spacing, touchTarget } from '@rp/design-tokens';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';
import { useTheme, weight } from '../theme.js';

export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'accent'] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
  /** The button's words, from the i18n catalogue. */
  children: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** `md` meets the 48 dp touch minimum (NFR-U03); `lg` is for primary actions. */
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Shows a spinner, marks the button busy and blocks repeat presses (e.g. double submission). */
  loading?: boolean;
  disabled?: boolean;
  startIcon?: ReactNode;
  /** A longer accessible name when the words alone are not enough. */
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** The native twin of `@rp/ui-web` Button: same variants, sizes and loading behaviour. */
export function Button({
  children,
  onPress,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled = false,
  startIcon,
  accessibilityLabel,
  testID,
  style,
}: ButtonProps) {
  const { colors } = useTheme();
  const inactive = disabled || loading;
  const palette = {
    primary: { background: colors.primary, text: colors.onPrimary, border: colors.primary },
    accent: { background: colors.accent, text: colors.onAccent, border: colors.accent },
    danger: { background: colors.danger, text: colors.onDanger, border: colors.danger },
    secondary: { background: colors.surface, text: colors.text, border: colors.borderStrong },
    ghost: { background: 'transparent', text: colors.primary, border: 'transparent' },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: size === 'lg' ? touchTarget.comfortable : touchTarget.min,
          backgroundColor: palette.background,
          borderColor: palette.border,
          opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
        },
        fullWidth && styles.full,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={palette.text} /> : startIcon}
      <Text
        style={[
          styles.label,
          { color: palette.text, fontSize: size === 'lg' ? fontSize.lg : fontSize.md },
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    borderRadius: radius.md,
    borderWidth: 1,
  },
  full: { alignSelf: 'stretch' },
  label: { fontWeight: weight(fontWeight.semibold) },
});
