import type { TableOverviewEntry } from '@rp/contracts';
import { fontSize, fontWeight, spacing } from '@rp/design-tokens';
import {
  messageOf,
  Note,
  Screen,
  useDeviceSession,
  useLive,
  useNow,
  useSessionState,
  useT,
} from '@rp/mobile-shell';
import {
  affectsFloor,
  floorSections,
  freeTables,
  myTableIds,
  tileAlert,
  tileDetails,
} from '@rp/ordering';
import { Button, SegmentedControl, TableTile, useTheme, useToast, weight } from '@rp/ui-native';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PagerCard } from './PagerCard';
import { TableSheet } from './TableSheet';

type TablesView = 'mine' | 'all';

/** Seated times on the tiles move on every half minute. */
const CLOCK_MS = 30_000;

/**
 * The waiter app's home (WTR-002): "My tables" (the waiter's sections and tables for today, and
 * any table they are responsible for) or all tables, grouped by section, each with its state,
 * guests, time seated, waiter and anything waiting for staff; the waiter's pager (WTR-014); and a
 * table's actions on a tap. Read again after table, order, bill and service-request events.
 */
export function TablesScreen() {
  const session = useDeviceSession();
  const { person } = useSessionState();
  const t = useT();
  const { colors } = useTheme();
  const toast = useToast();
  const now = useNow(CLOCK_MS);
  const [view, setView] = useState<TablesView>(person?.role === 'WAITER' ? 'mine' : 'all');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const { data, reload } = useLive(async () => {
    const [overview, assignments, floor] = await Promise.all([
      session.api.getTableOverview(),
      session.api.getWaiterAssignments(),
      session.api.getFloor(),
    ]);
    return { overview, assignments: assignments.current.assignments, floor };
  }, affectsFloor);

  const shown = useMemo(() => {
    if (data.status !== 'ready' || person === undefined) return undefined;
    const { overview, assignments, floor } = data.value;
    const sections = floorSections(floor, overview);
    if (view === 'all') return sections;
    const mine = myTableIds(person.id, overview, assignments);
    return sections
      .map((section) => ({
        ...section,
        tables: section.tables.filter((table) => mine.has(table.tableId)),
      }))
      .filter((section) => section.tables.length > 0);
  }, [data, person, view]);

  if (person === undefined) return null;
  const noneMine =
    view === 'mine' &&
    shown?.length === 0 &&
    data.status === 'ready' &&
    data.value.overview.tables.length > 0;
  const selected: TableOverviewEntry | undefined =
    data.status === 'ready' && selectedId !== undefined
      ? data.value.overview.tables.find((table) => table.tableId === selectedId)
      : undefined;

  return (
    <Screen
      title={t('mobile.tables.title')}
      actions={
        <Button variant="ghost" onPress={() => void session.signOut()}>
          {t('login.signOut')}
        </Button>
      }
    >
      <Note>{t('mobile.signedInAs', { name: person.displayName })}</Note>
      <PagerCard />
      <SegmentedControl
        label={t('mobile.tables.view')}
        options={[
          { id: 'mine', label: t('mobile.tables.mine') },
          { id: 'all', label: t('mobile.tables.all') },
        ]}
        value={view}
        onChange={(next) => {
          setView(next === 'all' ? 'all' : 'mine');
        }}
      />
      {data.status === 'loading' && <Note>{t('states.loading')}</Note>}
      {data.status === 'error' && (
        <>
          <Note tone="danger">{messageOf(data.error, t)}</Note>
          <Button variant="secondary" onPress={reload}>
            {t('states.retry')}
          </Button>
        </>
      )}
      {data.status === 'ready' && data.value.overview.tables.length === 0 && (
        <Note>{t('mobile.tables.empty')}</Note>
      )}
      {noneMine && <Note>{t('mobile.tables.noneMine')}</Note>}
      {shown?.map((section) => (
        <View key={section.id} style={styles.section}>
          {section.name === '' ? null : (
            <Text accessibilityRole="header" style={[styles.sectionName, { color: colors.text }]}>
              {section.name}
            </Text>
          )}
          {section.tables.map((table) => {
            const alert = tileAlert(table, t);
            return (
              <TableTile
                key={table.tableId}
                label={table.label}
                state={table.state}
                stateLabel={t(`pos.tableState.${table.state}`)}
                details={tileDetails(table, now, t)}
                {...(alert !== undefined && { alert })}
                testID={`table-${table.tableId}`}
                onPress={() => {
                  setSelectedId(table.tableId);
                }}
              />
            );
          })}
        </View>
      ))}
      {selected !== undefined && data.status === 'ready' ? (
        <TableSheet
          key={`${selected.tableId}:${selected.session?.id ?? 'free'}`}
          table={selected}
          freeTables={freeTables(data.value.overview)}
          person={person}
          now={now}
          onClose={() => {
            setSelectedId(undefined);
          }}
          onDone={(message) => {
            setSelectedId(undefined);
            toast.show({ title: message, tone: 'success' });
            reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[2] },
  sectionName: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
});
