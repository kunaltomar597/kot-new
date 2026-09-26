import type { TableOverviewEntry } from '@rp/contracts';
import { grantFor } from '@rp/domain';
import { Button, Dialog, EmptyState, ErrorState, LoadingState, Money, TableTile } from '@rp/ui-web';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useNow } from '../app/use-now.js';
import { floorSections, tileAlert, tileDetails } from './floor-view.js';
import { MoveTableDialog } from './MoveTableDialog.js';
import { OpenTableDialog } from './OpenTableDialog.js';
import { useFloor } from './use-floor.js';

type Panel =
  | { readonly kind: 'open'; readonly tableId: string }
  | { readonly kind: 'details'; readonly tableId: string }
  | { readonly kind: 'move'; readonly tableId: string };

/**
 * The POS floor (TBL-007): every table by section with its state, guests, time seated, waiter and
 * amount so far, kept live by events. A free table opens (TBL-003); an occupied one shows its
 * details and can move to a free table (TBL-005).
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
  const canMove = person !== undefined && grantFor(person.role, 'TABLE_MOVE_MERGE') !== 'DENY';
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
        <Button
          variant="secondary"
          onClick={() => {
            void navigate('takeaway');
          }}
        >
          {t('pos.takeaway')}
        </Button>
      </div>
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
          onTakeOrder={(sessionId) => {
            void navigate(`table/${sessionId}?label=${encodeURIComponent(selected.label)}`);
          }}
        />
      ) : null}
      {selected !== undefined && panel?.kind === 'move' ? (
        <MoveTableDialog table={selected} freeTables={free} onClose={close} onMoved={done} />
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
  onTakeOrder,
}: {
  table: TableOverviewEntry;
  now: number;
  canMove: boolean;
  onClose: () => void;
  onMove: () => void;
  onTakeOrder: (sessionId: string) => void;
}) {
  const t = useT();
  const session = table.session;
  return (
    <Dialog
      open
      variant="sheet"
      side="end"
      onClose={onClose}
      title={t('pos.table.title', { table: table.label })}
      footer={
        session === null ? null : (
          <>
            {canMove ? (
              <Button variant="secondary" onClick={onMove}>
                {t('pos.table.move')}
              </Button>
            ) : null}
            <Button
              onClick={() => {
                onTakeOrder(session.id);
              }}
            >
              {t('pos.table.takeOrder')}
            </Button>
          </>
        )
      }
    >
      <p>{t(`pos.tableState.${table.state}`)}</p>
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
