import type { MenuSnapshot, OrderView } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import type { PermissionHolder } from '@rp/domain';
import { type LiveData, messageOf, Note, useT } from '@rp/mobile-shell';
import {
  displayState,
  kotDelivery,
  kotDeliveryText,
  lineActions,
  servableLines,
  unavailableReason,
} from '@rp/ordering';
import { Button, Glyph, StatusChip, toneColors, useTheme, weight } from '@rp/ui-native';
import { StyleSheet, Text, View } from 'react-native';
import type { Ending } from './EndItemSheet';

type SentLine = OrderView['items'][number];

/** What the person may do with the sent items, and what to do when they do it. */
export interface SentActions {
  /** Who is signed in: their role and custom role decide what they may do (AUTH-012). */
  readonly person: PermissionHolder;
  /** Whether the person is this table's waiter (own-table grants). */
  readonly ownTable: boolean;
  /** Lines with a step in flight. */
  readonly busy: ReadonlySet<string>;
  readonly onStep: (line: SentLine, event: 'PICK_UP' | 'SERVE') => void;
  readonly onServeAll: (lines: readonly SentLine[]) => void;
  readonly onEnd: (line: SentLine, ending: Ending) => void;
}

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
 * What was sent for this table (WTR-007, WTR-009, WTR-012): each order with its kitchen tickets
 * and whether each one reached the kitchen (on the kitchen screen, printed, printing, or held by
 * a printer problem), and each item's live state with what can be done with it now: mark it
 * picked up or served, cancel it before the kitchen starts, void it after, or order it again
 * (NFR-U03). Ready dishes can be marked served together.
 */
export function SentOrders({
  data,
  menu,
  actions,
  onAgain,
  onRetry,
}: {
  data: LiveData<readonly OrderView[]>;
  menu: MenuSnapshot | null | undefined;
  actions: SentActions;
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
  const servable = servableLines(data.value, actions.person, actions.ownTable);
  return (
    <View style={styles.section}>
      {heading}
      {data.value.length === 0 ? <Note>{t('pos.sent.none')}</Note> : null}
      {servable.length > 1 ? (
        <Button
          fullWidth
          testID="serve-all"
          disabled={servable.some((line) => actions.busy.has(line.id))}
          onPress={() => {
            actions.onServeAll(servable);
          }}
        >
          {t('mobile.item.serveAll', { count: servable.length })}
        </Button>
      ) : null}
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
              const can = lineActions(line, actions.person, actions.ownTable);
              const busy = actions.busy.has(line.id);
              return (
                <View
                  key={line.id}
                  testID={`sent-line-${line.id}`}
                  style={[styles.line, { borderTopColor: colors.border }]}
                >
                  <View style={styles.lineHead}>
                    <View style={styles.lineText}>
                      <Text style={[styles.lineName, { color: colors.text }]}>
                        {`${String(line.quantity)} × ${line.name}`}
                      </Text>
                      {details === '' ? null : (
                        <Text style={{ color: colors.textMuted }}>{details}</Text>
                      )}
                    </View>
                    <StatusChip state={state} label={t(`pos.itemState.${state}`)} />
                  </View>
                  <View style={styles.lineActions}>
                    {can.serve ? (
                      <Button
                        loading={busy}
                        accessibilityLabel={t('mobile.item.serveOf', { name: line.name })}
                        onPress={() => {
                          actions.onStep(line, 'SERVE');
                        }}
                      >
                        {t('mobile.item.serve')}
                      </Button>
                    ) : null}
                    {can.pickUp ? (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        accessibilityLabel={t('mobile.item.pickUpOf', { name: line.name })}
                        onPress={() => {
                          actions.onStep(line, 'PICK_UP');
                        }}
                      >
                        {t('mobile.item.pickUp')}
                      </Button>
                    ) : null}
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
                    {can.cancel ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        accessibilityLabel={t('mobile.item.cancelOf', { name: line.name })}
                        onPress={() => {
                          actions.onEnd(line, 'CANCEL');
                        }}
                      >
                        {t('mobile.item.cancel')}
                      </Button>
                    ) : null}
                    {can.void === null ? null : (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        accessibilityLabel={t('mobile.item.voidOf', { name: line.name })}
                        onPress={() => {
                          actions.onEnd(line, 'VOID');
                        }}
                      >
                        {t('mobile.item.void')}
                      </Button>
                    )}
                  </View>
                  {reason === undefined ? null : (
                    <Text style={[styles.reason, { color: colors.dangerText }]}>{reason}</Text>
                  )}
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
  line: { gap: spacing[2], borderTopWidth: 1, paddingTop: spacing[2] },
  lineHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  lineText: { flex: 1, gap: spacing[1] },
  lineName: { fontSize: fontSize.md },
  lineActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  reason: { fontSize: fontSize.sm },
});
