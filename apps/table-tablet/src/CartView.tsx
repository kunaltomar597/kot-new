import { newIdempotencyKey } from '@rp/api-client';
import type { MenuSnapshot } from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { messageOf, Note, useDeviceSession, useT } from '@rp/mobile-shell';
import { estimateCart, requestLines } from '@rp/ordering';
import { Button, Money, QuantityStepper, useTheme, useToast, weight } from '@rp/ui-native';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Cart } from './use-cart';

/**
 * The diners' order before it is sent (TAB-008, TAB-009): each dish with its choices, quantity
 * and price, the subtotal and estimated GST, and "Send to the waiter". The same key goes with
 * every retry of one sending, so it is never ordered twice (ORD-013); a dish the server refuses
 * is marked to change or remove (ORD-017).
 */
export function CartView({
  cart,
  menu,
  priceMode,
  ordering,
  onSent,
}: {
  cart: Cart;
  menu: MenuSnapshot;
  priceMode: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
  ordering: boolean;
  onSent: () => void;
}) {
  const t = useT();
  const session = useDeviceSession();
  const toast = useToast();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** One key per sending of these exact lines; a changed order gets a new one. */
  const attempt = useRef<{ key: string; lines: string } | null>(null);
  const estimate = estimateCart(cart.lines, menu, priceMode);

  if (cart.lines.length === 0) {
    return <Note tone="text">{t('mobile.tablet.ordering.cartEmpty')}</Note>;
  }

  const send = () => {
    const lines = requestLines(cart.lines);
    const signature = JSON.stringify(lines);
    if (attempt.current?.lines !== signature) {
      attempt.current = { key: newIdempotencyKey(), lines: signature };
    }
    setBusy(true);
    setError(null);
    session.api.submitTabletOrder({ body: { idempotencyKey: attempt.current.key, lines } }).then(
      (answer) => {
        setBusy(false);
        if (answer.status === 'PARTIALLY_REJECTED') {
          cart.rejected(answer.rejectedLines);
          setError(t('mobile.tablet.ordering.rejectedLines'));
          return;
        }
        attempt.current = null;
        cart.clear();
        toast.show({ title: t('mobile.tablet.ordering.sent'), tone: 'success' });
        onSent();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure, t));
      },
    );
  };

  return (
    <View style={styles.view} testID="cart-view">
      {cart.lines.map((line) => (
        <View
          key={line.clientLineId}
          style={[
            styles.line,
            {
              backgroundColor: colors.surface,
              borderColor: line.error === undefined ? colors.border : colors.danger,
            },
          ]}
        >
          <View style={styles.grow}>
            <Text style={[styles.name, { color: colors.text }]}>{line.name}</Text>
            {line.summary !== '' && <Text style={{ color: colors.textMuted }}>{line.summary}</Text>}
            {line.instructions !== '' && (
              <Text style={{ color: colors.textMuted }}>{line.instructions}</Text>
            )}
            {line.error !== undefined && <Note tone="danger">{line.error}</Note>}
          </View>
          <QuantityStepper
            value={line.quantity}
            min={0}
            max={99}
            label={t('approvals.quantityOf', { name: line.name })}
            decreaseLabel={t('pos.item.fewer')}
            increaseLabel={t('pos.item.more')}
            onChange={(quantity) => {
              cart.setQuantity(line.clientLineId, quantity);
            }}
          />
          <Money paise={line.unitPrice * line.quantity} size="lg" />
        </View>
      ))}
      <View style={[styles.totals, { borderColor: colors.border }]}>
        <Row label={t('mobile.tablet.ordering.subtotal')} paise={estimate.subtotal} />
        <Row
          label={t(
            priceMode === 'TAX_INCLUSIVE'
              ? 'mobile.tablet.ordering.taxIncluded'
              : 'mobile.tablet.ordering.estimatedTax',
          )}
          paise={estimate.tax}
        />
        <Row label={t('mobile.tablet.ordering.total')} paise={estimate.total} strong />
        <Text style={{ color: colors.textMuted }}>{t('mobile.tablet.ordering.estimateNote')}</Text>
      </View>
      {error !== null && <Note tone="danger">{error}</Note>}
      <Button
        size="lg"
        fullWidth
        testID="cart-send"
        loading={busy}
        disabled={!ordering}
        onPress={send}
      >
        {t('mobile.tablet.ordering.place')}
      </Button>
    </View>
  );
}

function Row({ label, paise, strong = false }: { label: string; paise: number; strong?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <Text
        style={{
          color: colors.text,
          fontSize: fontSize.lg,
          ...(strong && { fontWeight: weight(fontWeight.bold) }),
        }}
      >
        {label}
      </Text>
      <Money paise={paise} size="lg" strong={strong} />
    </View>
  );
}

const styles = StyleSheet.create({
  view: { gap: spacing[3] },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: 1,
    borderRadius: radius.md,
  },
  grow: { flex: 1, gap: spacing[1] },
  name: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  totals: { gap: spacing[2], paddingTop: spacing[3], borderTopWidth: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
