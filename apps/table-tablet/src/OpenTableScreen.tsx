import type { MenuSnapshot, RestaurantProfile, TabletTableView } from '@rp/contracts';
import { fontSize, fontWeight, spacing } from '@rp/design-tokens';
import { Note, Screen, useT } from '@rp/mobile-shell';
import { useTheme, weight } from '@rp/ui-native';
import { StyleSheet, Text, View } from 'react-native';

/** Dishes a guest can order from this tablet right now (MENU-006). */
export function orderableCount(menu: MenuSnapshot): number {
  return menu.items.filter(
    (item) => !item.archived && item.available && item.channels.includes('TABLE_TABLET'),
  ).length;
}

/**
 * While the table's session is open (TAB-003): the guests are welcomed at their table. The
 * service buttons (P3-02) and the menu with ordering (P3-03) arrive here.
 */
export function OpenTableScreen({
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
  const covers = table.session?.covers ?? null;
  return (
    <Screen>
      <View style={styles.hero} testID="open-table">
        {restaurant !== null && (
          <Text accessibilityRole="header" style={[styles.welcome, { color: colors.text }]}>
            {t('mobile.tablet.welcome', { restaurant: restaurant.displayName })}
          </Text>
        )}
        <Text style={[styles.table, { color: colors.accent }]}>
          {covers === null
            ? t('mobile.tablet.table', { table: table.label })
            : `${t('mobile.tablet.table', { table: table.label })} · ${t('mobile.tablet.guests', { count: covers })}`}
        </Text>
        <Text style={[styles.enjoy, { color: colors.textMuted }]}>{t('mobile.tablet.enjoy')}</Text>
        {menu === null || menu === undefined ? (
          <Note>{t('mobile.tablet.menuWaiting')}</Note>
        ) : (
          <Note tone="text" testID="menu-count">
            {t('mobile.tablet.dishes', { count: orderableCount(menu) })}
          </Note>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: spacing[3], paddingVertical: spacing[12] },
  welcome: { fontSize: fontSize['3xl'], fontWeight: weight(fontWeight.bold), textAlign: 'center' },
  table: { fontSize: fontSize['2xl'], fontWeight: weight(fontWeight.semibold) },
  enjoy: { fontSize: fontSize.lg, textAlign: 'center' },
});
