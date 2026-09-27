import type { MenuSnapshot, RestaurantProfile } from '@rp/contracts';
import { fontSize, fontWeight, spacing } from '@rp/design-tokens';
import { Note, Screen, useDeviceSession, useMenu, useSessionState, useT } from '@rp/mobile-shell';
import { useTheme, weight } from '@rp/ui-native';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Dishes a guest can order from this tablet right now (MENU-006). */
export function orderableCount(menu: MenuSnapshot): number {
  return menu.items.filter(
    (item) => !item.archived && item.available && item.channels.includes('TABLE_TABLET'),
  ).length;
}

/**
 * The tablet's idle screen: restaurant, table and today's menu, kept live by the device session
 * (MENU-013, MENU-006; P2-01c smoke flow).
 */
export function TabletHome() {
  const session = useDeviceSession();
  const { device, connection } = useSessionState();
  const t = useT();
  const { colors } = useTheme();
  const snapshot = useMenu();
  const [restaurant, setRestaurant] = useState<RestaurantProfile | null>(null);

  useEffect(() => {
    if (connection !== 'online' || restaurant !== null) return;
    let active = true;
    session.api
      .getRestaurant()
      .then((profile) => {
        if (active) setRestaurant(profile);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [connection, restaurant, session]);

  return (
    <Screen>
      <View style={styles.hero}>
        {restaurant !== null && (
          <Text accessibilityRole="header" style={[styles.welcome, { color: colors.text }]}>
            {t('mobile.tablet.welcome', { restaurant: restaurant.displayName })}
          </Text>
        )}
        {device !== undefined && (
          <Text style={[styles.table, { color: colors.textMuted }]}>{device.name}</Text>
        )}
        {snapshot === null || snapshot === undefined ? (
          <Note>{t('mobile.tablet.menuWaiting')}</Note>
        ) : (
          <Note tone="text" testID="menu-count">
            {t('mobile.tablet.dishes', { count: orderableCount(snapshot) })}
          </Note>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: spacing[3], paddingVertical: spacing[12] },
  welcome: { fontSize: fontSize['3xl'], fontWeight: weight(fontWeight.bold) },
  table: { fontSize: fontSize.xl },
});
