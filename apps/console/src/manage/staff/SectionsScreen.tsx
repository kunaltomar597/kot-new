import type { StaffView, WaiterAssignmentsResponse } from '@rp/contracts';
import type { AssignmentScope, PlannedAssignment } from '@rp/domain';
import {
  Button,
  ChoiceGroup,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import {
  type ActiveSection,
  activeFloor,
  assignablePeople,
  dayOf,
  namesOf,
  personDay,
  planOf,
  requestOf,
  sameAsBefore,
  scopeOf,
  uncoveredOf,
  withPlanFor,
} from './sections-view.js';

interface SectionsData {
  readonly assignments: WaiterAssignmentsResponse;
  readonly floor: ActiveSection[];
  readonly people: StaffView[];
  readonly scope: AssignmentScope;
}

/**
 * Today's sections (P4-02b, TBL-002, MGR-004): at shift start the manager gives each waiter their
 * sections, and single tables if needed, or gives the last day's again in one step. The page shows
 * the tables nobody looks after yet, and follows every change made on any screen
 * (`RestaurantChanged`: the floor, the day's assignments and the staff).
 */
export function SectionsScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive<SectionsData>(
    async () => {
      const [assignments, floor, staff] = await Promise.all([
        controller.api.getWaiterAssignments(),
        controller.api.getFloor(),
        controller.api.listStaff(),
      ]);
      const active = activeFloor(floor);
      return {
        assignments,
        floor: active,
        people: assignablePeople(staff.staff),
        scope: scopeOf(staff.staff, active),
      };
    },
    (type) => type === 'RestaurantChanged',
  );
  const [editing, setEditing] = useState<StaffView | undefined>();
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = useCallback(() => {
    setEditing(undefined);
    setReplacing(false);
    setBusy(false);
    setError(undefined);
  }, []);

  if (data.status === 'loading') {
    return (
      <Page>
        <LoadingState title={t('states.loading')} />
      </Page>
    );
  }
  if (data.status === 'error') {
    return (
      <Page>
        <ErrorState
          title={t('sections.loadFailed')}
          description={messageOf(data.error, t)}
          onRetry={reload}
          retryLabel={t('states.retry')}
        />
      </Page>
    );
  }

  const { assignments, floor, people, scope } = data.value;
  const plan = planOf(assignments.current.assignments);
  const today = dayOf(assignments.current.businessDate, t.locale);
  const previous = assignments.previous;
  const earlierDay = previous === null ? undefined : dayOf(previous.businessDate, t.locale);

  /** One person's change, made to the day's plan as the server has it now. */
  const saveFor = async (change: PlannedAssignment, person: StaffView) => {
    setBusy(true);
    setError(undefined);
    try {
      const fresh = await controller.api.getWaiterAssignments();
      const next = withPlanFor(planOf(fresh.current.assignments), change);
      await controller.api.updateWaiterAssignments({ body: requestOf(next, scope) });
      const cleared = change.sectionIds.length + change.tableIds.length === 0;
      toast.show({
        title: t(cleared ? 'sections.cleared' : 'sections.saved', { name: person.displayName }),
        tone: 'success',
      });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  /** "Same as last time": the earlier day's plan, without whoever and whatever is gone. */
  const applyEarlier = async () => {
    if (previous === null || earlierDay === undefined) return;
    const { plan: earlier, leftOut } = sameAsBefore(previous, scope);
    const skipped =
      leftOut.length === 0
        ? undefined
        : t('sections.leftOut', { count: leftOut.length, names: namesOf(leftOut, t.locale) });
    if (earlier.length === 0) {
      toast.show({
        title: t('sections.nothingToApply', { day: earlierDay }),
        description: skipped,
        tone: 'warning',
      });
      close();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.updateWaiterAssignments({ body: requestOf(earlier, scope) });
      toast.show({
        title: t('sections.applied', { day: earlierDay }),
        description: skipped,
        tone: skipped === undefined ? 'success' : 'warning',
      });
      close();
      reload();
    } catch (failure) {
      if (replacing) setError(messageOf(failure, t));
      else toast.show({ title: messageOf(failure, t), tone: 'danger' });
      setBusy(false);
    }
  };

  let content: ReactNode;
  if (floor.every((section) => section.tables.length === 0)) {
    content = <EmptyState title={t('sections.noTables')} />;
  } else if (people.length === 0) {
    content = <EmptyState title={t('sections.noPeople')} />;
  } else {
    const uncovered = uncoveredOf(plan, floor);
    content = (
      <>
        {uncovered.length === 0 ? (
          <p className="sections-covered">
            <Icon name="check" />
            {t('sections.allCovered')}
          </p>
        ) : (
          <div className="console-notice console-notice--warning sections-uncovered">
            <h3 className="sections-uncovered__title">{t('sections.uncovered')}</h3>
            <ul>
              {uncovered.map((gap) => (
                <li key={gap.sectionId}>
                  {gap.tables.length === 0
                    ? t('sections.uncoveredSection', { section: gap.section })
                    : t('sections.uncoveredTables', {
                        section: gap.section,
                        tables: gap.tables.join(', '),
                      })}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul className="staff-list" aria-label={t('sections.people')}>
          {people.map((person) => {
            const day = personDay(person.id, plan, floor);
            return (
              <li key={person.id} className="staff-row">
                <div className="staff-row__who">
                  <h3 className="staff-row__name">{person.displayName}</h3>
                  <p className="staff-row__role">{t(`roles.${person.role}`)}</p>
                  {day.sections.length + day.tables.length === 0 ? (
                    <p className="sections-row__none">{t('sections.none')}</p>
                  ) : (
                    <>
                      {day.sections.length === 0 ? null : (
                        <p className="sections-row__line">
                          {t('sections.sectionsLine', { sections: day.sections.join(', ') })}
                        </p>
                      )}
                      {day.tables.length === 0 ? null : (
                        <p className="sections-row__line">
                          {t('sections.tablesLine', { tables: day.tables.join(', ') })}
                        </p>
                      )}
                      <p className="staff-row__contact">
                        {t('sections.tableCount', { count: day.tableCount })}
                      </p>
                    </>
                  )}
                </div>
                <div className="staff-row__actions">
                  <Button
                    variant="secondary"
                    aria-label={t('sections.changeFor', { name: person.displayName })}
                    onClick={() => {
                      setEditing(person);
                    }}
                  >
                    {t('sections.change')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <Page
      intro={t('sections.intro', { day: today })}
      action={
        earlierDay === undefined ? null : (
          <Button
            variant="secondary"
            loading={busy && !replacing && editing === undefined}
            disabled={busy}
            onClick={() => {
              if (plan.length > 0) setReplacing(true);
              else void applyEarlier();
            }}
          >
            {t('sections.sameAs', { day: earlierDay })}
          </Button>
        )
      }
    >
      {content}
      {editing === undefined ? null : (
        <TablesDialog
          person={editing}
          assignment={plan.find((assignment) => assignment.staffId === editing.id)}
          floor={floor}
          busy={busy}
          error={error}
          onSave={(change) => {
            void saveFor(change, editing);
          }}
          onClose={close}
        />
      )}
      {replacing && earlierDay !== undefined ? (
        <ConfirmDialog
          open
          tone="primary"
          title={t('sections.replaceDialog.title', { day: earlierDay })}
          description={t('sections.replaceDialog.description', { day: earlierDay })}
          confirmLabel={t('sections.replaceDialog.confirm')}
          cancelLabel={t('sections.replaceDialog.cancel')}
          busy={busy}
          onConfirm={() => {
            void applyEarlier();
          }}
          onCancel={close}
        >
          {error === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {error}
            </p>
          )}
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}

/** The page's heading, its introduction and its one action, around what it shows. */
function Page({
  intro,
  action,
  children,
}: {
  intro?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-sections">
      <div className="staff-header">
        <h2 id="dashboard-sections" className="dashboard-section__heading">
          {t('sections.title')}
        </h2>
        {action}
      </div>
      {intro === undefined ? null : <p className="dashboard-section__hint">{intro}</p>}
      {children}
    </section>
  );
}

/**
 * One person's sections and single tables for the day (TBL-002). Nothing ticked takes them off
 * for the day.
 */
function TablesDialog({
  person,
  assignment,
  floor,
  busy,
  error,
  onSave,
  onClose,
}: {
  person: StaffView;
  assignment: PlannedAssignment | undefined;
  floor: readonly ActiveSection[];
  busy: boolean;
  error: string | undefined;
  onSave: (change: PlannedAssignment) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [sectionIds, setSectionIds] = useState<string[]>(() => [...(assignment?.sectionIds ?? [])]);
  const [tableIds, setTableIds] = useState<string[]>(() => [...(assignment?.tableIds ?? [])]);

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('sections.dialog.title', { name: person.displayName })}
      description={t('sections.dialog.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('sections.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('sections.dialog.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // In the floor's order, whatever order they were ticked in.
          const inFloor = (ids: readonly string[], all: readonly string[]) =>
            all.filter((id) => ids.includes(id));
          onSave({
            staffId: person.id,
            sectionIds: inFloor(
              sectionIds,
              floor.map((section) => section.id),
            ),
            tableIds: inFloor(
              tableIds,
              floor.flatMap((section) => section.tables.map((table) => table.id)),
            ),
          });
        }}
      >
        <ChoiceGroup
          legend={t('sections.dialog.sections')}
          mode="multiple"
          options={floor
            .filter((section) => section.tables.length > 0)
            .map((section) => ({
              id: section.id,
              label: section.name,
              detail: t('sections.dialog.tableCount', { count: section.tables.length }),
            }))}
          value={sectionIds}
          onChange={setSectionIds}
        />
        {floor
          .filter((section) => section.tables.length > 0)
          .map((section) => {
            const ids = section.tables.map((table) => table.id);
            return (
              <ChoiceGroup
                key={section.id}
                className="sections-tables"
                legend={t('sections.dialog.tables', { section: section.name })}
                mode="multiple"
                options={section.tables.map((table) => ({ id: table.id, label: table.label }))}
                value={tableIds.filter((id) => ids.includes(id))}
                onChange={(chosen) => {
                  setTableIds((current) => [
                    ...current.filter((id) => !ids.includes(id)),
                    ...chosen,
                  ]);
                }}
              />
            );
          })}
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
