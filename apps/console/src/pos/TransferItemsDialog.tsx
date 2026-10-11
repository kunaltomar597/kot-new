import type { OrderView, TableOverviewEntry } from '@rp/contracts';
import { formatRupees, isBillable } from '@rp/domain';
import {
  Button,
  ChoiceGroup,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  useToast,
} from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';

/** Whole lines still on the order: a combo moves with its parts, never a part alone. */
function movableLines(orders: readonly OrderView[]) {
  return orders.flatMap((order) =>
    order.items.filter(
      (item) =>
        item.parentOrderItemId === null && (isBillable(item.state) || item.state === 'HELD'),
    ),
  );
}

/**
 * Move dishes to another open table's bill (TBL-006): whole lines, chosen from the table's
 * orders. The server refuses dishes on a printed bill or with a discount, and says why.
 */
export function TransferItemsDialog({
  table,
  openTables,
  onClose,
  onMoved,
}: {
  table: TableOverviewEntry;
  /** Other open tables without a printed bill. */
  openTables: readonly TableOverviewEntry[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const sessionId = table.session?.id ?? '';
  const { data, reload } = useLive(
    async () => (await controller.api.listSessionOrders({ params: { sessionId } })).orders,
    (type) => /^(Order|ItemStatusChanged$)/.test(type),
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const [to, setTo] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const target = openTables.find((other) => other.tableId === to[0]);
  const move = async () => {
    if (target?.session === undefined || target.session === null) return;
    setWorking(true);
    setError(undefined);
    try {
      const result = await controller.api.transferItems({
        params: { sessionId },
        body: { toTableSessionId: target.session.id, orderItemIds: chosen },
      });
      toast.show({
        title: t('pos.transfer.moved', { count: chosen.length, to: result.to.tableLabel }),
        tone: 'success',
      });
      onMoved();
    } catch (failure) {
      setError(messageOf(failure, t));
      setWorking(false);
    }
  };

  let content;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const lines = movableLines(data.value);
    content =
      lines.length === 0 ? (
        <EmptyState title={t('pos.transfer.noDishes')} />
      ) : (
        <>
          <ChoiceGroup
            legend={t('pos.transfer.dishes')}
            mode="multiple"
            options={lines.map((line) => ({
              id: line.id,
              label: t('approvals.line', { quantity: line.quantity, name: line.name }),
              detail: formatRupees(line.lineTotal),
            }))}
            value={chosen}
            onChange={setChosen}
          />
          {openTables.length === 0 ? (
            <EmptyState title={t('pos.transfer.noTable')} />
          ) : (
            <ChoiceGroup
              legend={t('pos.transfer.to')}
              mode="single"
              options={openTables.map((other) => ({
                id: other.tableId,
                label: other.label,
                detail: other.session?.waiterName ?? '',
              }))}
              value={to}
              onChange={setTo}
            />
          )}
        </>
      );
  }

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={!working}
      title={t('pos.transfer.title', { table: table.label })}
      description={t('pos.transfer.description')}
      footer={
        <Button
          loading={working}
          disabled={chosen.length === 0 || target === undefined}
          onClick={() => {
            void move();
          }}
        >
          {t('pos.transfer.submit', { count: chosen.length })}
        </Button>
      }
    >
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
      {content}
    </Dialog>
  );
}
