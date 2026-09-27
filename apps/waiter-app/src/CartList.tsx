import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { multiply } from '@rp/domain';
import { useT } from '@rp/mobile-shell';
import {
  type CartLine,
  cartTotal,
  type LineProblem,
  lineProblemText,
  removeLine,
  updateLine,
} from '@rp/ordering';
import { Button, Money, QuantityStepper, TextField, useTheme, weight } from '@rp/ui-native';
import { StyleSheet, Text, View } from 'react-native';
import { INSTRUCTIONS_MAX } from './ItemSheet';

/**
 * The new items of a table before they are sent (WTR-003): quantity, a note for the kitchen and
 * remove on each, with what stops a line from being sent now, from the live menu (WTR-010), or
 * the server's reason when it refused the line (ORD-017). Prices are estimates.
 */
export function CartList({
  lines,
  problems,
  onChange,
}: {
  lines: readonly CartLine[];
  problems: ReadonlyMap<string, LineProblem>;
  onChange: (lines: readonly CartLine[]) => void;
}) {
  const t = useT();
  const { colors } = useTheme();
  return (
    <View accessibilityLabel={t('pos.cart.title')} style={styles.list}>
      {lines.map((line) => {
        const problem = problems.get(line.clientLineId);
        const reason = problem === undefined ? line.error : lineProblemText(problem, t);
        return (
          <View
            key={line.clientLineId}
            testID={`cart-line-${line.itemId}`}
            style={[
              styles.line,
              {
                backgroundColor: colors.surface,
                borderColor: reason === undefined ? colors.border : colors.danger,
              },
            ]}
          >
            <View style={styles.head}>
              <Text style={[styles.name, { color: colors.text }]}>{line.name}</Text>
              <Money paise={multiply(line.unitPrice, line.quantity)} />
            </View>
            {line.summary === '' ? null : (
              <Text style={{ color: colors.textMuted }}>{line.summary}</Text>
            )}
            {reason === undefined ? null : (
              <Text accessibilityRole="alert" style={{ color: colors.dangerText }}>
                {reason}
              </Text>
            )}
            <View style={styles.controls}>
              <QuantityStepper
                value={line.quantity}
                onChange={(quantity) => {
                  onChange(updateLine(lines, line.clientLineId, { quantity }));
                }}
                label={t('pos.item.quantityOf', { name: line.name })}
                decreaseLabel={t('pos.item.fewer')}
                increaseLabel={t('pos.item.more')}
              />
              <Button
                variant="ghost"
                accessibilityLabel={t('pos.cart.remove', { name: line.name })}
                onPress={() => {
                  onChange(removeLine(lines, line.clientLineId));
                }}
              >
                {t('mobile.order.remove')}
              </Button>
            </View>
            <TextField
              label={t('pos.item.instructions')}
              value={line.instructions}
              maxLength={INSTRUCTIONS_MAX}
              onChangeText={(instructions) => {
                onChange(updateLine(lines, line.clientLineId, { instructions }));
              }}
            />
          </View>
        );
      })}
      {lines.length === 0 ? null : (
        <View style={styles.total}>
          <View style={styles.head}>
            <Text style={[styles.name, { color: colors.text }]}>{t('pos.cart.total')}</Text>
            <Money paise={cartTotal(lines)} size="lg" strong />
          </View>
          <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            {t('pos.cart.estimateNote')}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[3] },
  line: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[3], gap: spacing[2] },
  head: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing[2] },
  name: { flex: 1, fontSize: fontSize.md, fontWeight: weight(fontWeight.semibold) },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  total: { gap: spacing[1] },
});
