import type { FloorResponse, SectionView, TableView } from '@rp/contracts';
import type { TablePlace } from '@rp/domain';
import { Badge, Button, EmptyState, ErrorState, LoadingState, useToast } from '@rp/ui-web';
import { type ReactNode, useCallback, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../menu/ReasonDialog.js';
import { SectionDialog, TableDialog } from './FloorDialogs.js';
import { PlanEditor } from './FloorPlan.js';
import {
  activeSections,
  activeTables,
  layoutChanges,
  nextOrder,
  overlapIn,
  planOf,
} from './floor-view.js';

type Open =
  | { readonly kind: 'ADD_SECTION' }
  | { readonly kind: 'EDIT_SECTION' | 'ARCHIVE_SECTION'; readonly section: SectionView }
  | { readonly kind: 'ADD_TABLE'; readonly sectionId: string }
  | { readonly kind: 'EDIT_TABLE' | 'ARCHIVE_TABLE'; readonly table: TableView };

const affectsFloor = (type: string) => type === 'RestaurantChanged' || type === 'TableStateChanged';

/**
 * The floor (TBL-001, ONB-004 step 5): sections and their tables, added, changed, archived and
 * restored here, and the floor plan (S) on which each section's tables are dragged to where they
 * stand. The POS shows the same plan. Every change is the server's, audited.
 */
export function FloorScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(() => controller.api.getFloor(), affectsFloor);
  const [view, setView] = useState<'LIST' | 'PLAN'>('LIST');
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [edited, setEdited] = useState<ReadonlyMap<string, TablePlace>>(new Map());
  const [announcement, setAnnouncement] = useState('');

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** Runs one change in a dialog, says what happened, and reads the floor again. */
  const change = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      toast.show({ title: done, tone: 'success' });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const savePlan = async (floor: FloorResponse) => {
    setBusy(true);
    try {
      await controller.api.saveFloorLayout({ body: { tables: layoutChanges(floor, edited) } });
      setEdited(new Map());
      toast.show({ title: t('floorPage.planEditor.saved'), tone: 'success' });
      reload();
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('floorPage.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else if (data.value.sections.length === 0) {
    content = <EmptyState title={t('floorPage.empty')} />;
  } else if (view === 'LIST') {
    content = data.value.sections.map((section) => (
      <SectionCard
        key={section.id}
        section={section}
        onOpen={setOpen}
        onRestoreSection={() => {
          void change(
            () => controller.api.restoreSection({ params: { sectionId: section.id } }),
            t('floorPage.restored', { name: section.name }),
          );
        }}
        onRestoreTable={(table) => {
          void change(
            () => controller.api.restoreTable({ params: { tableId: table.id } }),
            t('floorPage.restored', { name: table.label }),
          );
        }}
      />
    ));
  } else {
    const floor = data.value;
    const changes = layoutChanges(floor, edited);
    const clashes = activeSections(floor).flatMap((section) => {
      const clash = overlapIn(section, edited);
      return clash === undefined ? [] : [clash];
    });
    content = (
      <>
        <p className="dashboard-section__hint">{t('floorPage.planEditor.intro')}</p>
        {activeSections(floor).map((section) => {
          const { places, unplaced } = planOf(section, edited);
          return (
            <section
              key={section.id}
              className="device-group"
              aria-labelledby={`plan-${section.id}`}
            >
              <h3 id={`plan-${section.id}`} className="device-group__heading">
                {section.name}
              </h3>
              {activeTables(section).length === 0 ? (
                <p className="dashboard-section__hint">{t('floorPage.emptySection')}</p>
              ) : (
                <PlanEditor
                  section={section}
                  places={places}
                  onChange={(tableId, place) => {
                    setEdited((current) => new Map(current).set(tableId, place));
                  }}
                  onAnnounce={setAnnouncement}
                />
              )}
              {unplaced.length === 0 ? null : (
                <p className="dashboard-section__hint">
                  {t('floorPage.planEditor.unplaced', {
                    list: unplaced.map((table) => table.label).join(', '),
                  })}
                </p>
              )}
            </section>
          );
        })}
        {clashes.map(([a, b]) => (
          <p key={`${a}-${b}`} role="alert" className="console-notice console-notice--danger">
            {t('floorPage.planEditor.overlap', { a, b })}
          </p>
        ))}
        {changes.length === 0 ? null : (
          <p className="console-notice" role="status">
            {t('floorPage.planEditor.unsaved')}
          </p>
        )}
        <div className="bill__actions">
          <Button
            loading={busy}
            disabled={changes.length === 0 || clashes.length > 0}
            onClick={() => {
              void savePlan(floor);
            }}
          >
            {t('floorPage.planEditor.save')}
          </Button>
          <Button
            variant="secondary"
            disabled={edited.size === 0 || busy}
            onClick={() => {
              setEdited(new Map());
            }}
          >
            {t('floorPage.planEditor.reset')}
          </Button>
        </div>
        <p className="rp-visually-hidden" aria-live="polite">
          {announcement}
        </p>
      </>
    );
  }

  const sections = data.status === 'ready' ? activeSections(data.value) : [];
  let dialog: ReactNode = null;
  if (open !== undefined) {
    switch (open.kind) {
      case 'ADD_SECTION':
      case 'EDIT_SECTION': {
        const section = open.kind === 'EDIT_SECTION' ? open.section : undefined;
        dialog = (
          <SectionDialog
            section={section}
            nextOrder={nextOrder(data.status === 'ready' ? data.value.sections : [])}
            busy={busy}
            error={error}
            onClose={close}
            onSave={(body) => {
              void change(
                () =>
                  section === undefined
                    ? controller.api.createSection({ body })
                    : controller.api.updateSection({ params: { sectionId: section.id }, body }),
                t('floorPage.saved', { name: body.name }),
              );
            }}
          />
        );
        break;
      }
      case 'ADD_TABLE':
      case 'EDIT_TABLE': {
        const table = open.kind === 'EDIT_TABLE' ? open.table : undefined;
        const sectionId = open.kind === 'ADD_TABLE' ? open.sectionId : open.table.sectionId;
        const inSection = sections.find((section) => section.id === sectionId)?.tables ?? [];
        dialog = (
          <TableDialog
            table={table}
            sectionId={sectionId}
            sections={sections}
            nextOrder={nextOrder(inSection)}
            busy={busy}
            error={error}
            onClose={close}
            onSave={(body) => {
              void change(
                () =>
                  table === undefined
                    ? controller.api.createTable({ body })
                    : controller.api.updateTable({ params: { tableId: table.id }, body }),
                t('floorPage.saved', { name: body.label }),
              );
            }}
          />
        );
        break;
      }
      case 'ARCHIVE_SECTION':
      case 'ARCHIVE_TABLE': {
        const target = 'section' in open ? open.section : open.table;
        const isSection = 'section' in open;
        const name = 'section' in open ? open.section.name : open.table.label;
        dialog = (
          <ReasonDialog
            title={
              isSection
                ? t('floorPage.archiveSection.title', { name })
                : t('floorPage.archiveTable.title', { label: name })
            }
            description={
              isSection
                ? t('floorPage.archiveSection.description')
                : t('floorPage.archiveTable.description')
            }
            confirmLabel={t('floorPage.archive')}
            hint={t('floorPage.reasonHint')}
            busy={busy}
            error={error}
            onConfirm={(reason) => {
              void change(
                () =>
                  isSection
                    ? controller.api.archiveSection({
                        params: { sectionId: target.id },
                        body: { reason },
                      })
                    : controller.api.archiveTable({
                        params: { tableId: target.id },
                        body: { reason },
                      }),
                t('floorPage.archived', { name }),
              );
            }}
            onCancel={close}
          />
        );
        break;
      }
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-floor">
      <div className="staff-header">
        <h2 id="dashboard-floor" className="dashboard-section__heading">
          {t('floorPage.title')}
        </h2>
        <Button
          onClick={() => {
            setOpen({ kind: 'ADD_SECTION' });
          }}
        >
          {t('floorPage.addSection')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('floorPage.intro')}</p>
      <div className="bill__actions" role="group" aria-label={t('floorPage.view')}>
        {(['LIST', 'PLAN'] as const).map((choice) => (
          <Button
            key={choice}
            variant={view === choice ? 'primary' : 'secondary'}
            aria-pressed={view === choice}
            onClick={() => {
              setView(choice);
            }}
          >
            {choice === 'LIST' ? t('floorPage.list') : t('floorPage.plan')}
          </Button>
        ))}
      </div>
      {content}
      {dialog}
    </section>
  );
}

function SectionCard({
  section,
  onOpen,
  onRestoreSection,
  onRestoreTable,
}: {
  section: SectionView;
  onOpen: (open: Open) => void;
  onRestoreSection: () => void;
  onRestoreTable: (table: TableView) => void;
}) {
  const t = useT();
  const archived = section.archivedAt !== null;
  const headingId = `floor-${section.id}`;
  return (
    <section className="device-group" aria-labelledby={headingId}>
      <div className="staff-header">
        <h3 id={headingId} className="device-group__heading">
          {section.name}{' '}
          {archived ? <Badge tone="neutral">{t('floorPage.archivedBadge')}</Badge> : null}
        </h3>
        <div
          className="staff-row__actions"
          role="group"
          aria-label={t('floorPage.sectionActions', { name: section.name })}
        >
          {archived ? (
            <Button variant="secondary" onClick={onRestoreSection}>
              {t('floorPage.restore')}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  onOpen({ kind: 'ADD_TABLE', sectionId: section.id });
                }}
              >
                {t('floorPage.addTable')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  onOpen({ kind: 'EDIT_SECTION', section });
                }}
              >
                {t('floorPage.edit')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  onOpen({ kind: 'ARCHIVE_SECTION', section });
                }}
              >
                {t('floorPage.archive')}
              </Button>
            </>
          )}
        </div>
      </div>
      {section.tables.length === 0 ? (
        <p className="dashboard-section__hint">{t('floorPage.emptySection')}</p>
      ) : (
        <ul className="staff-list" aria-labelledby={headingId}>
          {section.tables.map((table) => (
            <li key={table.id} className="staff-row">
              <div className="staff-row__who">
                <h4 className="staff-row__name">{table.label}</h4>
                <p className="staff-row__role">
                  {t('floorPage.tableFacts', {
                    count: table.capacity,
                    state: t(`pos.tableState.${table.state}`),
                  })}
                </p>
                <p className="staff-row__states">
                  {table.archivedAt === null ? null : (
                    <Badge tone="neutral">{t('floorPage.archivedBadge')}</Badge>
                  )}
                  {table.tabletDeviceIds.length === 0 ? null : (
                    <Badge tone="info">
                      {t('floorPage.tabletBadge', { count: table.tabletDeviceIds.length })}
                    </Badge>
                  )}
                </p>
              </div>
              <div
                className="staff-row__actions"
                role="group"
                aria-label={t('floorPage.tableActions', { label: table.label })}
              >
                {table.archivedAt !== null ? (
                  archived ? null : (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        onRestoreTable(table);
                      }}
                    >
                      {t('floorPage.restore')}
                    </Button>
                  )
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        onOpen({ kind: 'EDIT_TABLE', table });
                      }}
                    >
                      {t('floorPage.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        onOpen({ kind: 'ARCHIVE_TABLE', table });
                      }}
                    >
                      {t('floorPage.archive')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
