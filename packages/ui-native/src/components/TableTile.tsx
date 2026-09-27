import { fontSize, fontWeight, radius, spacing, touchTarget, type Tone } from '@rp/design-tokens';
import { formatRupees, type Paise, type TableState } from '@rp/domain';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { GlyphName } from '../glyphs.js';
import { toneColors, useTheme, weight } from '../theme.js';
import { Glyph } from './Glyph.js';
import { Money } from './Money.js';

/**
 * How each table state looks on every floor view, the same tones as `@rp/ui-web` TableTile: a tone
 * and a symbol next to the state's name, so colour is never the only signal (NFR-U05).
 */
export const TABLE_STATE_STYLES: Readonly<
  Record<TableState, { readonly tone: Tone; readonly icon: GlyphName }>
> = {
  FREE: { tone: 'success', icon: 'check' },
  OCCUPIED: { tone: 'info', icon: 'seated' },
  BILL_REQUESTED: { tone: 'warning', icon: 'bell' },
  BILL_PRINTED: { tone: 'neutral', icon: 'receipt' },
};

export interface TableTileProps {
  /** The table's label, e.g. "T4" or "Terrace 2". */
  label: string;
  state: TableState;
  /** The state's name from the i18n catalogue, e.g. "Occupied". */
  stateLabel: string;
  /** Short facts, already worded by the app, e.g. "4 guests", "25 min", "Ravi". */
  details?: readonly string[];
  /** Billable amount so far (TBL-007); omitted for a free table. */
  amountSoFar?: Paise;
  /** Something waiting for staff (approvals, service requests), e.g. "2 to approve". */
  alert?: string;
  onPress?: () => void;
  testID?: string;
}

/**
 * One table on the waiter app's floor (WTR-002, TBL-007): a large touch target (NFR-U03) with its
 * label, state, guests, time seated, waiter and anything waiting. Its accessible name reads the
 * same facts in order, as the web tile does.
 */
export function TableTile({
  label,
  state,
  stateLabel,
  details = [],
  amountSoFar,
  alert,
  onPress,
  testID,
}: TableTileProps) {
  const { colors } = useTheme();
  const style = TABLE_STATE_STYLES[state];
  const tone = toneColors(colors, style.tone);
  const warning = toneColors(colors, 'warning');
  const spoken = [
    label,
    stateLabel,
    ...details,
    ...(amountSoFar === undefined ? [] : [formatRupees(amountSoFar)]),
    ...(alert === undefined ? [] : [alert]),
  ];
  const content = (
    <>
      <View style={styles.top}>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        <View style={[styles.state, { backgroundColor: tone.subtle }]}>
          <Glyph name={style.icon} color={tone.text} size={fontSize.sm} />
          <Text style={[styles.stateText, { color: tone.text }]}>{stateLabel}</Text>
        </View>
      </View>
      {details.length > 0 ? (
        <Text style={[styles.details, { color: colors.textMuted }]}>{details.join(' · ')}</Text>
      ) : null}
      {amountSoFar === undefined ? null : <Money paise={amountSoFar} strong />}
      {alert === undefined ? null : (
        <View style={[styles.alert, { backgroundColor: warning.subtle }]}>
          <Glyph name="bell" color={warning.text} size={fontSize.sm} />
          <Text style={{ color: warning.text, fontSize: fontSize.sm }}>{alert}</Text>
        </View>
      )}
    </>
  );
  const frame = {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderLeftColor: tone.solid,
  };
  // Without an action it is a summary (e.g. at the top of the table's sheet), not a button.
  if (onPress === undefined) {
    return (
      <View
        accessible
        accessibilityLabel={spoken.join(', ')}
        testID={testID}
        style={[styles.tile, frame]}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken.join(', ')}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.tile, frame, { opacity: pressed ? 0.8 : 1 }]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: spacing[3],
    gap: spacing[1],
  },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.bold) },
  state: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.full,
  },
  stateText: { fontSize: fontSize.sm, fontWeight: weight(fontWeight.semibold) },
  details: { fontSize: fontSize.md },
  alert: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.sm,
  },
});
