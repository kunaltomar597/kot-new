import type { StaffView } from '@rp/contracts';
import { timeOfDayOf } from '@rp/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useCallback, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { useNow } from '../../app/use-now.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import { PersonDialog, PinDialog } from './StaffDialogs.js';
import {
  isLocked,
  roleLabel,
  type StaffAction,
  type StaffActorView,
  staffActions,
} from './staff-view.js';

/** Check locks again this often, so an expired lock stops showing without a reload. */
const CLOCK_MS = 30_000;

type Open =
  | { readonly kind: 'ADD' }
  | { readonly kind: 'EDIT' | 'SET_PIN' | 'DEACTIVATE' | 'REACTIVATE'; readonly person: StaffView };

/**
 * The Staff page (P4-02a, MGR-004): everyone who signs in here, active people first, with their
 * role (a custom role with the role it is built on, P4-02e), contact, PIN and lock state; adding
 * people, editing them, setting PINs, unlocking, deactivating and reactivating. Each person shows
 * only the actions the signed-in person may take (`@rp/domain` staff rules, checked again by the
 * server), and the list follows every change made on any screen (`RestaurantChanged`).
 */
export function StaffScreen() {
  const t = useT();
  const controller = useConsole();
  const { person: me } = useConsoleState();
  const toast = useToast();
  const now = useNow(CLOCK_MS);
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const { data, reload } = useLive(
    () => controller.api.listStaff(),
    (type) => type === 'RestaurantChanged',
  );
  // The custom roles the dialog offers; without them it offers the built-in roles.
  const { data: roles } = useLive(
    () => controller.api.listRoles(),
    (type) => type === 'RestaurantChanged',
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** A change went through: say so, read the list again and close the dialog. */
  const done = (message: string) => {
    toast.show({ title: message, tone: 'success' });
    close();
    reload();
  };

  /** Deactivating and reactivating may ask the Owner for the second factor first. */
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await withSecondFactor(action);
      done(message);
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const unlock = async (person: StaffView) => {
    try {
      await controller.api.unlockStaff({ body: { staffId: person.id } });
      toast.show({ title: t('staff.unlocked', { name: person.displayName }), tone: 'success' });
      reload();
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
  };

  if (me === undefined) return null;
  const actor: StaffActorView = { staffId: me.id, role: me.role, customRole: me.customRole };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('staff.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const others = data.value.staff.filter((person) => person.id !== me.id);
    content = (
      <>
        {others.length === 0 ? <EmptyState title={t('staff.none')} /> : null}
        <ul className="staff-list">
          {data.value.staff.map((person) => (
            <StaffRow
              key={person.id}
              person={person}
              self={person.id === me.id}
              actions={staffActions(actor, person, now)}
              now={now}
              onAction={(action) => {
                if (action === 'UNLOCK') void unlock(person);
                else setOpen({ kind: action, person });
              }}
            />
          ))}
        </ul>
      </>
    );
  }

  const pinLength = data.status === 'ready' ? data.value.pinLength : 4;
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-staff">
      <div className="staff-header">
        <h2 id="dashboard-staff" className="dashboard-section__heading">
          {t('staff.title')}
        </h2>
        <Button
          startIcon={<Icon name="plus" />}
          disabled={data.status !== 'ready'}
          onClick={() => {
            setOpen({ kind: 'ADD' });
          }}
        >
          {t('staff.add')}
        </Button>
      </div>
      <p className="dashboard-section__hint">
        {t('staff.intro')}
        {me.role === 'OWNER' ? null : ` ${t('staff.managersByOwner')}`}
      </p>
      {content}
      {open?.kind === 'ADD' || open?.kind === 'EDIT' ? (
        <PersonDialog
          actor={actor}
          person={open.kind === 'EDIT' ? open.person : undefined}
          customRoles={roles.status === 'ready' ? roles.value.roles : []}
          pinLength={pinLength}
          withSecondFactor={withSecondFactor}
          onSaved={(saved) => {
            done(
              t(open.kind === 'ADD' ? 'staff.added' : 'staff.saved', { name: saved.displayName }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'SET_PIN' ? (
        <PinDialog
          person={open.person}
          self={open.person.id === me.id}
          pinLength={pinLength}
          onSaved={() => {
            done(t('staff.pinSaved', { name: open.person.displayName }));
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'DEACTIVATE' ? (
        <ReasonDialog
          title={t('staff.deactivateDialog.title', { name: open.person.displayName })}
          description={t('staff.deactivateDialog.description', { name: open.person.displayName })}
          label={t('staff.deactivateDialog.reason')}
          confirmLabel={t('staff.deactivateDialog.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            const { person } = open;
            void run(
              () =>
                controller.api.deactivateStaff({
                  params: { staffId: person.id },
                  body: { reason },
                }),
              t('staff.deactivated', { name: person.displayName }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'REACTIVATE' ? (
        <ConfirmDialog
          open
          tone="primary"
          title={t('staff.reactivateDialog.title', { name: open.person.displayName })}
          description={t('staff.reactivateDialog.description', { name: open.person.displayName })}
          confirmLabel={t('staff.reactivateDialog.confirm')}
          cancelLabel={t('staff.reactivateDialog.cancel')}
          busy={busy}
          onConfirm={() => {
            const { person } = open;
            void run(
              () => controller.api.reactivateStaff({ params: { staffId: person.id } }),
              t('staff.reactivated', { name: person.displayName }),
            );
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
      {secondFactorDialog}
    </section>
  );
}

const ACTION_LABELS = {
  EDIT: 'staff.edit',
  UNLOCK: 'staff.unlock',
  DEACTIVATE: 'staff.deactivate',
  REACTIVATE: 'staff.reactivate',
} as const;

/** One person: who they are, their state in words (not colour alone) and their actions. */
function StaffRow({
  person,
  self,
  actions,
  now,
  onAction,
}: {
  person: StaffView;
  self: boolean;
  actions: readonly StaffAction[];
  now: number;
  onAction: (action: StaffAction) => void;
}) {
  const t = useT();
  const locked = isLocked(person, now);
  return (
    <li className="staff-row" data-inactive={!person.active || undefined}>
      <div className="staff-row__who">
        <h3 className="staff-row__name">
          {person.displayName}
          {self ? <Badge tone="info">{t('staff.you')}</Badge> : null}
        </h3>
        <p className="staff-row__role">{roleLabel(t, person.role, person.customRole)}</p>
        <p className="staff-row__states">
          {person.active ? (
            <Badge tone="success">{t('staff.active')}</Badge>
          ) : (
            <Badge tone="neutral">{t('staff.inactive')}</Badge>
          )}
          {person.hasPin ? null : <Badge tone="warning">{t('staff.noPin')}</Badge>}
          {locked && person.lockedUntil !== null ? (
            <Badge tone="danger" icon={<Icon name="warning" />}>
              {t('staff.lockedUntil', { time: timeOfDayOf(new Date(person.lockedUntil)) })}
            </Badge>
          ) : null}
        </p>
        {person.phone === null ? null : (
          <p className="staff-row__contact">{t('staff.phone', { phone: person.phone })}</p>
        )}
        {person.email === null ? null : (
          <p className="staff-row__contact">{t('staff.email', { email: person.email })}</p>
        )}
      </div>
      {actions.length === 0 ? null : (
        <div
          className="staff-row__actions"
          role="group"
          aria-label={t('staff.actionsFor', { name: person.displayName })}
        >
          {actions.map((action) => (
            <Button
              key={action}
              variant="secondary"
              onClick={() => {
                onAction(action);
              }}
            >
              {action === 'SET_PIN'
                ? t(person.hasPin ? 'staff.changePin' : 'staff.setPin')
                : t(ACTION_LABELS[action])}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
