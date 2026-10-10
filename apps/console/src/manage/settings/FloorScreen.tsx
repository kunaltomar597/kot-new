import type { SectionView, TableView } from '@rp/contracts';
import { Badge, Button, EmptyState, ErrorState, Icon, LoadingState, useToast } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { SectionDialog, TableDialog } from './FloorDialogs.js';
import { type FloorSection, floorSections } from './floor-view.js';

/** Setup changes (the floor, a tablet paired or moved) and guests coming and going. */
const AFFECTS = new Set([
  'RestaurantChanged',
  'TableOpened',
  'TableClosed',
  'TableStateChanged',
  'TableMoved',
]);

type Open =
  | { readonly kind: 'ADD_SECTION' }
  | { readonly kind: 'EDIT_SECTION' | 'ARCHIVE_SECTION'; readonly section: SectionView }
  | { readonly kind: 'ADD_TABLE'; readonly sectionId: string }
  | { readonly kind: 'EDIT_TABLE' | 'ARCHIVE_TABLE'; readonly table: TableView };

type SectionAction = 'ADD_TABLE' | 'EDIT' | 'ARCHIVE' | 'RESTORE';
type TableAction = 'EDIT' | 'ARCHIVE' | 'RESTORE';

/**
 * The Floor page (P4-03d, TBL-001, ONB-004 step 5): the sections in their order, each with its
 * tables, seats, state and paired tablet. Managers add and change sections and tables, archive
 * them with a reason and restore them; the server refuses to archive a section that still has
 * tables, or a table with guests or a tablet, and says why. Every change is audited by the server
 * and reaches every screen at once (`RestaurantChanged`), this page included.
 */
