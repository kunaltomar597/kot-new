import type { CustomRoleView } from '@rp/contracts';
import type { Capability } from '@rp/domain';
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
import { useNavigate } from 'react-router';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import { countsAsManager, rolesInOrder } from './roles-view.js';

/** The dialog open over the list. */
interface Open {
  readonly kind: 'ARCHIVE' | 'RESTORE';
  readonly role: CustomRoleView;
}

/**
 * The Roles page (P4-02e, AUTH-012): the custom roles, active first, each with the role it is
 * built on, what it adds and takes away, and how many active people have it. The Owner creates
 * and changes them (on a page of their own), archives the ones nobody active has and restores
 * them, after confirming the second factor (AUTH-006); everyone else who looks after staff sees
 * them, to give them on the People page. The list follows changes made on any screen
 * (`RestaurantChanged`).
 */
export function RolesScreen() {
  const t = useT();
  const controller = useConsole();
  const navigate = useNavigate();
  const { person: me } = useConsoleState();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const { data, reload } = useLive(
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

  /** Archiving and restoring ask the Owner for the second factor first, when it is not fresh. */
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await withSecondFactor(action);
      toast.show({ title: message, tone: 'success' });
      close();
      reload();
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  if (me === undefined) return null;
  const isOwner = me.role === 'OWNER';

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('customRoles.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else if (data.value.roles.length === 0) {
    content = <EmptyState title={t('customRoles.none')} />;
  } else {
    content = (
      <ul className="staff-list">
        {rolesInOrder(data.value.roles).map((role) => (
          <RoleRow
            key={role.id}
            role={role}
            isOwner={isOwner}
            onEdit={() => {
              void navigate(`/manage/staff/roles/${role.id}`);
            }}
            onArchive={() => {
              setOpen({ kind: 'ARCHIVE', role });
            }}
            onRestore={() => {
              setOpen({ kind: 'RESTORE', role });
            }}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-roles">
      <div className="staff-header">
        <h2 id="dashboard-roles" className="dashboard-section__heading">
          {t('customRoles.title')}
        </h2>
        {isOwner ? (
          <Button
            startIcon={<Icon name="plus" />}
            onClick={() => {
              void navigate('/manage/staff/roles/new');
            }}
          >
            {t('customRoles.add')}
          </Button>
        ) : null}
      </div>
      <p className="dashboard-section__hint">
        {t('customRoles.intro')}
        {isOwner ? null : ` ${t('customRoles.ownerOnly')}`}
      </p>
      {content}
      {open?.kind === 'ARCHIVE' ? (
        <ReasonDialog
          title={t('customRoles.archiveDialog.title', { name: open.role.name })}
          description={t('customRoles.archiveDialog.description', { name: open.role.name })}
          label={t('customRoles.archiveDialog.reason')}
          confirmLabel={t('customRoles.archiveDialog.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            const { role } = open;
            void run(
              () => controller.api.archiveRole({ params: { roleId: role.id }, body: { reason } }),
              t('customRoles.archivedDone', { name: role.name }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'RESTORE' ? (
        <ConfirmDialog
          open
          tone="primary"
          title={t('customRoles.restoreDialog.title', { name: open.role.name })}
          description={t('customRoles.restoreDialog.description', { name: open.role.name })}
          confirmLabel={t('customRoles.restoreDialog.confirm')}
          cancelLabel={t('customRoles.restoreDialog.cancel')}
          busy={busy}
          onConfirm={() => {
            const { role } = open;
            void run(
              () => controller.api.restoreRole({ params: { roleId: role.id } }),
              t('customRoles.restored', { name: role.name }),
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

/** One role: what it is built on, what it changes, who has it, and the Owner's actions. */
function RoleRow({
  role,
  isOwner,
  onEdit,
  onArchive,
  onRestore,
}: {
  role: CustomRoleView;
  isOwner: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const t = useT();
  const archived = role.archivedAt !== null;
  const base = t(`roles.${role.baseRole}`);
  const list = (capabilities: readonly Capability[]) =>
    new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(
      capabilities.map((capability) => t(`capabilities.${capability}`)),
    );
  const actions: { readonly label: string; readonly onClick: () => void }[] = !isOwner
    ? []
    : archived
      ? [{ label: t('customRoles.restore'), onClick: onRestore }]
      : [
          { label: t('customRoles.edit'), onClick: onEdit },
          ...(role.staffCount === 0
            ? [{ label: t('customRoles.archive'), onClick: onArchive }]
            : []),
        ];
  return (
    <li className="staff-row" data-inactive={archived || undefined}>
      <div className="staff-row__who">
        <h3 className="staff-row__name">{role.name}</h3>
        <p className="staff-row__role">{t('customRoles.basedOn', { role: base })}</p>
        <p className="staff-row__states">
          {archived ? <Badge tone="neutral">{t('customRoles.archived')}</Badge> : null}
          {countsAsManager(role) ? (
            <Badge tone="info">{t('customRoles.countsAsManager')}</Badge>
          ) : null}
          <Badge tone={role.staffCount === 0 ? 'neutral' : 'success'}>
            {t('customRoles.people', { count: role.staffCount })}
          </Badge>
        </p>
        {role.added.length === 0 && role.removed.length === 0 ? (
          <p className="staff-row__contact">{t('customRoles.sameAsBase', { role: base })}</p>
        ) : null}
        {role.added.length > 0 ? (
          <p className="staff-row__contact">{t('customRoles.adds', { list: list(role.added) })}</p>
        ) : null}
        {role.removed.length > 0 ? (
          <p className="staff-row__contact">
            {t('customRoles.takesAway', { list: list(role.removed) })}
          </p>
        ) : null}
        {isOwner && !archived && role.staffCount > 0 ? (
          <p className="staff-row__contact">{t('customRoles.inUse')}</p>
        ) : null}
      </div>
      {actions.length === 0 ? null : (
        <div
          className="staff-row__actions"
          role="group"
          aria-label={t('customRoles.actionsFor', { name: role.name })}
        >
          {actions.map((action) => (
            <Button key={action.label} variant="secondary" onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
