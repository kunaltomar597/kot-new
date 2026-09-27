import type { MenuSnapshot, OrderView } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { type LiveData, messageOf, Note, useT } from '@rp/mobile-shell';
import { displayState, kotDelivery, kotDeliveryText, unavailableReason } from '@rp/ordering';
import { Button, Glyph, StatusChip, toneColors, useTheme, weight } from '@rp/ui-native';
import { StyleSheet, Text, View } from 'react-native';

type SentLine = OrderView['items'][number];

/** Why a sent line cannot be ordered again from the phone now, or undefined when it can. */
function againBlocked(
  menu: MenuSnapshot | null | undefined,
  line: SentLine,
): 'NO_MENU' | 'OFF_MENU' | 'SOLD_OUT' | 'NOT_AVAILABLE' | undefined {
  if (menu === null || menu === undefined) return 'NO_MENU';
  const item = menu.items.find((candidate) => candidate.id === line.itemId);
  if (item === undefined || item.archived || !item.channels.includes('WAITER_APP')) {
    return 'OFF_MENU';
  }
  return unavailableReason(item);
}

/** "Full · Cheese, Butter · Dal Makhani, Rasmalai · Less spicy". */
function lineDetails(line: SentLine, order: OrderView): string {
  const parts = order.items
    .filter((part) => part.parentOrderItemId === line.id)
    .map((part) => part.name);
  return [
    line.variantName ?? '',
    line.modifiers.map((modifier) => modifier.name).join(', '),
    parts.join(', '),
    line.instructions ?? '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

/**
 * What was sent for this table (WTR-007, WTR-012): each order with its kitchen tickets and
 * whether each one reached the kitchen (on the kitchen screen, printed, printing, or held by a
 * printer problem), and each item's live state with "Again" to order it once more (NFR-U03).
 */
export function SentOrders({
  data,
  menu,
  onAgain,
  onRetry,
}: {
  data: LiveData<readonly OrderView[]>;
  menu: MenuSnapshot | null | undefined;
  onAgain: (order: OrderView, line: SentLine) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const { colors } = useTheme();
  const heading = (
    <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
      {t('pos.sent.title')}
    </Text>
  );
  if (data.status === 'loading') {
    return (
      <View style={styles.section}>
        {heading}
        <Note>{t('states.loading')}</Note>
      </View>
    );
  }
  if (data.status === 'error') {
    return (
      <View style={styles.section}>
        {heading}
        <Note tone="danger">{messageOf(data.error, t)}</Note>
        <Button variant="secondary" onPress={onRetry}>
          {t('states.retry')}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.section}>
      {heading}
      {data.value.length === 0 ? <Note>{t('pos.sent.none')}</Note> : null}
      {data.value.map((order) => (
        <View
          key={order.id}
          accessibilityLabel={t('pos.sent.order', { number: order.orderNumber })}
          testID={`order-${String(order.orderNumber)}`}
          style={[styles.order, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={[styles.orderTitle, { color: colors.text }]}>
            {t('pos.sent.order', { number: order.orderNumber })}
          </Text>
          {order.kots.map((kot) => {
            const delivery = kotDelivery(kot, menu?.stations ?? []);
            const tone = toneColors(
              colors,
              delivery.reached ? 'success' : delivery.print === 'FAILED' ? 'danger' : 'warning',
            );
            const title = t('pos.kot.title', { number: kot.kotNumber, station: kot.stationName });
            const status = kotDeliveryText(delivery, t);
            return (
              <View
                key={kot.id}
                accessible
                accessibilityLabel={`${title}: ${status}`}
                testID={`kot-${String(kot.kotNumber)}`}
                style={[styles.kot, { backgroundColor: tone.subtle }]}
              >
                <Glyph
                  name={
                    delivery.reached ? 'check' : delivery.print === 'FAILED' ? 'warning' : 'clock'
                  }
                  color={tone.text}
                />
                <Text style={[styles.kotText, { color: tone.text }]}>{`${title}: ${status}`}</Text>
              </View>
            );
          })}
          {order.items
            .filter((line) => line.parentOrderItemId === null)
            .map((line) => {
              const state = displayState(line, order.items);
              const details = lineDetails(line, order);
              const blocked = againBlocked(menu, line);
              const reason =
                blocked === 'SOLD_OUT'
                  ? t('pos.menu.soldOut')
                  : blocked === 'NOT_AVAILABLE'
                    ? t('pos.menu.notAvailable')
                    : blocked === 'OFF_MENU'
                      ? t('pos.cart.offMenu')
                      : undefined;
              return (
                <View key={line.id} testID={`sent-line-${line.id}`} style={styles.line}>
                  <View style={styles.lineText}>
                    <Text style={[styles.lineName, { color: colors.text }]}>
                      {`${String(line.quantity)} × ${line.name}`}
                    </Text>
                    {details === '' ? null : (
                      <Text style={{ color: colors.textMuted }}>{details}</Text>
                    )}
                    <StatusChip state={state} label={t(`pos.itemState.${state}`)} />
                  </View>
                  <View style={styles.again}>
                    <Button
                      variant="secondary"
                      disabled={blocked !== undefined}
                      accessibilityLabel={t('mobile.order.againOf', { name: line.name })}
                      onPress={() => {
                        onAgain(order, line);
                      }}
                    >
                      {t('mobile.order.again')}
                    </Button>
                    {reason === undefined ? null : (
                      <Text style={[styles.reason, { color: colors.dangerText }]}>{reason}</Text>
                    )}
                  </View>
                </View>
              );
            })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[2] },
  heading: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  order: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[3], gap: spacing[2] },
  orderTitle: { fontSize: fontSize.md, fontWeight: weight(fontWeight.bold) },
  kot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.md,
  },
  kotText: { flex: 1, fontSize: fontSize.sm, fontWeight: weight(fontWeight.semibold) },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  lineText: { flex: 1, gap: spacing[1] },
  lineName: { fontSize: fontSize.md },
  again: { alignItems: 'flex-end', gap: spacing[1] },
  reason: { fontSize: fontSize.sm },
});
