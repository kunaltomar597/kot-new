import { fontSize, fontWeight, radius, spacing, touchTarget } from '@rp/design-tokens';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { GlyphName } from '../glyphs.js';
import { useTheme, weight } from '../theme.js';
import { Glyph } from './Glyph.js';

export interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Accessible name of the group, e.g. "Quantity of Dal Makhani". */
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
}

/** − 2 + : changes a quantity with large buttons (NFR-U03); the value is announced as it changes. */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 99,
  label,
  decreaseLabel,
  increaseLabel,
  disabled = false,
}: QuantityStepperProps) {
  const { colors } = useTheme();
  const step = (glyph: GlyphName, name: string, off: boolean, next: number) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={() => {
        onChange(next);
      }}
      style={({ pressed }) => [
        styles.button,
        {
          borderColor: colors.borderStrong,
          backgroundColor: colors.surface,
          opacity: off ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Glyph name={glyph} color={colors.text} size={fontSize.xl} />
    </Pressable>
  );
  return (
    <View accessibilityLabel={label} style={styles.root}>
      {step('minus', decreaseLabel, disabled || value <= min, Math.max(min, value - 1))}
      <Text
        accessibilityLiveRegion="polite"
        testID="stepper-value"
        style={[styles.value, { color: colors.text }]}
      >
        {value}
      </Text>
      {step('plus', increaseLabel, disabled || value >= max, Math.min(max, value + 1))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  button: {
    width: touchTarget.min,
    height: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
  },
  value: {
    minWidth: spacing[8],
    textAlign: 'center',
    fontSize: fontSize.xl,
    fontWeight: weight(fontWeight.semibold),
    fontVariant: ['tabular-nums'],
  },
});
