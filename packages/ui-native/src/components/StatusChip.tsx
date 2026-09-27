import { fontSize, fontWeight, radius, spacing, type Tone } from '@rp/design-tokens';
import type { OrderItemState } from '@rp/domain';
import { StyleSheet, Text, View } from 'react-native';
import type { GlyphName } from '../glyphs.js';
import { toneColors, useTheme, weight } from '../theme.js';
import { Glyph } from './Glyph.js';

/**
 * How each order item state looks on every surface, the same as `@rp/ui-web`: a tone and a symbol,
 * always next to the state's name, so colour is never the only signal (NFR-U05).
 */
export const ORDER_ITEM_STATE_STYLES: Readonly<
  Record<OrderItemState, { readonly tone: Tone; readonly icon: GlyphName }>
> = {
  PENDING_APPROVAL: { tone: 'warning', icon: 'clock' },
  SENT: { tone: 'info', icon: 'send' },
  PREPARING: { tone: 'info', icon: 'flame' },
  READY: { tone: 'success', icon: 'check' },
  PICKED_UP: { tone: 'success', icon: 'handPlatter' },
  SERVED: { tone: 'neutral', icon: 'checkDouble' },
  REJECTED: { tone: 'danger', icon: 'xCircle' },
  CANCELLED: { tone: 'danger', icon: 'xCircle' },
  VOIDED: { tone: 'danger', icon: 'ban' },
};

export interface StatusChipProps {
  state: OrderItemState;
  /** The state's name from the i18n catalogue, e.g. "Ready". */
  label: string;
  size?: 'md' | 'lg';
}

/** The order item status chip reused on every surface (NFR-M01). */
export function StatusChip({ state, label, size = 'md' }: StatusChipProps) {
  const { colors } = useTheme();
  const style = ORDER_ITEM_STATE_STYLES[state];
  const tone = toneColors(colors, style.tone);
  const text = size === 'lg' ? fontSize.md : fontSize.sm;
  return (
    <View
      accessible
      accessibilityLabel={label}
      testID={`status-${state}`}
      style={[styles.chip, { backgroundColor: tone.subtle }]}
    >
      <Glyph name={style.icon} color={tone.text} size={text} />
      <Text style={[styles.label, { color: tone.text, fontSize: text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.full,
  },
  label: { fontWeight: weight(fontWeight.semibold) },
});
