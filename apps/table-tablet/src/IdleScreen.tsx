import type { MenuSnapshot, RestaurantProfile, TabletTableView } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { Screen, useSessionState, useT } from '@rp/mobile-shell';
import { Money, useTheme, weight } from '@rp/ui-native';
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { photoSource } from './branding';

const ROTATE_MS = 8_000;

/**
 * While the table is free (TAB-003): the restaurant's logo and name, "Please wait to be seated",
 * and, when the restaurant wants it, its pinned dishes one after another.
 */
export function IdleScreen({
  restaurant,
  table,
  menu,
}: {
  restaurant: RestaurantProfile | null;
  table: TabletTableView;
  menu: MenuSnapshot | null | undefined;
}) {
  const t = useT();
  const { colors } = useTheme();
  const { serverUrl } = useSessionState();
  const promoted = table.promotions.show
    ? table.promotions.itemIds.flatMap((id) => {
        const item = menu?.items.find((candidate) => candidate.id === id);
        return item?.available === true ? [item] : [];
      })
    : [];
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (promoted.length < 2) return;
    const timer = setInterval(() => {
      setIndex((current) => current + 1);
    }, ROTATE_MS);
    return () => {
      clearInterval(timer);
    };
  }, [promoted.length]);
  const special = promoted.length === 0 ? undefined : promoted[index % promoted.length];
  const logo =
    restaurant?.logoPhotoId === null || restaurant === null
      ? undefined
      : photoSource(serverUrl, restaurant.logoPhotoId, 480);
  return (
    <Screen>
      <View style={styles.hero} testID="idle-screen">
        {logo !== undefined && restaurant !== null && (
          <Image
            source={logo}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel={t('mobile.tablet.logo', { restaurant: restaurant.displayName })}
          />
        )}
        {restaurant !== null && (
          <Text accessibilityRole="header" style={[styles.welcome, { color: colors.text }]}>
            {t('mobile.tablet.welcome', { restaurant: restaurant.displayName })}
          </Text>
        )}
        <Text style={[styles.wait, { color: colors.accent }]}>
          {t('mobile.tablet.waitToBeSeated')}
        </Text>
        <Text style={[styles.hint, { color: colors.textMuted }]}>
          {t('mobile.tablet.seatedSoon')}
        </Text>
      </View>
      {special !== undefined && (
        <View
          testID="promotion"
          accessibilityLiveRegion="polite"
          style={[styles.special, { backgroundColor: colors.surface, borderColor: colors.accent }]}
        >
          {special.photoId !== undefined && photoSource(serverUrl, special.photoId, 480) && (
            <Image
              source={photoSource(serverUrl, special.photoId, 480)}
              style={styles.photo}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
          )}
          <View style={styles.specialText}>
            <Text style={[styles.label, { color: colors.accent }]}>
              {t('mobile.tablet.todaysSpecial')}
            </Text>
            <Text style={[styles.name, { color: colors.text }]}>{special.name}</Text>
            {special.description !== undefined && (
              <Text style={{ color: colors.textMuted, fontSize: fontSize.lg }}>
                {special.description}
              </Text>
            )}
            <Money paise={special.basePrice} size="lg" />
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: spacing[3], paddingVertical: spacing[8] },
  logo: { width: 200, height: 120 },
  welcome: { fontSize: fontSize['3xl'], fontWeight: weight(fontWeight.bold), textAlign: 'center' },
  wait: { fontSize: fontSize['2xl'], fontWeight: weight(fontWeight.semibold) },
  hint: { fontSize: fontSize.lg, textAlign: 'center' },
  special: {
    flexDirection: 'row',
    gap: spacing[4],
    padding: spacing[4],
    borderWidth: 2,
    borderRadius: radius.lg,
    alignItems: 'center',
  },
  photo: { width: 220, height: 160, borderRadius: radius.md },
  specialText: { flex: 1, gap: spacing[2] },
  label: { fontSize: fontSize.md, fontWeight: weight(fontWeight.semibold) },
  name: { fontSize: fontSize['2xl'], fontWeight: weight(fontWeight.bold) },
});
