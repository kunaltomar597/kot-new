import type { RoleView } from '@rp/contracts';
import { type Capability, CUSTOM_ROLE_BASES, type CustomRoleBase } from '@rp/domain';
import {
  Badge,
  Button,
  ChoiceGroup,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Select,
  TextField,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import {
  addable,
  included,
  type RoleForm,
  roleFormOf,
  roleProblem,
  roleRequestOf,
  sortRoles,
} from './roles-view.js';

type Open =
  { readonly kind: 'ADD' } | { readonly kind: 'EDIT' | 'ARCHIVE'; readonly role: RoleView };

/**
 * Roles (P4-02e, AUTH-012): the built-in roles of BRD §4.2 and the Owner's custom roles, each a
 * cashier, waiter or kitchen role that may do more. Managers see them; only the Owner adds,
 * changes or archives one, confirming password and authenticator (AUTH-006).
 */
export function RolesScreen() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const { data, reload } = useLive(
    () => controller.api.listRoles(),
    (type) => type === 'RestaurantChanged',
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const isOwner = person?.role === 'OWNER';

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

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

  const capabilityList = (capabilities: readonly Capability[]) =>
    capabilities.map((capability) => t(`capabilities.${capability}`)).join('; ');

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
  } else {
    const { builtIn, custom } = sortRoles(data.value.roles);
    const row = (role: RoleView) => {
      const archived = role.archivedAt !== null;
      return (
        <li key={role.id} className="staff-row" data-inactive={archived ? '' : undefined}>
          <div className="staff-row__who">
            <h4 className="staff-row__name">
              {role.builtIn ? t(`roles.${role.baseRole}`) : role.name}
            </h4>
            <p className="staff-row__role">
              {role.builtIn
                ? t('customRoles.builtIn')
                : t('customRoles.onBase', { role: t(`roles.${role.baseRole}`) })}
            </p>
            {role.capabilities.length === 0 ? null : (
              <p className="staff-row__contact">
                {t('customRoles.adds', { list: capabilityList(role.capabilities) })}
              </p>
            )}
            <p className="staff-row__states">
              <Badge tone="neutral">{t('customRoles.people', { count: role.staffCount })}</Badge>
              {archived ? (
                <Badge tone="neutral" icon={<Icon name="ban" />}>
                  {t('customRoles.archived')}
                </Badge>
              ) : null}
            </p>
          </div>
          {isOwner && !role.builtIn && !archived ? (
            <div
              className="staff-row__actions"
              role="group"
              aria-label={t('customRoles.actionsFor', { name: role.name })}
            >
              <Button
                variant="secondary"
                onClick={() => {
                  setOpen({ kind: 'EDIT', role });
                }}
              >
                {t('customRoles.edit')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setOpen({ kind: 'ARCHIVE', role });
                }}
              >
                {t('customRoles.archive')}
              </Button>
            </div>
          ) : null}
        </li>
      );
    };
    content = (
      <>
        <section className="device-group" aria-labelledby="roles-custom">
          <h3 id="roles-custom" className="device-group__heading">
            {t('customRoles.customTitle')}
          </h3>
          {custom.length === 0 ? (
            <EmptyState title={t('customRoles.none')} />
          ) : (
            <ul className="staff-list" aria-labelledby="roles-custom">
              {custom.map(row)}
            </ul>
          )}
        </section>
        <section className="device-group" aria-labelledby="roles-built-in">
          <h3 id="roles-built-in" className="device-group__heading">
            {t('customRoles.builtInTitle')}
          </h3>
          <ul className="staff-list" aria-labelledby="roles-built-in">
            {builtIn.map(row)}
          </ul>
        </section>
      </>
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
            disabled={data.status !== 'ready'}
            onClick={() => {
              setOpen({ kind: 'ADD' });
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
      {(open?.kind === 'ADD' || open?.kind === 'EDIT') && data.status === 'ready' ? (
        <RoleDialog
          role={open.kind === 'EDIT' ? open.role : undefined}
          roles={data.value.roles}
          busy={busy}
          error={error}
          onSave={(form) => {
            const body = roleRequestOf(form);
            void run(
              () =>
                open.kind === 'EDIT'
                  ? controller.api.updateRole({ params: { roleId: open.role.id }, body })
                  : controller.api.createRole({ body }),
              open.kind === 'EDIT'
                ? t('customRoles.saved', { name: body.name })
                : t('customRoles.added', { name: body.name }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'ARCHIVE' ? (
        <ArchiveRoleDialog
          role={open.role}
          busy={busy}
          error={error}
          onArchive={(reason) => {
            void run(
              () =>
                controller.api.archiveRole({ params: { roleId: open.role.id }, body: { reason } }),
              t('customRoles.archivedToast', { name: open.role.name }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {secondFactorDialog}
    </section>
  );
}

function RoleDialog({
  role,
  roles,
  busy,
  error,
  onSave,
  onClose,
}: {
  role: RoleView | undefined;
  roles: readonly RoleView[];
  busy: boolean;
  error: string | undefined;
  onSave: (form: RoleForm) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [form, setForm] = useState<RoleForm>(() => roleFormOf(role));
  const [submitted, setSubmitted] = useState(false);
  const problem = roleProblem(form, roles, role?.id);
  const baseLocked = role !== undefined && role.staffCount > 0;
  const already = included(form.baseRole);
  const list = (capabilities: readonly Capability[]) =>
    capabilities.map((capability) => t(`capabilities.${capability}`)).join('; ');
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      title={
        role === undefined
          ? t('customRoles.form.addTitle')
          : t('customRoles.form.editTitle', { name: role.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('customRoles.form.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {role === undefined ? t('customRoles.form.create') : t('customRoles.form.save')}
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
          setSubmitted(true);
          if (problem === undefined) onSave(form);
        }}
      >
        <TextField
          label={t('customRoles.form.name')}
          hint={t('customRoles.form.nameHint')}
          value={form.name}
          maxLength={40}
          autoComplete="off"
          required
          data-autofocus
          error={
            submitted && (problem === 'NAME_REQUIRED' || problem === 'NAME_TAKEN')
              ? problem === 'NAME_TAKEN'
                ? t('customRoles.form.nameTaken')
                : t('customRoles.form.nameRequired')
              : undefined
          }
          onChange={(event) => {
            setForm((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {baseLocked ? (
          <p className="menu-form__hint">
            {t('customRoles.form.baseLocked', { role: t(`roles.${form.baseRole}`) })}
          </p>
        ) : (
          <Select
            label={t('customRoles.form.base')}
            hint={t('customRoles.form.baseHint')}
            value={form.baseRole}
            options={CUSTOM_ROLE_BASES.map((base) => ({ value: base, label: t(`roles.${base}`) }))}
            onChange={(event) => {
              const baseRole = event.target.value as CustomRoleBase;
              setForm((current) => ({ ...current, baseRole }));
            }}
          />
        )}
        <ChoiceGroup
          legend={t('customRoles.form.add')}
          hint={t('customRoles.form.addHint')}
          mode="multiple"
          options={addable(form.baseRole).map((capability) => ({
            id: capability,
            label: t(`capabilities.${capability}`),
          }))}
          value={form.capabilities.filter((capability) =>
            addable(form.baseRole).includes(capability),
          )}
          error={
            submitted && problem === 'NOTHING_ADDED'
              ? t('customRoles.form.nothingAdded')
              : undefined
          }
          onChange={(capabilities) => {
            setForm((current) => ({
              ...current,
              capabilities: capabilities as RoleForm['capabilities'],
            }));
          }}
        />
        {already.length === 0 ? null : (
          <p className="menu-form__hint">
            {t('customRoles.form.already', {
              role: t(`roles.${form.baseRole}`),
              list: list(already),
            })}
          </p>
        )}
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function ArchiveRoleDialog({
  role,
  busy,
  error,
  onArchive,
  onClose,
}: {
  role: RoleView;
  busy: boolean;
  error: string | undefined;
  onArchive: (reason: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const short = reason.trim().length < 3;
  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t('customRoles.archiveDialog.title', { name: role.name })}
      description={t('customRoles.archiveDialog.description')}
      confirmLabel={t('customRoles.archiveDialog.confirm')}
      cancelLabel={t('customRoles.archiveDialog.cancel')}
      busy={busy}
      onConfirm={() => {
        setSubmitted(true);
        if (!short) onArchive(reason.trim());
      }}
      onCancel={onClose}
    >
      <TextField
        label={t('customRoles.archiveDialog.reason')}
        value={reason}
        maxLength={200}
        autoComplete="off"
        required
        data-autofocus
        error={submitted && short ? t('customRoles.archiveDialog.reasonRequired') : undefined}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
