import type { MenuItem } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { useSessionState, useT } from '@rp/mobile-shell';
import { displayPrice } from '@rp/ordering';
import { Money, toneColors, useTheme, weight } from '@rp/ui-native';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { photoSource } from './branding';

const FOOD_TONE = { VEG: 'success', NON_VEG: 'danger', EGG: 'warning' } as const;

/**
 * A dish on the tablet's menu (TAB-005): photo, name, price, the veg / non-veg / egg mark with
 * its word, spice level, tags and the bestseller badge; sold-out dishes cannot be chosen
 * (TAB-012). A large touch target, in plain words (TAB-016).
 */
export function DishCard({
  item,
  bestseller,
  soldOut,
  disabled = false,
  onSelect,
}: {
  item: MenuItem;
  bestseller: boolean;
  soldOut: boolean;
  /** Ordering is paused, e.g. while the server cannot be reached (TAB-013). */
  disabled?: boolean;
  onSelect: () => void;
}) {
  const off = soldOut || disabled;
  const t = useT();
  const { colors } = useTheme();
  const { serverUrl } = useSessionState();
  const food = toneColors(colors, FOOD_TONE[item.foodType]);
  const photo = item.photoId === undefined ? undefined : photoSource(serverUrl, item.photoId, 480);
  const spice =
    item.spiceLevel > 0 ? t('mobile.tablet.ordering.spice', { level: item.spiceLevel }) : '';
  const facts = [t(`pos.menu.foodType.${item.foodType}`), spice, ...item.tags]
    .filter((fact) => fact !== '')
    .join(' · ');
  return (
    <Pressable
      testID={`dish-${item.id}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: off }}
      accessibilityLabel={[item.name, facts, soldOut ? t('mobile.tablet.ordering.soldOut') : '']
        .filter((part) => part !== '')
        .join(', ')}
      disabled={off}
      onPress={onSelect}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          opacity: off ? 0.55 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {photo !== undefined && (
        <Image
          source={photo}
          style={styles.photo}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      )}
      <View style={styles.body}>
        <View style={styles.header}>
          <View style={[styles.mark, { borderColor: food.solid }]}>
            <View style={[styles.dot, { backgroundColor: food.solid }]} />
          </View>
          <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>
            {item.name}
          </Text>
        </View>
        {bestseller && (
          <Text style={[styles.badge, { color: colors.onAccent, backgroundColor: colors.accent }]}>
            {t('mobile.tablet.ordering.bestseller')}
          </Text>
        )}
        <Text style={{ color: colors.textMuted }} numberOfLines={2}>
          {facts}
        </Text>
        {item.description !== undefined && (
          <Text style={{ color: colors.textMuted }} numberOfLines={2}>
            {item.description}
          </Text>
        )}
        <View style={styles.footer}>
          <Money paise={displayPrice(item)} size="lg" strong />
          {soldOut && (
            <Text style={{ color: colors.dangerText, fontWeight: weight(fontWeight.semibold) }}>
              {t('mobile.tablet.ordering.soldOut')}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexBasis: '31%',
    flexGrow: 1,
    minWidth: 220,
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  photo: { width: '100%', height: 140 },
  body: { gap: spacing[1], padding: spacing[3] },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  mark: {
    width: 18,
    height: 18,
    borderWidth: 2,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { flex: 1, fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[2],
    borderRadius: radius.sm,
    fontSize: fontSize.sm,
    overflow: 'hidden',
  },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
