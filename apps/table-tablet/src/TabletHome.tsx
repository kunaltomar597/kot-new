import type { MenuSnapshot, RestaurantProfile } from '@rp/contracts';
import { fontSize, fontWeight, spacing } from '@rp/design-tokens';
import type { MenuCache } from '@rp/mobile-core';
import { Note, Screen, useDeviceSession, useSessionState, useT } from '@rp/mobile-shell';
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
 * Keeps the menu on the tablet current (MENU-013): the cached copy at once, even offline, then a
 * fresh one when a newer version is published, on reconnect, and availability changes live.
 */
function useMenu(menu: MenuCache): MenuSnapshot | null {
  const session = useDeviceSession();
  const { connection } = useSessionState();
  const [snapshot, setSnapshot] = useState<MenuSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    const show = (value: MenuSnapshot | null) => {
      if (active && value !== null) setSnapshot(value);
    };
    const fetchMenu = () => session.api.getMenu();
    void menu.get().then(show);
    const unsubscribe = session.onEvent((event) => {
      if (event.type === 'MenuPublished') {
        menu
          .refresh(fetchMenu, { announcedVersion: event.payload.menuVersion })
          .then((result) => {
            show(result.menu);
          })
          .catch(() => undefined);
      } else if (event.type === 'ItemAvailabilityChanged') {
        void menu.applyAvailability(event.payload).then(show);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [menu, session]);

  useEffect(() => {
    if (connection !== 'online') return;
    let active = true;
    menu
      .refresh(() => session.api.getMenu(), { force: true })
      .then((result) => {
        if (active) setSnapshot(result.menu);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [connection, menu, session]);

  return snapshot;
}

/** The tablet's idle screen: restaurant, table and today's menu, kept live (P2-01c smoke flow). */
export function TabletHome({ menu }: { menu: MenuCache }) {
  const session = useDeviceSession();
  const { device, connection } = useSessionState();
  const t = useT();
  const { colors } = useTheme();
  const snapshot = useMenu(menu);
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
        {snapshot === null ? (
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
