import { grantOf } from '../app/modes.js';
import type { TableOverviewEntry } from '@rp/contracts';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  TableTile,
  useToast,
} from '@rp/ui-web';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsole, useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useNow } from '../app/use-now.js';
import { useOpenBill } from '../billing/use-open-bill.js';
import { floorSections, tileAlert, tileDetails } from '@rp/ordering';
import { Approvals } from './Approvals.js';
import { MergeTablesDialog } from './MergeTablesDialog.js';
import { MoveTableDialog } from './MoveTableDialog.js';
import { OpenTableDialog } from './OpenTableDialog.js';
import { TransferItemsDialog } from './TransferItemsDialog.js';
import { useFloor } from './use-floor.js';

type Panel =
  | { readonly kind: 'open'; readonly tableId: string }
  | { readonly kind: 'details'; readonly tableId: string }
  | { readonly kind: 'move'; readonly tableId: string }
  | { readonly kind: 'merge'; readonly tableId: string }
  | { readonly kind: 'transfer'; readonly tableId: string };

/**
 * The POS floor (TBL-007): every table by section with its state, guests, time seated, waiter and
 * amount so far, kept live by events. A free table opens (TBL-003); an occupied one shows its
 * details and can move to a free table (TBL-005), merge into another open table or move some of
 * its dishes to one (TBL-006); one waiting to be cleaned can be marked clean (TBL-004).
 */
