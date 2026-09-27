import type { TableOverviewEntry } from '@rp/contracts';
import { spacing } from '@rp/design-tokens';
import { grantFor, type Role } from '@rp/domain';
import { messageOf, Note, useDeviceSession, useT } from '@rp/mobile-shell';
import { Button, Sheet, TableTile } from '@rp/ui-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

/** Whether this person may move this table: managers any, waiters their own (TBL-005). */
export function mayMove(
  table: TableOverviewEntry,
  person: { readonly id: string; readonly role: Role },
): boolean {
  const grant = grantFor(person.role, 'TABLE_MOVE_MERGE');
  return grant === 'ALLOW' || (grant === 'OWN' && table.session?.waiterId === person.id);
}

/**
 * Moves the guests of an open table to a free one (TBL-005); their orders and kitchen tickets go
 * with them. The server decides; its refusal is shown here and nothing changes.
 */
export function MoveSheet({
  table,
  sessionId,
  freeTables,
  onClose,
  onMoved,
}: {
  table: TableOverviewEntry;
  sessionId: string;
  freeTables: readonly TableOverviewEntry[];
  onClose: () => void;
  onMoved: (message: string) => void;
}) {
  const session = useDeviceSession();
  const t = useT();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const move = (target: TableOverviewEntry) => {
    setBusy(true);
    setError(undefined);
    session.api.moveTable({ params: { sessionId }, body: { toTableId: target.tableId } }).then(
      () => {
        setBusy(false);
        onMoved(t('mobile.tables.moved', { from: table.label, to: target.label }));
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure, t));
      },
    );
  };

  return (
    <Sheet
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('mobile.tables.moveTo', { table: table.label })}
      footer={
        <Button variant="secondary" fullWidth disabled={busy} onPress={onClose}>
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
                move(target);
              },
            })}
          />
        ))}
      </View>
      {error === undefined ? null : <Note tone="danger">{error}</Note>}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[2] },
});
