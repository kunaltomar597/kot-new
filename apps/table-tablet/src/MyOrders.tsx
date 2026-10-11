import type { OrderView, StaffTile } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { formatRupees } from '@rp/domain';
import { messageOf, Note, useDeviceSession, useLive, useT } from '@rp/mobile-shell';
import { displayState } from '@rp/ordering';
import { Button, PinPad, useTheme, useToast, weight } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Events after which the table's orders are read again: their own and the kitchen's moves. */
const affectsOrders = (eventType: string) =>
  /^(Order(Submitted|Approved|Rejected)|ItemStatusChanged|KotCreated|KotBumped)$/.test(eventType);

const NEVER = () => false;
const APPROVERS = new Set(['WAITER', 'CASHIER', 'MANAGER', 'OWNER']);

/**
 * What the table has ordered (TAB-009, TAB-010): each order with its dishes and their status,
 * live (waiting for confirmation, received, preparing, ready, served, or not accepted with the
 * reason), and the running total. A waiting order can be confirmed here by the waiter with their
 * PIN ("Approve at table", ORD-004).
 */
export function MyOrders() {
  const t = useT();
  const session = useDeviceSession();
  const { colors } = useTheme();
  const { data, reload } = useLive(() => session.api.listTabletOrders(), affectsOrders);
  const [approving, setApproving] = useState<OrderView | null>(null);

  if (data.status === 'loading') return <Note>{t('states.loading')}</Note>;
  if (data.status === 'error') {
    return (
      <View style={styles.view}>
        <Note tone="danger">{messageOf(data.error, t)}</Note>
        <Button variant="secondary" onPress={reload}>
          {t('states.retry')}
        </Button>
      </View>
    );
  }
  const { orders, runningTotal, pendingTotal } = data.value;
  if (approving !== null) {
    return (
      <ApproveAtTable
        order={approving}
        onDone={() => {
          setApproving(null);
          reload();
        }}
      />
    );
  }
  return (
    <View style={styles.view} testID="my-orders">
      <Text style={[styles.total, { color: colors.text }]}>
        {t('mobile.tablet.ordering.runningTotal', { total: formatRupees(runningTotal) })}
      </Text>
      {pendingTotal > 0 && (
        <Text style={{ color: colors.textMuted, fontSize: fontSize.lg }}>
          {t('mobile.tablet.ordering.pendingTotal', { total: formatRupees(pendingTotal) })}
        </Text>
      )}
      {orders.length === 0 && <Note tone="text">{t('mobile.tablet.ordering.nothingYet')}</Note>}
      {[...orders].reverse().map((order) => {
        const lines = order.items.filter((item) => item.parentOrderItemId === null);
        const waiting = lines.some((item) => item.state === 'PENDING_APPROVAL');
        return (
          <View
            key={order.id}
            testID={`order-${order.id}`}
            style={[styles.order, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Text style={[styles.heading, { color: colors.text }]}>
              {t('mobile.tablet.ordering.orderNumber', { number: order.orderNumber })}
            </Text>
            {waiting && (
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.waiting, { color: colors.accent }]}
              >
                {t('mobile.tablet.ordering.waiting')}
              </Text>
            )}
            {lines.map((item) => {
              const state = displayState(item, order.items);
              const ended = state === 'REJECTED' || state === 'CANCELLED' || state === 'VOIDED';
              return (
                <View key={item.id} style={styles.line}>
                  <Text
                    style={[
                      styles.name,
                      { color: ended ? colors.textMuted : colors.text },
                      ended && styles.struck,
                    ]}
                  >
                    {t('approvals.line', { quantity: item.quantity, name: item.name })}
                  </Text>
                  <Text testID={`state-${item.id}`} style={{ color: colors.textMuted }}>
                    {state === 'REJECTED' && item.endReason !== null && item.endReason !== undefined
                      ? t('mobile.tablet.ordering.rejected', { reason: item.endReason })
                      : t(`mobile.tablet.ordering.lineState.${state}`)}
                  </Text>
                </View>
              );
            })}
            {waiting && (
              <Button
                variant="secondary"
                testID={`approve-at-table-${order.id}`}
                onPress={() => {
                  setApproving(order);
                }}
              >
                {t('mobile.tablet.ordering.approveHere')}
              </Button>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** "Approve at table" (ORD-004): the waiter picks their name and enters their PIN. */
function ApproveAtTable({ order, onDone }: { order: OrderView; onDone: () => void }) {
  const t = useT();
  const session = useDeviceSession();
  const toast = useToast();
  const { data } = useLive(() => session.staffTiles(), NEVER);
  const [person, setPerson] = useState<StaffTile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (person !== null) {
    return (
      <View style={styles.view} testID="approve-at-table">
        <PinPad
          label={t('mobile.tablet.ordering.pinFor', { name: person.displayName })}
          busy={busy}
          error={error}
          onComplete={(pin) => {
            setBusy(true);
            setError(null);
            session.api
              .approveOrderAtTable({
                params: { orderId: order.id },
                body: { staffId: person.staffId, pin },
              })
              .then(
                () => {
                  setBusy(false);
                  toast.show({
                    title: t('approvals.approved', { number: order.orderNumber }),
                    tone: 'success',
                  });
                  onDone();
                },
                (failure: unknown) => {
                  setBusy(false);
                  setError(messageOf(failure, t));
                },
              );
          }}
        />
        <Button
          variant="secondary"
          onPress={() => {
            setPerson(null);
            setError(null);
          }}
        >
          {t('mobile.tablet.ordering.notMe')}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.view} testID="approve-at-table">
      <Note tone="text">{t('mobile.tablet.ordering.whoApproves')}</Note>
      {data.status === 'ready' &&
        data.value
          .filter((tile) => APPROVERS.has(tile.role))
          .map((tile) => (
            <Button
              key={tile.staffId}
              variant="secondary"
              size="lg"
              fullWidth
              testID={`approver-${tile.staffId}`}
              onPress={() => {
                setPerson(tile);
              }}
            >
              {tile.displayName}
            </Button>
          ))}
      <Button variant="secondary" onPress={onDone}>
        {t('mobile.tablet.ordering.notMe')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  view: { gap: spacing[3] },
  total: { fontSize: fontSize.xl, fontWeight: weight(fontWeight.bold) },
  order: { gap: spacing[2], padding: spacing[3], borderWidth: 1, borderRadius: radius.lg },
  heading: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  waiting: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing[2] },
  name: { flex: 1, fontSize: fontSize.lg },
  struck: { textDecorationLine: 'line-through' },
});
