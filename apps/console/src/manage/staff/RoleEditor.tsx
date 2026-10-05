import type { CustomRoleView } from '@rp/contracts';
import { ASSIGNABLE_ROLES, grantFor, isAssignableRole, ROLES } from '@rp/domain';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  TextField,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import {
  activeRoleNames,
  CAPABILITY_GROUP_NAMES,
  CAPABILITY_GROUPS,
  type CapabilityChange,
  changeOf,
  changesFor,
  checkRole,
  countsAsManager,
  customisationOfForm,
  emptyRoleForm,
  grantWith,
  type RoleForm,
  roleChanged,
  roleFormOf,
  roleRequestOf,
  withBaseRole,
  withChange,
} from './roles-view.js';

const BACK = '/manage/staff/roles';

function isChange(value: string): value is CapabilityChange {
  return value === 'BASE' || value === 'ADD' || value === 'REMOVE';
}

/**
 * Creates or changes a custom role (P4-02e, AUTH-012) on its own page, for the Owner only:
 * `/manage/staff/roles/new` or `/manage/staff/roles/:roleId`. Saving asks for the second factor
 * when it is not fresh (AUTH-006).
 */
export function RoleEditor() {
  const t = useT();
  const controller = useConsole();
  const navigate = useNavigate();
  const { roleId } = useParams();
  const { data, reload } = useLive(
    () => controller.api.listRoles(),
    (type) => type === 'RestaurantChanged',
  );

  const back = (
    <Button
      variant="ghost"
      onClick={() => {
        void navigate(BACK);
      }}
    >
      {t('customRoles.editor.back')}
    </Button>
  );
  if (data.status === 'loading') return <LoadingState title={t('states.loading')} />;
  if (data.status === 'error') {
    return (
      <ErrorState
        title={t('customRoles.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  }
  const { roles } = data.value;
  const role = roleId === undefined ? undefined : roles.find((entry) => entry.id === roleId);
  if (roleId !== undefined && role === undefined) {
    return (
      <section className="dashboard-section" aria-label={t('customRoles.title')}>
        <EmptyState title={t('customRoles.editor.notFound')} />
        <div>{back}</div>
      </section>
    );
  }
  if (role !== undefined && role.archivedAt !== null) {
    return (
      <section className="dashboard-section" aria-labelledby="role-editor">
        <div className="staff-header">
          <h2 id="role-editor" className="dashboard-section__heading">
            {t('customRoles.editor.editTitle', { name: role.name })}
          </h2>
          {back}
        </div>
        <p className="console-notice">{t('customRoles.editor.archivedNotice')}</p>
      </section>
    );
  }
  return <RoleEditorForm key={roleId ?? 'new'} role={role} roles={roles} back={back} />;
}

function RoleEditorForm({
  role,
  roles,
  back,
}: {
  /** Undefined to create a role. */
  role: CustomRoleView | undefined;
  roles: readonly CustomRoleView[];
  back: ReactNode;
}) {
  const t = useT();
  const controller = useConsole();
  const navigate = useNavigate();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const [form, setForm] = useState<RoleForm>(() =>
    role === undefined ? emptyRoleForm() : roleFormOf(role),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const taken = [
    ...ROLES.map((builtIn) => t(`roles.${builtIn}`)),
    ...activeRoleNames(roles, role?.id),
  ];
  const problems = checkRole(form, taken);
  const invalid = Object.keys(problems).length > 0;
  const nameProblem =
    submitted && problems.name !== undefined ? t(`customRoles.editor.${problems.name}`) : undefined;
  const base = t(`roles.${form.baseRole}`);

  const save = async () => {
    setSubmitted(true);
    if (invalid) return;
    if (role !== undefined && !roleChanged(role, form)) {
      void navigate(BACK);
      return;
    }
    setError(undefined);
    setBusy(true);
    const body = roleRequestOf(form);
    try {
      const saved = await withSecondFactor(() =>
        role === undefined
          ? controller.api.createRole({ body })
          : controller.api.updateRole({ params: { roleId: role.id }, body }),
      );
      toast.show({
        title: t(role === undefined ? 'customRoles.created' : 'customRoles.saved', {
          name: saved.name,
        }),
        tone: 'success',
      });
      void navigate(BACK);
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <section className="dashboard-section menu-editor" aria-labelledby="role-editor">
      <div className="staff-header">
        <h2 id="role-editor" className="dashboard-section__heading">
          {role === undefined
            ? t('customRoles.editor.newTitle')
            : t('customRoles.editor.editTitle', { name: role.name })}
        </h2>
        {back}
      </div>
      {submitted && invalid ? (
        <p role="alert" className="console-notice console-notice--danger">
          {t('customRoles.editor.problems')}
        </p>
      ) : null}
      <form
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="menu-editor__section">
          <div className="menu-editor__row">
            <TextField
              label={t('customRoles.editor.name')}
              hint={t('customRoles.editor.nameHint')}
              value={form.name}
              maxLength={40}
              autoComplete="off"
              required
              data-autofocus
              error={nameProblem}
              onChange={(event) => {
                const name = event.target.value;
                setForm((current) => ({ ...current, name }));
              }}
            />
            <Select
              label={t('customRoles.editor.baseRole')}
              hint={t('customRoles.editor.baseRoleHint')}
              value={form.baseRole}
              options={ASSIGNABLE_ROLES.map((builtIn) => ({
                value: builtIn,
                label: t(`roles.${builtIn}`),
              }))}
              onChange={(event) => {
                const baseRole = event.target.value;
                if (isAssignableRole(baseRole)) {
                  setForm((current) => withBaseRole(current, baseRole));
                }
              }}
            />
          </div>
          {countsAsManager({ baseRole: form.baseRole, ...customisationOfForm(form) }) ? (
            <p className="console-notice">{t('customRoles.editor.managerNote')}</p>
          ) : null}
          {role !== undefined && role.staffCount > 0 ? (
            <p className="console-notice">
              {t('customRoles.editor.staffNote', { count: role.staffCount })}
            </p>
          ) : null}
        </div>
        <div className="role-editor__heading">
          <h3 className="dashboard-section__heading">{t('customRoles.editor.permissions')}</h3>
          <p className="dashboard-section__hint">
            {t('customRoles.editor.permissionsHint', { role: base })}
          </p>
        </div>
        {CAPABILITY_GROUP_NAMES.map((group) => (
          <fieldset key={group} className="menu-editor__section">
            <legend className="menu-editor__legend">
              {t(`customRoles.editor.groups.${group}`)}
            </legend>
            <div className="role-editor__permissions">
              {CAPABILITY_GROUPS[group].map((capability) => {
                const change = changeOf(form, capability);
                return (
                  <Select
                    key={capability}
                    label={t(`capabilities.${capability}`)}
                    hint={change === 'BASE' ? undefined : t('customRoles.editor.changed')}
                    value={change}
                    options={changesFor(form.baseRole, capability).map((option) => ({
                      value: option,
                      label:
                        option === 'BASE'
                          ? t('customRoles.editor.asBase', {
                              grant: t(
                                `customRoles.editor.grants.${grantFor(form.baseRole, capability)}`,
                              ),
                              role: base,
                            })
                          : t(
                              `customRoles.editor.grants.${grantWith(form.baseRole, capability, option)}`,
                            ),
                    }))}
                    onChange={(event) => {
                      const chosen = event.target.value;
                      if (isChange(chosen)) {
                        setForm((current) => withChange(current, capability, chosen));
                      }
                    }}
                  />
                );
              })}
            </div>
          </fieldset>
        ))}
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
        <div className="menu-editor__actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void navigate(BACK);
            }}
          >
            {t('customRoles.editor.cancel')}
          </Button>
          <Button type="submit" loading={busy}>
            {role === undefined ? t('customRoles.editor.create') : t('customRoles.editor.save')}
          </Button>
        </div>
      </form>
      {secondFactorDialog}
    </section>
  );
}
