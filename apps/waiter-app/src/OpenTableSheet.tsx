import type { TableOverviewEntry, TableSessionView } from '@rp/contracts';
import { messageOf, Note, useDeviceSession, useT } from '@rp/mobile-shell';
import { Button, QuantityStepper, Sheet } from '@rp/ui-native';
import { useState } from 'react';

/** Guests a new table starts with; the waiter changes it with the stepper. */
const DEFAULT_COVERS = 2;

/**
 * Opens a free table with its guests (TBL-003); the waiter then lands on the table to take the
 * order. The server decides: when another device opened it first, its answer is shown here.
 */
export function OpenTableSheet({
  table,
  onClose,
  onOpened,
}: {
  table: TableOverviewEntry;
  onClose: () => void;
  onOpened: (opened: TableSessionView) => void;
}) {
  const session = useDeviceSession();
  const t = useT();
  const [covers, setCovers] = useState(DEFAULT_COVERS);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const open = () => {
    setBusy(true);
    setError(undefined);
    session.api.openTable({ params: { tableId: table.tableId }, body: { covers } }).then(
      (opened) => {
        setBusy(false);
        onOpened(opened);
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
      title={t('pos.open.title', { table: table.label })}
      footer={
        <Button size="lg" fullWidth loading={busy} testID="open-table" onPress={open}>
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
      {error === undefined ? null : <Note tone="danger">{error}</Note>}
    </Sheet>
  );
}
