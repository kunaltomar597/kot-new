import type { TableOverviewEntry } from '@rp/contracts';
import { Dialog, EmptyState, TableTile, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

/**
 * Move guests to a free table (TBL-005). The server moves the session, its orders and kitchen
 * tickets (updated in place, never printed again as new tickets) and resets the tablets.
 */
export function MoveTableDialog({
  table,
  freeTables,
  onClose,
  onMoved,
}: {
  table: TableOverviewEntry;
  freeTables: readonly TableOverviewEntry[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [working, setWorking] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const sessionId = table.session?.id;

  const move = async (to: TableOverviewEntry) => {
    if (sessionId === undefined) return;
    setWorking(to.tableId);
    setError(undefined);
    try {
      await controller.api.moveTable({
        params: { sessionId },
        body: { toTableId: to.tableId },
      });
      toast.show({
        title: t('pos.move.moved', { from: table.label, to: to.label }),
        tone: 'success',
      });
      onMoved();
    } catch (failure) {
      setError(messageOf(failure, t));
      setWorking(undefined);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={working === undefined}
      title={t('pos.move.title', { table: table.label })}
      description={t('pos.move.description')}
    >
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
      {freeTables.length === 0 ? (
        <EmptyState title={t('pos.move.noFreeTable')} />
      ) : (
        <div className="pos-floor__tables">
          {freeTables.map((free) => (
            <TableTile
              key={free.tableId}
              label={free.label}
              state={free.state}
              stateLabel={t(`pos.tableState.${free.state}`)}
              disabled={working !== undefined}
              onSelect={() => {
                void move(free);
              }}
            />
          ))}
        </div>
      )}
    </Dialog>
  );
}