export function FloorScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    () => controller.api.getFloor(),
    (type) => AFFECTS.has(type),
  );
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  };
  const changed = (title: string) => {
    toast.show({ title, tone: 'success' });
    close();
    reload();
  };
  /** An archive asked for in a dialog: its refusal stays in the dialog. */
  const archive = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      changed(done);
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };
  const restore = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      changed(done);
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
  };

  const onSection = (section: SectionView, action: SectionAction) => {
    switch (action) {
      case 'ADD_TABLE':
        setOpen({ kind: 'ADD_TABLE', sectionId: section.id });
        break;
      case 'EDIT':
        setOpen({ kind: 'EDIT_SECTION', section });
        break;
      case 'ARCHIVE':
        setOpen({ kind: 'ARCHIVE_SECTION', section });
        break;
      case 'RESTORE':
        void restore(
          () => controller.api.restoreSection({ params: { sectionId: section.id } }),
          t('floor.sectionRestored', { name: section.name }),
        );
        break;
    }
  };
  const onTable = (table: TableView, action: TableAction) => {
    switch (action) {
      case 'EDIT':
        setOpen({ kind: 'EDIT_TABLE', table });
        break;
      case 'ARCHIVE':
        setOpen({ kind: 'ARCHIVE_TABLE', table });
        break;
      case 'RESTORE':
        void restore(
          () => controller.api.restoreTable({ params: { tableId: table.id } }),
          t('floor.tableRestored', { table: table.label }),
        );
        break;
    }
  };

  let content: ReactNode;
  let dialog: ReactNode = null;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('floor.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const floor = data.value;
    const sections = floorSections(floor, { archived });
    content = (
      <>
        <div className="staff-header">
          <label className="console-check">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => {
                setArchived(event.target.checked);
              }}
            />
            {t('floor.showArchived')}
          </label>
          <Button
            startIcon={<Icon name="plus" />}
            onClick={() => {
              setOpen({ kind: 'ADD_SECTION' });
            }}
          >
            {t('floor.addSection')}
          </Button>
        </div>
        {sections.length === 0 ? (
          <EmptyState title={t('floor.none')} />
        ) : (
          sections.map((entry) => (
            <SectionBlock
              key={entry.section.id}
              entry={entry}
              onSection={(action) => {
                onSection(entry.section, action);
              }}
              onTable={onTable}
            />
          ))
        )}
      </>
    );
    if (open?.kind === 'ADD_SECTION' || open?.kind === 'EDIT_SECTION') {
      dialog = (
        <SectionDialog
          section={open.kind === 'EDIT_SECTION' ? open.section : undefined}
          floor={floor}
          onSaved={(saved) => {
            changed(t('floor.sectionDialog.saved', { name: saved.name }));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ADD_TABLE' || open?.kind === 'EDIT_TABLE') {
      dialog = (
        <TableDialog
          table={open.kind === 'EDIT_TABLE' ? open.table : undefined}
          sectionId={open.kind === 'ADD_TABLE' ? open.sectionId : undefined}
          floor={floor}
          onSaved={(saved) => {
            changed(t('floor.tableDialog.saved', { table: saved.label }));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ARCHIVE_SECTION') {
      const { section } = open;
      dialog = (
        <ReasonDialog
          title={t('floor.archiveSection.title', { name: section.name })}
          description={t('floor.archiveSection.description')}
          label={t('floor.archiveSection.reason')}
          confirmLabel={t('floor.archiveSection.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void archive(
              () =>
                controller.api.archiveSection({
                  params: { sectionId: section.id },
                  body: { reason },
                }),
              t('floor.sectionArchived', { name: section.name }),
            );
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ARCHIVE_TABLE') {
      const { table } = open;
      dialog = (
        <ReasonDialog
          title={t('floor.archiveTable.title', { table: table.label })}
          description={t('floor.archiveTable.description')}
          label={t('floor.archiveTable.reason')}
          confirmLabel={t('floor.archiveTable.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void archive(
              () =>
                controller.api.archiveTable({ params: { tableId: table.id }, body: { reason } }),
              t('floor.tableArchived', { table: table.label }),
            );
          }}
          onClose={close}
        />
      );
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-floor">
      <h2 id="dashboard-floor" className="dashboard-section__heading">
        {t('floor.title')}
      </h2>
      <p className="dashboard-section__hint">{t('floor.intro')}</p>
      {content}
      {dialog}
    </section>
  );
}

/** One section: its name, active tables and their seats, place, actions, then its tables. */
function SectionBlock({
  entry,
  onSection,
  onTable,
}: {
  entry: FloorSection;
  onSection: (action: SectionAction) => void;
  onTable: (table: TableView, action: TableAction) => void;
}) {
  const t = useT();
  const { section, tables, tableCount, seats } = entry;
  const active = section.archivedAt === null;
  const headingId = `floor-section-${section.id}`;
  const actions: readonly SectionAction[] = active ? ['ADD_TABLE', 'EDIT', 'ARCHIVE'] : ['RESTORE'];
  return (
    <section className="settings-group" aria-labelledby={headingId}>
      <div className="staff-header">
        <div className="staff-row__who">
          <h3 id={headingId} className="staff-row__name">
            {section.name}
            {active ? null : <Badge tone="neutral">{t('floor.section.archived')}</Badge>}
          </h3>
          <p className="staff-row__contact menu-facts">
            {tableCount === 0 ? null : (
              <>
                <span>{t('floor.section.tables', { count: tableCount })}</span>
                <span>{t('floor.section.seats', { count: seats })}</span>
              </>
            )}
            <span>{t('floor.section.place', { order: section.displayOrder })}</span>
          </p>
        </div>
        <div
          className="staff-row__actions"
          role="group"
          aria-label={t('floor.section.actionsFor', { name: section.name })}
        >
          {actions.map((action) => (
            <Button
              key={action}
              variant="secondary"
              startIcon={action === 'ADD_TABLE' ? <Icon name="plus" /> : undefined}
              onClick={() => {
                onSection(action);
              }}
            >
              {t(SECTION_ACTION_LABELS[action])}
            </Button>
          ))}
        </div>
      </div>
      {tables.length === 0 ? (
        <p className="dashboard-section__hint">{t('floor.section.noTables')}</p>
      ) : (
        <ul className="staff-list">
          {tables.map((table) => (
            <TableRow
              key={table.id}
              table={table}
              onAction={(action) => {
                onTable(table, action);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const SECTION_ACTION_LABELS = {
  ADD_TABLE: 'floor.section.addTable',
  EDIT: 'floor.section.edit',
  ARCHIVE: 'floor.section.archive',
  RESTORE: 'floor.section.restore',
} as const;

const TABLE_ACTION_LABELS = {
  EDIT: 'floor.table.edit',
  ARCHIVE: 'floor.table.archive',
  RESTORE: 'floor.table.restore',
} as const;

/** One table: its label, seats and place, whether guests are seated and a tablet is paired. */
function TableRow({
  table,
  onAction,
}: {
  table: TableView;
  onAction: (action: TableAction) => void;
}) {
  const t = useT();
  const active = table.archivedAt === null;
  const actions: readonly TableAction[] = active ? ['EDIT', 'ARCHIVE'] : ['RESTORE'];
  return (
    <li className="staff-row" data-inactive={active ? undefined : true}>
      <div className="staff-row__who">
        <h4 className="staff-row__name">
          {t('floor.table.name', { table: table.label })}
          {active ? null : <Badge tone="neutral">{t('floor.table.archived')}</Badge>}
        </h4>
        <p className="staff-row__contact menu-facts">
          <span>{t('floor.table.seats', { count: table.capacity })}</span>
          <span>{t('floor.table.place', { order: table.displayOrder })}</span>
        </p>
        {active ? (
          <p className="staff-row__states">
            <Badge tone={table.state === 'FREE' ? 'neutral' : 'info'}>
              {t(`pos.tableState.${table.state}`)}
            </Badge>
            {table.tabletDeviceIds.length === 0 ? null : (
              <Badge tone="neutral">{t('floor.table.tablet')}</Badge>
            )}
          </p>
        ) : null}
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('floor.table.actionsFor', { table: table.label })}
      >
        {actions.map((action) => (
          <Button
            key={action}
            variant="secondary"
            onClick={() => {
              onAction(action);
            }}
          >
            {t(TABLE_ACTION_LABELS[action])}
          </Button>
        ))}
      </div>
    </li>
  );
}
