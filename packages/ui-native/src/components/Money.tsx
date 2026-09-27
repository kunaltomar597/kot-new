import { fontSize, fontWeight } from '@rp/design-tokens';
import { formatRupees, type Paise } from '@rp/domain';
import { type StyleProp, Text, type TextStyle } from 'react-native';
import { useTheme, weight } from '../theme.js';

export interface MoneyProps {
  /** Integer paise (BRD §9.4). Never rupees, never a float: a non-integer throws. */
  paise: Paise;
  /** Show the ₹ symbol (default). */
  symbol?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Colour negative amounts (refunds, discounts) as danger; the minus sign is always shown. */
  signTone?: boolean;
  strong?: boolean;
  style?: StyleProp<TextStyle>;
}

/** An amount of money formatted by `@rp/domain` (Indian grouping, 2 decimals), tabular digits. */
export function Money({
  paise,
  symbol = true,
  size = 'md',
  signTone = false,
  strong = false,
  style,
}: MoneyProps) {
  const { colors } = useTheme();
  return (
    <Text
      style={[
        {
          color: signTone && paise < 0 ? colors.dangerText : colors.text,
          fontSize: fontSize[size],
          fontVariant: ['tabular-nums'],
          fontWeight: weight(strong ? fontWeight.bold : fontWeight.regular),
        },
        style,
      ]}
    >
      {formatRupees(paise, { symbol })}
    </Text>
  );
}
