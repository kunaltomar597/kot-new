import type { MenuSnapshot, RestaurantProfile, TabletTableView } from '@rp/contracts';
import { fontSize, fontWeight, spacing } from '@rp/design-tokens';
import type { KeyValueStore } from '@rp/mobile-core';
import { Note, Screen, useDeviceSession, useLive, useSessionState, useT } from '@rp/mobile-shell';
import { SegmentedControl, useTheme, weight } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CartView } from './CartView';
import { MenuView } from './MenuView';
import { MyOrders } from './MyOrders';
import { ServiceButtons } from './ServiceButtons';
import { useCart } from './use-cart';

/** Dishes a guest can order from this tablet right now (MENU-006). */
export function orderableCount(menu: MenuSnapshot): number {
  return menu.items.filter(
    (item) => !item.archived && item.available && item.channels.includes('TABLE_TABLET'),
  ).length;
}

type View3 = 'menu' | 'cart' | 'orders';

/**
 * While the table's session is open (TAB-003): the guests browse the menu and order (TAB-005 to
 * TAB-009), follow what they ordered (TAB-010) and call for water, a waiter or the bill (TAB-004).
 * Without the server, ordering and the buttons pause with "Please call a waiter" and come back by
 * themselves (TAB-013).
 */
export function OpenTableScreen({
  restaurant,
  table,
  menu,
  store,
  guestEpoch,
}: {
  restaurant: RestaurantProfile | null;
  table: TabletTableView;
  menu: MenuSnapshot | null | undefined;
  store: KeyValueStore;
  guestEpoch: number;
}) {
  const t = useT();
  const session = useDeviceSession();
  const { colors } = useTheme();
  const { connection } = useSessionState();
  const online = connection === 'online';
  const cart = useCart(store, guestEpoch);
  const [view, setView] = useState<View3>('menu');
  const { data: bestsellers } = useLive(
    () => session.api.listBestSellers(),
    (type) => type === 'MenuPublished',
  );
  const covers = table.session?.covers ?? null;
  const count = cart.lines.reduce((total, line) => total + line.quantity, 0);

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
        {menu === null || menu === undefined ? (
          <Note>{t('mobile.tablet.menuWaiting')}</Note>
        ) : (
          <Note tone="text" testID="menu-count">
            {t('mobile.tablet.dishes', { count: orderableCount(menu) })}
          </Note>
        )}
      </View>
      {!online && (
        <Note tone="danger" testID="call-waiter">
          {t('mobile.tablet.ordering.callWaiter')}
        </Note>
      )}
      <ServiceButtons disabled={!online} />
      <SegmentedControl
        label={t('mobile.tablet.ordering.views')}
        options={[
          { id: 'menu', label: t('mobile.tablet.ordering.menuTab') },
          { id: 'cart', label: t('mobile.tablet.ordering.cartTab', { count }) },
          { id: 'orders', label: t('mobile.tablet.ordering.ordersTab') },
        ]}
        value={view}
        onChange={(id) => {
          setView(id as View3);
        }}
      />
      {menu === null || menu === undefined ? null : view === 'menu' ? (
        <MenuView
          menu={menu}
          bestsellers={new Set(bestsellers.status === 'ready' ? bestsellers.value.itemIds : [])}
          priceMode={table.priceMode}
          ordering={online}
          onAdd={(line) => {
            cart.add(line);
          }}
        />
      ) : view === 'cart' ? (
        <CartView
          cart={cart}
          menu={menu}
          priceMode={table.priceMode}
          ordering={online}
          onSent={() => {
            setView('orders');
          }}
        />
      ) : (
        <MyOrders />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: spacing[2], paddingVertical: spacing[4] },
  welcome: { fontSize: fontSize['3xl'], fontWeight: weight(fontWeight.bold), textAlign: 'center' },
  table: { fontSize: fontSize['2xl'], fontWeight: weight(fontWeight.semibold) },
});
