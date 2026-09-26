import { fontSize, fontWeight, radius, spacing, touchTarget } from '@rp/design-tokens';
import { formatRupees, type Paise } from '@rp/domain';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, weight } from '../theme.js';
import { Money } from './Money.js';

export type FoodType = 'VEG' | 'NON_VEG' | 'EGG';

export interface MenuItemCardProps {
  name: string;
  price: Paise;
  foodType: FoodType;
  /** The food type in words, e.g. "Veg" (the mark alone is not enough, NFR-U05). */
  foodTypeLabel: string;
  /** A short note, e.g. "Choose options", "Combo" or "5 left". */
  note?: string;
  /** Why it cannot be ordered, e.g. "Sold out"; the card is then disabled. */
  unavailable?: string;
  onSelect?: () => void;
}

/** The Indian veg / non-veg / egg mark colours, as in `@rp/ui-web`. */
const FOOD_TONE = { VEG: 'success', NON_VEG: 'danger', EGG: 'warning' } as const;

/**
 * One dish on an ordering screen (MENU-012): name, price, the veg/non-veg/egg mark and a note, as
 * a large touch target (NFR-U03). The native twin of `@rp/ui-web` MenuItemCard.
 */
export function MenuItemCard({
  name,
  price,
  foodType,
  foodTypeLabel,
  note,
  unavailable,
  onSelect,
}: MenuItemCardProps) {
  const { colors } = useTheme();
  const spoken = [name, formatRupees(price), foodTypeLabel, unavailable ?? note].filter(
    (part): part is string => part !== undefined,
  );
  const off = unavailable !== undefined;
  const mark = colors[FOOD_TONE[foodType]];
  const detail = unavailable ?? note;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken.join(', ')}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onSelect}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          opacity: off ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.top}>
        <View testID={`food-${foodType}`} style={[styles.mark, { borderColor: mark }]}>
          <View style={[styles.markDot, { backgroundColor: mark }]} />
        </View>
        <Text numberOfLines={2} style={[styles.name, { color: colors.text }]}>
          {name}
        </Text>
      </View>
      <Money paise={price} strong />
      {detail === undefined ? null : (
        <Text style={{ color: off ? colors.dangerText : colors.textMuted, fontSize: fontSize.sm }}>
          {detail}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: touchTarget.comfortable * 2,
    padding: spacing[3],
    gap: spacing[1],
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  mark: {
    width: 16,
    height: 16,
    marginTop: 2,
    borderWidth: 2,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markDot: { width: 7, height: 7, borderRadius: radius.full },
  name: { flex: 1, fontSize: fontSize.md, fontWeight: weight(fontWeight.semibold) },
});
