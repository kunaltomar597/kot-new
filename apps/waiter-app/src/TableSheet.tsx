import type { TableOverviewEntry } from '@rp/contracts';
import { spacing } from '@rp/design-tokens';
import { grantFor, type Role } from '@rp/domain';
import { messageOf, Note, useDeviceSession, useT } from '@rp/mobile-shell';
import { tileAlert, tileDetails } from '@rp/ordering';
import { Button, QuantityStepper, Sheet, TableTile } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

/** Guests a new table starts with; the waiter changes it with the stepper. */
const DEFAULT_COVERS = 2;

export interface TableSheetProps {
  table: TableOverviewEntry;
  /** Where the guests could move to (TBL-005). */
  freeTables: readonly TableOverviewEntry[];
  person: { readonly id: string; readonly role: Role };
  now: number;
  onClose: () => void;
  /** An action succeeded: says what happened, and the screen reads the tables again. */
  onDone: (message: string) => void;
}

/** Whether this person may move this table: managers any, waiters their own (TBL-005). */
export function mayMove(table: TableOverviewEntry, person: TableSheetProps['person']): boolean {
  const grant = grantFor(person.role, 'TABLE_MOVE_MERGE');
  return grant === 'ALLOW' || (grant === 'OWN' && table.session?.waiterId === person.id);
}

/**
 * A table's actions in the waiter app: open a free table with its guests (TBL-003), and for an open
 * one, move it to a free table (TBL-005) or ask for the bill (WTR-008). The server decides; its
 * refusal is shown here and nothing changes.
 */
export function TableSheet({ table, freeTables, person, now, onClose, onDone }: TableSheetProps) {
  const session = useDeviceSession();
  const t = useT();
  const [moving, setMoving] = useState(false);
  const [covers, setCovers] = useState(DEFAULT_COVERS);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    action().then(
      (message) => {
        setBusy(false);
        onDone(message);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure, t));
      },
    );
  };

  const errorNote = error === undefined ? null : <Note tone="danger">{error}</Note>;
  const open = table.session;

  if (open === null) {
    return (
      <Sheet
        open
        onClose={onClose}
        dismissible={!busy}
        title={t('pos.open.title', { table: table.label })}
        footer={
          <Button
            size="lg"
            fullWidth
            loading={busy}
            testID="open-table"
            onPress={() => {
              run(async () => {
                await session.api.openTable({
                  params: { tableId: table.tableId },
                  body: { covers },
                });
                return t('pos.open.opened', { table: table.label });
              });
            }}
          >
            {t('pos.open.submit')}
          </Button>
        }
      >
        <QuantityStepper
          value={covers}
          onChange={setCovers}
          min={1}
          max={99}
          label={t('pos.open.guests')}
          decreaseLabel={t('pos.item.fewer')}
          increaseLabel={t('pos.item.more')}
        />
        {errorNote}
      </Sheet>
    );
  }

  if (moving) {
    return (
      <Sheet
        open
        onClose={onClose}
        dismissible={!busy}
        title={t('mobile.tables.moveTo', { table: table.label })}
        footer={
          <Button
            variant="secondary"
            fullWidth
            disabled={busy}
            onPress={() => {
              setMoving(false);
            }}
          >
            {t('mobile.tables.back')}
          </Button>
        }
      >
        {freeTables.length === 0 ? <Note>{t('mobile.tables.noFreeTables')}</Note> : null}
        <View style={styles.list}>
          {freeTables.map((target) => (
            <TableTile
              key={target.tableId}
              label={target.label}
              state={target.state}
              stateLabel={t(`pos.tableState.${target.state}`)}
              testID={`move-to-${target.tableId}`}
              {...(!busy && {
                onPress: () => {
                  run(async () => {
                    await session.api.moveTable({
                      params: { sessionId: open.id },
                      body: { toTableId: target.tableId },
                    });
                    return t('mobile.tables.moved', { from: table.label, to: target.label });
                  });
                },
              })}
            />
          ))}
        </View>
        {errorNote}
      </Sheet>
    );
  }

  const alert = tileAlert(table, t);
  return (
    <Sheet
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('pos.table.title', { table: table.label })}
    >
      <TableTile
        label={table.label}
        state={table.state}
        stateLabel={t(`pos.tableState.${table.state}`)}
        details={tileDetails(table, now, t)}
        {...(alert !== undefined && { alert })}
      />
      <View style={styles.list}>
        {mayMove(table, person) ? (
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            disabled={busy}
            onPress={() => {
              setError(undefined);
              setMoving(true);
            }}
          >
            {t('pos.table.move')}
          </Button>
        ) : null}
        {table.state === 'OCCUPIED' ? (
          <Button
            size="lg"
            fullWidth
            loading={busy}
            onPress={() => {
              run(async () => {
                await session.api.requestBill({ params: { sessionId: open.id } });
                return t('mobile.tables.billRequested', { table: table.label });
              });
            }}
          >
            {t('mobile.tables.requestBill')}
          </Button>
        ) : null}
      </View>
      {errorNote}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[2] },
});
