import { fontSize, fontWeight, radius, spacing, touchTarget } from '@rp/design-tokens';
import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useUiStrings } from '../strings.js';
import { useTheme, weight } from '../theme.js';
import { Glyph } from './Glyph.js';

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export interface PinPadProps {
  /** Called with the entered PIN. The pad clears itself straight after, so a retry starts empty. */
  onComplete: (pin: string) => void;
  /** Digits in the PIN, 4 to 8, from the settings registry (AUTH-001). */
  length?: number;
  /** Submit as soon as the last digit is entered (default). Otherwise a submit key is shown. */
  autoSubmit?: boolean;
  /** Accessible name, e.g. "Enter your PIN" or "Manager PIN". Defaults to the generic string. */
  label?: string;
  /** Plain-language error from the last attempt. */
  error?: string | null;
  /** Blocks input while the PIN is being checked. */
  busy?: boolean;
  disabled?: boolean;
}

/**
 * The PIN pad for staff login and manager overrides in the apps (AUTH-004), the native twin of
 * `@rp/ui-web` PinPad. Digits are never shown or announced (AUTH-002): the screen shows filled
 * dots and TalkBack hears "2 of 4 digits entered".
 */
export function PinPad({
  onComplete,
  length = MIN_PIN_LENGTH,
  autoSubmit = true,
  label,
  error,
  busy = false,
  disabled = false,
}: PinPadProps) {
  if (!Number.isInteger(length) || length < MIN_PIN_LENGTH || length > MAX_PIN_LENGTH) {
    throw new RangeError(
      `PIN length must be a whole number from ${String(MIN_PIN_LENGTH)} to ${String(MAX_PIN_LENGTH)}.`,
    );
  }
  const strings = useUiStrings().pinPad;
  const { colors } = useTheme();
  const [digits, setDigits] = useState('');
  const inactive = busy || disabled;

  const submit = (pin: string) => {
    setDigits('');
    onComplete(pin);
  };

  const press = (id: string) => {
    if (id === 'backspace') {
      setDigits(digits.slice(0, -1));
    } else if (id === 'clear') {
      setDigits('');
    } else if (id === 'submit') {
      if (digits.length === length) submit(digits);
    } else if (digits.length < length) {
      const next = digits + id;
      if (autoSubmit && next.length === length) submit(next);
      else setDigits(next);
    }
  };

  const key = (
    id: string,
    content: ReactNode,
    options: { label?: string; action?: boolean; submit?: boolean; disabled?: boolean } = {},
  ) => {
    const off = inactive || options.disabled === true;
    return (
      <Pressable
        key={id}
        accessibilityRole="button"
        accessibilityLabel={options.label}
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={() => {
          press(id);
        }}
        testID={`pin-key-${id}`}
        style={({ pressed }) => [
          styles.key,
          {
            backgroundColor:
              options.submit === true
                ? colors.primary
                : options.action === true
                  ? colors.surfaceSunken
                  : colors.surface,
            borderColor: colors.border,
            opacity: off ? 0.5 : pressed ? 0.8 : 1,
          },
        ]}
      >
        {content}
      </Pressable>
    );
  };

  const digitKey = (digit: string) =>
    key(digit, <Text style={[styles.digit, { color: colors.text }]}>{digit}</Text>);

  return (
    <View
      accessibilityLabel={label ?? strings.label}
      accessibilityState={{ disabled, busy }}
      style={styles.root}
    >
      <View
        accessible
        accessibilityLabel={strings.progress(digits.length, length)}
        accessibilityLiveRegion="polite"
        testID="pin-progress"
        style={styles.dots}
      >
        {Array.from({ length }, (_, index) => (
          <View
            key={index}
            testID={index < digits.length ? 'pin-dot-filled' : 'pin-dot'}
            style={[
              styles.dot,
              {
                borderColor: error ? colors.danger : colors.borderStrong,
                backgroundColor: index < digits.length ? colors.text : 'transparent',
              },
            ]}
          />
        ))}
      </View>
      {error ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.error}
        >
          <Glyph name="error" color={colors.dangerText} />
          <Text style={{ color: colors.dangerText, fontSize: fontSize.md }}>{error}</Text>
        </View>
      ) : null}
      <View style={styles.grid}>
        {DIGITS.map(digitKey)}
        {key(
          'clear',
          <Text style={[styles.action, { color: colors.text }]}>{strings.clear}</Text>,
          { action: true },
        )}
        {digitKey('0')}
        {key('backspace', <Glyph name="backspace" color={colors.text} size={fontSize.xl} />, {
          label: strings.backspace,
          action: true,
          disabled: digits.length === 0,
        })}
      </View>
      {autoSubmit
        ? null
        : key(
            'submit',
            <Text style={[styles.action, { color: colors.onPrimary }]}>{strings.submit}</Text>,
            { submit: true, disabled: digits.length !== length },
          )}
    </View>
  );
}

const KEY = touchTarget.comfortable + spacing[4];

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: spacing[4] },
  dots: { flexDirection: 'row', gap: spacing[3], paddingVertical: spacing[2] },
  dot: { width: 16, height: 16, borderRadius: radius.full, borderWidth: 2 },
  error: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    width: KEY * 3 + spacing[3] * 2,
    gap: spacing[3],
  },
  key: {
    width: KEY,
    height: touchTarget.comfortable + spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  digit: { fontSize: fontSize['2xl'], fontWeight: weight(fontWeight.semibold) },
  action: { fontSize: fontSize.md, fontWeight: weight(fontWeight.semibold) },
});
