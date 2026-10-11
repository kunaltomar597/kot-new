import type { TableOverviewEntry } from '@rp/contracts';
import { Dialog, EmptyState, TableTile, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

/**
 * Merge a table into another open one, for one bill (TBL-006). The server moves its orders,
 * kitchen tickets, guests and open requests over and closes its session; its tablet resets.
 */
export function MergeTablesDialog({
  table,
  openTables,
  onClose,
  onMerged,
}: {
  table: TableOverviewEntry;
  /** Other open tables without a printed bill. */
  openTables: readonly TableOverviewEntry[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [working, setWorking] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const sessionId = table.session?.id;

  const merge = async (into: TableOverviewEntry) => {
    if (sessionId === undefined || into.session === null) return;
    setWorking(into.tableId);
    setError(undefined);
    try {
      await controller.api.mergeTables({
        params: { sessionId },
        body: { intoTableSessionId: into.session.id },
      });
      toast.show({
        title: t('pos.merge.merged', { from: table.label, to: into.label }),
        tone: 'success',
      });
      onMerged();
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
      title={t('pos.merge.title', { table: table.label })}
      description={t('pos.merge.description', { table: table.label })}
    >
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
      {openTables.length === 0 ? (
        <EmptyState title={t('pos.merge.noTable')} />
      ) : (
        <div className="pos-floor__tables">
          {openTables.map((other) => (
            <TableTile
              key={other.tableId}
              label={other.label}
              state={other.state}
              stateLabel={t(`pos.tableState.${other.state}`)}
              {...(other.session !== null && {
                details: [other.session.waiterName],
                amountSoFar: other.session.amountSoFar,
              })}
              disabled={working !== undefined}
              onSelect={() => {
                void merge(other);
              }}
            />
          ))}
        </div>
      )}
    </Dialog>
  );
}
