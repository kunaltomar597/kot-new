import { fontSize, fontWeight, radius, spacing, touchTarget } from '@rp/design-tokens';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, weight } from '../theme.js';
import { Glyph } from './Glyph.js';

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  /** Shown after the label, e.g. a price change "+₹40.00". */
  readonly detail?: string;
  readonly disabled?: boolean;
}

export interface ChoiceGroupProps {
  legend: string;
  /** The rule, e.g. "Choose 1" or "Optional, up to 3". */
  hint?: string;
  /** `single`: radio buttons; `multiple`: checkboxes. */
  mode: 'single' | 'multiple';
  options: readonly ChoiceOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** In `multiple` mode, unchosen options are disabled once this many are chosen. */
  max?: number;
  error?: string;
}

/**
 * A labelled set of radio buttons or checkboxes with large touch rows (NFR-U03): variants,
 * modifier groups and combo choices, as in `@rp/ui-web` ChoiceGroup.
 */
export function ChoiceGroup({
  legend,
  hint,
  mode,
  options,
  value,
  onChange,
  max,
  error,
}: ChoiceGroupProps) {
  const { colors } = useTheme();
  const full = mode === 'multiple' && max !== undefined && value.length >= max;
  const role = mode === 'single' ? 'radio' : 'checkbox';
  return (
    <View accessibilityRole={mode === 'single' ? 'radiogroup' : undefined} style={styles.group}>
      <Text accessibilityRole="header" style={[styles.legend, { color: colors.text }]}>
        {legend}
      </Text>
      {hint === undefined ? null : (
        <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>{hint}</Text>
      )}
      {options.map((option) => {
        const checked = value.includes(option.id);
        const off = option.disabled === true || (full && !checked);
        const glyph =
          mode === 'single' ? (checked ? 'radioOn' : 'radioOff') : checked ? 'boxOn' : 'boxOff';
        return (
          <Pressable
            key={option.id}
            accessibilityRole={role}
            accessibilityLabel={
              option.detail === undefined ? option.label : `${option.label}, ${option.detail}`
            }
            accessibilityState={{ checked, disabled: off }}
            disabled={off}
            onPress={() => {
              if (mode === 'single') onChange([option.id]);
              else
                onChange(checked ? value.filter((id) => id !== option.id) : [...value, option.id]);
            }}
            style={[
              styles.option,
              {
                borderColor: checked ? colors.primary : colors.border,
                backgroundColor: checked ? colors.infoSubtle : colors.surface,
                opacity: off ? 0.5 : 1,
              },
            ]}
          >
            <Glyph
              name={glyph}
              color={checked ? colors.primary : colors.textMuted}
              size={fontSize.xl}
            />
            <Text style={[styles.label, { color: colors.text }]}>{option.label}</Text>
            {option.detail === undefined ? null : (
              <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
                {option.detail}
              </Text>
            )}
          </Pressable>
        );
      })}
      {error === undefined ? null : (
        <View accessible accessibilityRole="alert" style={styles.error}>
          <Glyph name="error" color={colors.dangerText} />
          <Text style={{ color: colors.dangerText, fontSize: fontSize.sm }}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing[2] },
  legend: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: touchTarget.min,
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    borderWidth: 1,
  },
  label: { flex: 1, fontSize: fontSize.md },
  error: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
});
