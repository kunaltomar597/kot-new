import type { StaffTile, TableOverviewEntry } from '@rp/contracts';
import { Button, Dialog, NumberPad, Select, TextField, useToast } from '@rp/ui-web';
import { useEffect, useId, useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

/**
 * Seat guests at a free table (TBL-003): the number of guests and, optionally, a waiter other than
 * the one assigned to the table (TBL-002; the server applies the assignment when none is chosen).
 */
export function OpenTableDialog({
  table,
  onClose,
  onOpened,
}: {
  table: TableOverviewEntry;
  onClose: () => void;
  onOpened: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [guests, setGuests] = useState('');
  const [waiterId, setWaiterId] = useState('');
  const [waiters, setWaiters] = useState<StaffTile[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [working, setWorking] = useState(false);
  const formId = useId();

  useEffect(() => {
    let active = true;
    controller.staffTiles().then(
      (staff) => {
        if (active) setWaiters(staff.filter((person) => person.role === 'WAITER'));
      },
      () => {
        // The waiter list is optional: without it the table goes to its assigned waiter.
      },
    );
    return () => {
      active = false;
    };
  }, [controller]);

  const submit = async () => {
    const covers = Number(guests);
    if (!Number.isInteger(covers) || covers < 1 || covers > 99) {
      setError(t('pos.open.invalidGuests'));
      return;
    }
    setWorking(true);
    setError(undefined);
    try {
      await controller.api.openTable({
        params: { tableId: table.tableId },
        body: { covers, ...(waiterId !== '' && { waiterId }) },
      });
      toast.show({ title: t('pos.open.opened', { table: table.label }), tone: 'success' });
      onOpened();
    } catch (failure) {
      setError(messageOf(failure, t));
      setWorking(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!working}
      title={t('pos.open.title', { table: table.label })}
      footer={
        <Button type="submit" form={formId} loading={working}>
          {t('pos.open.submit')}
        </Button>
      }
    >
      <form
        id={formId}
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t('pos.open.guests')}
          inputMode="numeric"
          value={guests}
          onChange={(event) => {
            setGuests(event.target.value.replace(/\D/g, '').slice(0, 2));
          }}
          error={error}
          data-autofocus
        />
        <NumberPad
          label={t('pos.open.guestsPad')}
          value={guests}
          maxLength={2}
          onChange={setGuests}
          disabled={working}
        />
        {waiters.length > 0 ? (
          <Select
            label={t('pos.open.waiter')}
            value={waiterId}
            onChange={(event) => {
              setWaiterId(event.target.value);
            }}
            options={[
              { value: '', label: t('pos.open.assignedWaiter') },
              ...waiters.map((waiter) => ({ value: waiter.staffId, label: waiter.displayName })),
            ]}
          />
        ) : null}
      </form>
    </Dialog>
  );
}
