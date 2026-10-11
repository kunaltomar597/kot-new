import type { ModifierGroupView } from '@rp/contracts';
import { formatRupees } from '@rp/domain';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  TextField,
  useToast,
} from '@rp/ui-web';
import { useCallback, useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import type { MenuTabProps } from './MenuEditor.js';
import {
  checkGroup,
  type GroupField,
  type GroupForm,
  groupFormOf,
  groupRequestOf,
  groupRule,
  newKey,
} from './menu-view.js';
import { ReasonDialog } from './ReasonDialog.js';

type Open =
  | { readonly kind: 'ADD' }
  | { readonly kind: 'EDIT' | 'ARCHIVE'; readonly group: ModifierGroupView };

/** Reusable option groups such as "Roti type" or "Add-ons" (MENU-004). */
export function GroupsTab({ data, reload }: MenuTabProps) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const groups = data.draft.modifierGroups
    .filter((group) => (archived ? true : group.archivedAt === null))
    .sort((a, b) => a.name.localeCompare(b.name));

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  const run = async (action: () => Promise<unknown>, done: string) => {
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

  const ruleText = (group: ModifierGroupView) => {
    const rule = groupRule(group);
    switch (rule.kind) {
      case 'EXACTLY':
        return t('menuEditor.groups.ruleExactly', { count: rule.count });
      case 'UP_TO':
        return t('menuEditor.groups.ruleUpTo', { count: rule.count });
      case 'BETWEEN':
        return t('menuEditor.groups.ruleBetween', { min: rule.min, max: rule.max });
    }
  };

  return (
    <div className="menu-tab">
      <div className="menu-toolbar">
        <label className="menu-toolbar__check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
            }}
          />
          {t('menuEditor.groups.showArchived')}
        </label>
        <Button
          startIcon={<Icon name="plus" />}
          onClick={() => {
            setOpen({ kind: 'ADD' });
          }}
        >
          {t('menuEditor.groups.add')}
        </Button>
      </div>
      {error !== undefined && open === undefined ? (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      ) : null}
      {groups.length === 0 ? (
        <EmptyState title={t('menuEditor.groups.none')} />
      ) : (
        <ul className="staff-list" aria-label={t('menuEditor.tabs.groups')}>
          {groups.map((group) => {
            const isArchived = group.archivedAt !== null;
            const options = group.options
              .filter((option) => option.archivedAt === null)
              .map((option) =>
                option.priceDelta === 0
                  ? option.name
                  : t('menuEditor.groups.optionWithPrice', {
                      name: option.name,
                      price: `${option.priceDelta > 0 ? '+' : ''}${formatRupees(option.priceDelta)}`,
                    }),
              )
              .join(', ');
            return (
              <li key={group.id} className="staff-row" data-inactive={isArchived ? '' : undefined}>
                <div className="staff-row__who">
                  <h3 className="staff-row__name">{group.name}</h3>
                  <p className="staff-row__role">{ruleText(group)}</p>
                  <p className="staff-row__contact">
                    {t('menuEditor.groups.options', { names: options })}
                  </p>
                  <p className="staff-row__states">
                    <Badge tone="neutral">
                      {t('menuEditor.groups.usedBy', { count: group.itemCount })}
                    </Badge>
                    {isArchived ? (
                      <Badge tone="neutral" icon={<Icon name="ban" />}>
                        {t('menuEditor.archived')}
                      </Badge>
                    ) : null}
                  </p>
                </div>
                <div
                  className="staff-row__actions"
                  role="group"
                  aria-label={t('menuEditor.groups.actionsFor', { name: group.name })}
                >
                  {isArchived ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        void run(
                          () => controller.api.restoreModifierGroup({ params: { id: group.id } }),
                          t('menuEditor.groups.restored', { name: group.name }),
                        );
                      }}
                    >
                      {t('menuEditor.restore')}
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOpen({ kind: 'EDIT', group });
                        }}
                      >
                        {t('menuEditor.edit')}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOpen({ kind: 'ARCHIVE', group });
                        }}
                      >
                        {t('menuEditor.archive')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open?.kind === 'ADD' || open?.kind === 'EDIT' ? (
        <GroupDialog
          group={open.kind === 'EDIT' ? open.group : undefined}
          busy={busy}
          error={error}
          onSave={(form) => {
            const body = groupRequestOf(form);
            void run(
              () =>
                open.kind === 'EDIT'
                  ? controller.api.updateModifierGroup({ params: { id: open.group.id }, body })
                  : controller.api.createModifierGroup({ body }),
              open.kind === 'EDIT'
                ? t('menuEditor.groups.saved', { name: body.name })
                : t('menuEditor.groups.added', { name: body.name }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'ARCHIVE' ? (
        <ReasonDialog
          title={t('menuEditor.groups.archiveTitle', { name: open.group.name })}
          description={t('menuEditor.groups.archiveDescription')}
          confirmLabel={t('menuEditor.archive')}
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void run(
              () =>
                controller.api.archiveModifierGroup({
                  params: { id: open.group.id },
                  body: { reason },
                }),
              t('menuEditor.groups.archivedToast', { name: open.group.name }),
            );
          }}
          onCancel={close}
        />
      ) : null}
    </div>
  );
}

function GroupDialog({
  group,
  busy,
  error,
  onSave,
  onClose,
}: {
  group: ModifierGroupView | undefined;
  busy: boolean;
  error: string | undefined;
  onSave: (form: GroupForm) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [form, setForm] = useState<GroupForm>(() => groupFormOf(group));
  const [submitted, setSubmitted] = useState(false);
  const problems = checkGroup(form);
  const problemOf = (field: GroupField) => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`menuEditor.groups.problems.${problem}`)
      : undefined;
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      title={
        group === undefined
          ? t('menuEditor.groups.addTitle')
          : t('menuEditor.groups.editTitle', { name: group.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('menuEditor.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('menuEditor.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form menu-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (Object.keys(problems).length === 0) onSave(form);
        }}
      >
        <TextField
          label={t('menuEditor.groups.name')}
          value={form.name}
          maxLength={60}
          autoComplete="off"
          required
          data-autofocus
          error={problemOf('name')}
          onChange={(event) => {
            setForm((current) => ({ ...current, name: event.target.value }));
          }}
        />
        <div className="menu-form__row">
          <TextField
            label={t('menuEditor.groups.min')}
            hint={t('menuEditor.groups.minHint')}
            value={form.minSelections}
            inputMode="numeric"
            autoComplete="off"
            error={problemOf('minSelections')}
            onChange={(event) => {
              setForm((current) => ({ ...current, minSelections: event.target.value }));
            }}
          />
          <TextField
            label={t('menuEditor.groups.max')}
            value={form.maxSelections}
            inputMode="numeric"
            autoComplete="off"
            error={problemOf('maxSelections')}
            onChange={(event) => {
              setForm((current) => ({ ...current, maxSelections: event.target.value }));
            }}
          />
        </div>
        <fieldset className="menu-form__section">
          <legend>{t('menuEditor.groups.optionsLegend')}</legend>
          {form.options.map((option, index) => {
            const update = (patch: Partial<typeof option>) => {
              setForm((current) => {
                const options = [...current.options];
                options[index] = { ...option, ...patch };
                return { ...current, options };
              });
            };
            return (
              <div className="menu-form__row" key={option.key}>
                <TextField
                  label={t('menuEditor.groups.optionName')}
                  value={option.name}
                  maxLength={60}
                  autoComplete="off"
                  onChange={(event) => {
                    update({ name: event.target.value });
                  }}
                />
                <TextField
                  label={t('menuEditor.groups.optionPrice')}
                  hint={t('menuEditor.groups.optionPriceHint')}
                  value={option.priceDelta}
                  inputMode="decimal"
                  autoComplete="off"
                  onChange={(event) => {
                    update({ priceDelta: event.target.value });
                  }}
                />
                <label className="menu-toolbar__check">
                  <input
                    type="checkbox"
                    checked={option.available}
                    onChange={(event) => {
                      update({ available: event.target.checked });
                    }}
                  />
                  {t('menuEditor.groups.optionAvailable')}
                </label>
                {form.options.length === 1 ? null : (
                  <IconButton
                    label={t('menuEditor.groups.removeOption', {
                      name: option.name === '' ? String(index + 1) : option.name,
                    })}
                    icon={<Icon name="close" />}
                    onClick={() => {
                      setForm((current) => ({
                        ...current,
                        options: current.options.filter((entry) => entry.key !== option.key),
                      }));
                    }}
                  />
                )}
              </div>
            );
          })}
          {problemOf('options') === undefined ? null : (
            <p role="alert" className="menu-form__error">
              {problemOf('options')}
            </p>
          )}
          {form.options.length >= 50 ? null : (
            <Button
              variant="secondary"
              startIcon={<Icon name="plus" />}
              onClick={() => {
                setForm((current) => ({
                  ...current,
                  options: [
                    ...current.options,
                    { key: newKey(), name: '', priceDelta: '0', available: true },
                  ],
                }));
              }}
            >
              {t('menuEditor.groups.addOption')}
            </Button>
          )}
        </fieldset>
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
