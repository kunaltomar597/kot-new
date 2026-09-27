import { fontSize, radius, spacing, touchTarget } from '@rp/design-tokens';
import { useId } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme.js';

export interface TextFieldProps {
  /** The visible label, also the field's accessible name, e.g. "Search the menu". */
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  /** A line of help under the field. */
  hint?: string;
  /** What is wrong with the value; shown under the field and announced. */
  error?: string;
  maxLength?: number;
  disabled?: boolean;
  /** Several lines, e.g. instructions for the kitchen. */
  multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  keyboardType?: 'default' | 'url' | 'number-pad';
  /** The keyboard's action key, e.g. "search" on a search field. */
  returnKeyType?: 'done' | 'search' | 'next';
  testID?: string;
}

/**
 * A labelled text input with a hint and an error, at least 48 dp tall (NFR-U03). The native twin
 * of `@rp/ui-web` TextField: search, instructions for the kitchen, pairing details.
 */
export function TextField({
  label,
  value,
  onChangeText,
  hint,
  error,
  maxLength,
  disabled = false,
  multiline = false,
  autoCapitalize = 'sentences',
  autoCorrect = true,
  keyboardType = 'default',
  returnKeyType,
  testID,
}: TextFieldProps) {
  const { colors } = useTheme();
  const labelId = useId();
  return (
    <View style={styles.field}>
      <Text nativeID={labelId} style={[styles.label, { color: colors.text }]}>
        {label}
      </Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityLabelledBy={labelId}
        {...(hint !== undefined && { accessibilityHint: hint })}
        accessibilityState={{ disabled }}
        editable={!disabled}
        value={value}
        onChangeText={onChangeText}
        {...(maxLength !== undefined && { maxLength })}
        multiline={multiline}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        keyboardType={keyboardType}
        {...(returnKeyType !== undefined && { returnKeyType })}
        style={[
          styles.input,
          multiline && styles.multiline,
          {
            borderColor: error === undefined ? colors.borderStrong : colors.danger,
            color: colors.text,
            backgroundColor: colors.surface,
            opacity: disabled ? 0.6 : 1,
          },
        ]}
      />
      {hint === undefined ? null : (
        <Text style={[styles.hint, { color: colors.textMuted }]}>{hint}</Text>
      )}
      {error === undefined ? null : (
        <Text accessibilityRole="alert" style={[styles.hint, { color: colors.dangerText }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing[1] },
  label: { fontSize: fontSize.md },
  input: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    fontSize: fontSize.lg,
  },
  multiline: {
    minHeight: touchTarget.min * 2,
    paddingVertical: spacing[2],
    textAlignVertical: 'top',
  },
  hint: { fontSize: fontSize.sm },
});
