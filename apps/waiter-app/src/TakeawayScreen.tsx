import { newIdempotencyKey, uuidV4 } from '@rp/api-client';
import type { MenuItem } from '@rp/contracts';
import { fontSize, fontWeight, spacing } from '@rp/design-tokens';
import {
  ItemSheet,
  messageOf,
  Note,
  Screen,
  useDeviceSession,
  useLive,
  useMenu,
  useNow,
  useT,
} from '@rp/mobile-shell';
import {
  addLine,
  type CartLine,
  lineProblems,
  markRejected,
  needsOptions,
  requestLines,
} from '@rp/ordering';
import { Button, StatusChip, TextField, useTheme, useToast, weight } from '@rp/ui-native';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CartList } from './CartList';
import { MenuBrowser } from './MenuBrowser';

/** Takeaway orders come and go with these events. */
const affectsTakeaway = (eventType: string) =>
  eventType === 'OrderSubmitted' ||
  eventType === 'ItemStatusChanged' ||
  eventType === 'InvoiceIssued' ||
  eventType === 'PaymentRecorded';

/**
 * A takeaway order from the waiter app (WTR-013): dishes from the menu, the customer's name and
 * phone if given, sent straight to the kitchen with a token (TBL-008), and the open takeaway
 * orders with their tokens and progress. Billing stays at the POS.
 */
export function TakeawayScreen({ onBack }: { onBack: () => void }) {
  const session = useDeviceSession();
  const t = useT();
  const toast = useToast();
  const { colors } = useTheme();
  const menu = useMenu();
  const now = useNow(30_000);
  const [lines, setLines] = useState<readonly CartLine[]>([]);
  const [choosing, setChoosing] = useState<MenuItem | undefined>();
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const open = useLive(
    async () => (await session.api.listTakeawayOrders()).orders,
    affectsTakeaway,
  );
  const problems = useMemo(
    () =>
      menu === null || menu === undefined
        ? new Map()
        : lineProblems(menu, lines, 'WAITER_APP', now),
    [menu, lines, now],
  );

  const add = (line: Omit<CartLine, 'clientLineId' | 'error'>) => {
    setNotice(undefined);
    setLines((current) => addLine(current, line, uuidV4));
  };

  const choose = (item: MenuItem) => {
    if (menu === null || menu === undefined) return;
    if (needsOptions(menu, item)) {
      setChoosing(item);
      return;
    }
    add({
      itemId: item.id,
      name: item.name,
      summary: '',
      quantity: 1,
      selection: {},
      instructions: '',
      unitPrice: item.basePrice,
    });
  };

  const send = async () => {
    setSending(true);
    setNotice(undefined);
    try {
      const answer = await session.api.submitOrder({
        body: {
          idempotencyKey: newIdempotencyKey(),
          source: 'WAITER_APP',
          orderType: 'TAKEAWAY',
          ...(customer.trim() !== '' && { customerName: customer.trim() }),
          ...(phone.trim() !== '' && { customerPhone: phone.trim() }),
          lines: requestLines(lines),
        },
      });
      if (answer.status !== 'ACCEPTED') {
        setLines((current) => markRejected(current, answer.rejectedLines));
        setNotice(t('pos.result.rejected'));
        return;
      }
      const order = await session.api.getOrder({ params: { orderId: answer.orderId } });
      toast.show({
        title: t('pos.result.takeaway', {
          token: order.takeawayToken ?? 0,
          number: answer.orderNumber,
        }),
        tone: 'success',
      });
      setLines([]);
      setCustomer('');
      setPhone('');
      open.reload();
    } catch (failure) {
      setNotice(t('pos.result.notSent', { message: messageOf(failure, t) }));
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen
      title={t('mobile.takeaway.title')}
      actions={
        <Button variant="ghost" onPress={onBack}>
          {t('mobile.takeaway.back')}
        </Button>
      }
    >
      {menu === null || menu === undefined ? (
        <Note>{t('mobile.order.menuWaiting')}</Note>
      ) : (
        <MenuBrowser menu={menu} onChoose={choose} />
      )}
      <CartList lines={lines} problems={problems} onChange={setLines} />
      {lines.length === 0 ? null : (
        <View style={styles.form}>
          <TextField
            label={t('mobile.takeaway.customer')}
            value={customer}
            maxLength={60}
            onChangeText={setCustomer}
          />
          <TextField
            label={t('mobile.takeaway.phone')}
            value={phone}
            keyboardType="number-pad"
            onChangeText={setPhone}
          />
          {notice === undefined ? null : <Note tone="danger">{notice}</Note>}
          <Button
            fullWidth
            testID="send-takeaway"
            disabled={sending || problems.size > 0}
            onPress={() => void send()}
          >
            {t('mobile.takeaway.send')}
          </Button>
        </View>
      )}
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
        {t('mobile.takeaway.open')}
      </Text>
      {open.data.status !== 'ready' ? null : open.data.value.length === 0 ? (
        <Note>{t('mobile.takeaway.none')}</Note>
      ) : (
        open.data.value.map((order) => (
          <View
            key={order.id}
            testID={`takeaway-${String(order.takeawayToken ?? order.orderNumber)}`}
            style={[styles.order, { borderColor: colors.border, backgroundColor: colors.surface }]}
          >
            <Text style={[styles.title, { color: colors.text }]}>
              {[
                t('mobile.takeaway.token', { token: order.takeawayToken ?? 0 }),
                order.customerName ?? '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {order.items
              .filter((item) => item.parentOrderItemId === null)
              .map((item) => (
                <View key={item.id} style={styles.line}>
                  <Text style={{ color: colors.text, flex: 1 }}>
                    {t('approvals.line', { quantity: item.quantity, name: item.name })}
                  </Text>
                  <StatusChip state={item.state} label={t(`pos.itemState.${item.state}`)} />
                </View>
              ))}
          </View>
        ))
      )}
      {choosing !== undefined && menu !== null && menu !== undefined ? (
        <ItemSheet
          menu={menu}
          item={choosing}
          onClose={() => {
            setChoosing(undefined);
          }}
          onAdd={(line) => {
            add(line);
            setChoosing(undefined);
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing[2] },
  heading: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  order: { borderWidth: 1, borderRadius: 8, padding: spacing[3], gap: spacing[1] },
  title: { fontSize: fontSize.md, fontWeight: weight(fontWeight.semibold) },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
});