export function TableOverview() {
  const t = useT();
  const { person } = useConsoleState();
  const { data, reload } = useFloor();
  const now = useNow(30_000);
  const [panel, setPanel] = useState<Panel | undefined>();
  const navigate = useNavigate();

  if (data.status === 'loading') return <LoadingState title={t('states.loading')} />;
  if (data.status === 'error') {
    return (
      <ErrorState
        title={messageOf(data.error, t)}
        action={<Button onClick={reload}>{t('states.retry')}</Button>}
      />
    );
  }

  const sections = floorSections(data.value.floor, data.value.overview);
  const tables = sections.flatMap((section) => section.tables);
  const free = tables.filter((table) => table.state === 'FREE');
  const selected = tables.find((table) => table.tableId === panel?.tableId);
  // Tables a merge or a dish can go to: open, without a printed bill, not this one.
  const others = tables.filter(
    (table) =>
      table.session !== null &&
      table.state !== 'BILL_PRINTED' &&
      table.tableId !== selected?.tableId,
  );
  const canMove = person !== undefined && grantOf(person, 'TABLE_MOVE_MERGE') !== 'DENY';
  const canCloseDay = person !== undefined && grantOf(person, 'DAY_END_CLOSE') !== 'DENY';
  const close = () => {
    setPanel(undefined);
  };
  const done = () => {
    setPanel(undefined);
    reload();
  };

  if (tables.length === 0) return <EmptyState title={t('pos.noTables')} />;

  return (
    <div className="pos-floor">
      <div className="pos-floor__bar">
        <p className="pos-floor__summary">
          {t('pos.summary', { free: free.length, total: tables.length })}
        </p>
        <div className="bill__actions">
          <Button
            variant="secondary"
            onClick={() => {
              void navigate('shift');
            }}
          >
            {t('pos.shift')}
          </Button>
          {canCloseDay ? (
            <Button
              variant="secondary"
              onClick={() => {
                void navigate('day-end');
              }}
            >
              {t('dayEnd.open')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => {
              void navigate('takeaway');
            }}
          >
            {t('pos.takeaway')}
          </Button>
        </div>
      </div>
      <Approvals />
      {sections.map((section) => (
        <section
          key={section.id}
          className="pos-floor__section"
          aria-label={section.name === '' ? t('pos.tables') : section.name}
        >
          {section.name === '' ? null : <h2 className="pos-floor__heading">{section.name}</h2>}
          <div className="pos-floor__tables">
            {section.tables.map((table) => (
              <TableTile
                key={table.tableId}
                label={table.label}
                state={table.state}
                stateLabel={t(`pos.tableState.${table.state}`)}
                details={tileDetails(table, now, t)}
                {...(table.session !== null && { amountSoFar: table.session.amountSoFar })}
                {...(tileAlert(table, t) !== undefined && { alert: tileAlert(table, t) })}
                onSelect={() => {
                  setPanel({
                    kind: table.state === 'FREE' ? 'open' : 'details',
                    tableId: table.tableId,
                  });
                }}
              />
            ))}
          </div>
        </section>
      ))}
      {selected !== undefined && panel?.kind === 'open' && selected.state === 'FREE' ? (
        <OpenTableDialog table={selected} onClose={close} onOpened={done} />
      ) : null}
      {selected !== undefined && panel?.kind === 'details' ? (
        <TableDetails
          table={selected}
          now={now}
          canMove={canMove}
          onClose={close}
          onMove={() => {
            setPanel({ kind: 'move', tableId: selected.tableId });
          }}
          onMerge={() => {
            setPanel({ kind: 'merge', tableId: selected.tableId });
          }}
          onTransfer={() => {
            setPanel({ kind: 'transfer', tableId: selected.tableId });
          }}
          onCleaned={done}
          onTakeOrder={(sessionId) => {
            void navigate(`table/${sessionId}?label=${encodeURIComponent(selected.label)}`);
          }}
        />
      ) : null}
      {selected !== undefined && panel?.kind === 'move' ? (
        <MoveTableDialog table={selected} freeTables={free} onClose={close} onMoved={done} />
      ) : null}
      {selected !== undefined && panel?.kind === 'merge' ? (
        <MergeTablesDialog table={selected} openTables={others} onClose={close} onMerged={done} />
      ) : null}
      {selected !== undefined && panel?.kind === 'transfer' ? (
        <TransferItemsDialog table={selected} openTables={others} onClose={close} onMoved={done} />
      ) : null}
    </div>
  );
}

function TableDetails({
  table,
  now,
  canMove,
  onClose,
  onMove,
  onMerge,
  onTransfer,
  onCleaned,
  onTakeOrder,
}: {
  table: TableOverviewEntry;
  now: number;
  canMove: boolean;
  onClose: () => void;
  onMove: () => void;
  onMerge: () => void;
  onTransfer: () => void;
  onCleaned: () => void;
  onTakeOrder: (sessionId: string) => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const session = table.session;
  const { openBill, opening } = useOpenBill();
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const clean = async () => {
    setCleaning(true);
    setError(undefined);
    try {
      await controller.api.markTableClean({ params: { tableId: table.tableId } });
      toast.show({ title: t('pos.table.cleaned', { table: table.label }), tone: 'success' });
      onCleaned();
    } catch (failure) {
      setError(messageOf(failure, t));
      setCleaning(false);
    }
  };

  let footer = null;
  if (session === null && table.state === 'NEEDS_CLEANING') {
    footer = (
      <Button
        loading={cleaning}
        onClick={() => {
          void clean();
        }}
      >
        {t('pos.table.clean')}
      </Button>
    );
  } else if (session !== null) {
    footer = (
      <>
        {canMove ? (
          <>
            <Button variant="secondary" onClick={onMove}>
              {t('pos.table.move')}
            </Button>
            <Button variant="secondary" onClick={onMerge}>
              {t('pos.table.merge')}
            </Button>
            <Button variant="secondary" onClick={onTransfer}>
              {t('pos.table.transfer')}
            </Button>
          </>
        ) : null}
        <Button
          variant="secondary"
          loading={opening}
          onClick={() => {
            openBill({ tableSessionId: session.id });
          }}
        >
          {t('pos.billTable')}
        </Button>
        <Button
          onClick={() => {
            onTakeOrder(session.id);
          }}
        >
          {t('pos.table.takeOrder')}
        </Button>
      </>
    );
  }
  return (
    <Dialog
      open
      variant="sheet"
      side="end"
      onClose={onClose}
      title={t('pos.table.title', { table: table.label })}
      footer={footer}
    >
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
      <p>{t(`pos.tableState.${table.state}`)}</p>
      {table.state === 'NEEDS_CLEANING' ? <p>{t('pos.table.needsCleaning')}</p> : null}
      {session === null ? null : (
        <>
          <p>{tileDetails(table, now, t).slice(0, 2).join(' · ')}</p>
          <p>{t('pos.table.waiter', { name: session.waiterName })}</p>
          <Money paise={session.amountSoFar} size="lg" strong />
        </>
      )}
    </Dialog>
  );
}
