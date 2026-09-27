import type { TableOverviewEntry } from '@rp/contracts';
import { fontSize, radius, spacing } from '@rp/design-tokens';
import {
  messageOf,
  Note,
  Screen,
  useDeviceSession,
  useLive,
  useSessionState,
  useT,
} from '@rp/mobile-shell';
import { Button, useTheme } from '@rp/ui-native';
import { StyleSheet, Text, View } from 'react-native';

/** Events that change the table overview (as on the POS floor). */
export function affectsTables(eventType: string): boolean {
  return /^(Table|Order|Bill|ServiceRequest|ItemStatusChanged$)/.test(eventType);
}

function TableRow({ table }: { table: TableOverviewEntry }) {
  const t = useT();
  const { colors } = useTheme();
  const state = t(`pos.tableState.${table.state}`);
  const details = [
    state,
    ...(table.session === null
      ? []
      : [t('pos.guests', { count: table.session.covers }), table.session.waiterName]),
  ].join(' · ');
  return (
    <View
      accessible
      accessibilityLabel={`${table.label}, ${details}`}
      testID={`table-${table.tableId}`}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Text style={[styles.label, { color: colors.text }]}>{table.label}</Text>
      <Text style={{ color: colors.textMuted }}>{details}</Text>
    </View>
  );
}

/**
 * The first live screen of the waiter app (P2-01c smoke flow): every table with its state, read
 * again when tables, orders or bills change. P2-02 turns it into "My tables" with order taking.
 */
export function WaiterHome() {
  const session = useDeviceSession();
  const { person } = useSessionState();
  const t = useT();
  const { data, reload } = useLive(() => session.api.getTableOverview(), affectsTables);
  return (
    <Screen
      title={t('mobile.tables.title')}
      actions={
        <Button variant="ghost" onPress={() => void session.signOut()}>
          {t('login.signOut')}
        </Button>
      }
    >
      {person !== undefined && <Note>{t('mobile.signedInAs', { name: person.displayName })}</Note>}
      {data.status === 'loading' && <Note>{t('states.loading')}</Note>}
      {data.status === 'error' && (
        <>
          <Note tone="danger">{messageOf(data.error, t)}</Note>
          <Button variant="secondary" onPress={reload}>
            {t('states.retry')}
          </Button>
        </>
      )}
      {data.status === 'ready' &&
        (data.value.tables.length === 0 ? (
          <Note>{t('mobile.tables.empty')}</Note>
        ) : (
          <View style={styles.list}>
            {data.value.tables.map((table) => (
              <TableRow key={table.tableId} table={table} />
            ))}
          </View>
        ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[2] },
  row: {
    minHeight: 56,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing[3],
    gap: spacing[1],
  },
  label: { fontSize: fontSize.lg },
});
