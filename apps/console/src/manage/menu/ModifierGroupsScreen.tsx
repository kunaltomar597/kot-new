import type { ModifierGroupView } from '@rp/contracts';
import { formatRupees } from '@rp/domain';
import { ruleOf } from '@rp/ordering';
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
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { useMenu } from './MenuArea.js';
import {
  checkGroup,
  emptyGroupForm,
  emptyOption,
  type GroupForm,
  groupFormOf,
  groupRequestOf,
  type OptionForm,
} from './menu-view.js';

type Open =
  | { readonly kind: 'ADD' }
  | { readonly kind: 'EDIT' | 'ARCHIVE'; readonly group: ModifierGroupView };

/**
 * The modifier groups (P4-02d, MENU-004): each with its rule (optional or required, fewest and
 * most), its options with their price changes, and how many items offer it. A group is set up
 * once and offered with any number of items.
 */
export function ModifierGroupsScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { menu, reload } = useMenu();
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  };

  const archive = async (group: ModifierGroupView, reason: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.archiveModifierGroup({ params: { id: group.id }, body: { reason } });
      toast.show({
        title: t('menuEditor.modifiers.archivedToast', { name: group.name }),
        tone: 'success',
      });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const restore = async (group: ModifierGroupView) => {
    try {
      await controller.api.restoreModifierGroup({ params: { id: group.id } });
      toast.show({
        title: t('menuEditor.modifiers.restoredToast', { name: group.name }),
        tone: 'success',
      });
      reload();
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
  };

  const groups = menu.draft.modifierGroups.filter((group) => archived || group.archivedAt === null);

  return (
    <section className="dashboard-section" aria-labelledby="menu-modifiers">
      <div className="staff-header">
        <h2 id="menu-modifiers" className="dashboard-section__heading">
          {t('menuEditor.modifiers.title')}
        </h2>
        <Button
          startIcon={<Icon name="plus" />}
          onClick={() => {
            setOpen({ kind: 'ADD' });
          }}
        >
          {t('menuEditor.modifiers.add')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('menuEditor.modifiers.intro')}</p>
      <label className="console-check">
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => {
            setArchived(event.target.checked);
          }}
        />
        {t('menuEditor.modifiers.showArchived')}
      </label>
      {groups.length === 0 ? (
        <EmptyState title={t('menuEditor.modifiers.none')} />
      ) : (
        <ul className="staff-list">
          {groups.map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              onAction={(action) => {
                if (action === 'RESTORE') void restore(group);
                else setOpen({ kind: action, group });
              }}
            />
          ))}
        </ul>
      )}
      {open?.kind === 'ADD' || open?.kind === 'EDIT' ? (
        <GroupDialog
          group={open.kind === 'EDIT' ? open.group : undefined}
          onSaved={(saved) => {
            toast.show({
              title: t('menuEditor.modifiers.saved', { name: saved.name }),
              tone: 'success',
            });
            close();
            reload();
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'ARCHIVE' ? (
        <ReasonDialog
          title={t('menuEditor.modifiers.archiveDialog.title', { name: open.group.name })}
          description={t('menuEditor.modifiers.archiveDialog.description')}
          label={t('menuEditor.modifiers.archiveDialog.reason')}
          confirmLabel={t('menuEditor.modifiers.archiveDialog.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void archive(open.group, reason);
          }}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

type GroupAction = 'EDIT' | 'ARCHIVE' | 'RESTORE';

const ACTION_LABELS = {
  EDIT: 'menuEditor.modifiers.edit',
  ARCHIVE: 'menuEditor.modifiers.archive',
  RESTORE: 'menuEditor.modifiers.restore',
} as const;

/** One group: its rule, its options with their price changes, and how many items offer it. */
function GroupRow({
  group,
  onAction,
}: {
  group: ModifierGroupView;
  onAction: (action: GroupAction) => void;
}) {
  const t = useT();
  const active = group.archivedAt === null;
  const actions: readonly GroupAction[] = active ? ['EDIT', 'ARCHIVE'] : ['RESTORE'];
  const options = group.options.filter((option) => option.archivedAt === null);
  return (
    <li className="staff-row" data-inactive={active ? undefined : true}>
      <div className="staff-row__who">
        <h3 className="staff-row__name">
          {group.name}
          {active ? null : <Badge tone="neutral">{t('menuEditor.modifiers.archived')}</Badge>}
        </h3>
        <p className="staff-row__role menu-facts">
          <span>{ruleOf(group, t)}</span>
          <span>{t('menuEditor.modifiers.usedBy', { count: group.itemCount })}</span>
        </p>
        <ul className="menu-options">
          {options.map((option) => {
            const name = option.available
              ? option.name
              : t('menuEditor.modifiers.unavailable', { name: option.name });
            return (
              <li key={option.id}>
                {name}
                {option.priceDelta === 0 ? null : (
                  <span className="menu-options__price">
                    {option.priceDelta > 0
                      ? `+${formatRupees(option.priceDelta)}`
                      : formatRupees(option.priceDelta)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('menuEditor.modifiers.actionsFor', { name: group.name })}
      >
        {actions.map((action) => (
          <Button
            key={action}
            variant="secondary"
            onClick={() => {
              onAction(action);
            }}
          >
            {t(ACTION_LABELS[action])}
          </Button>
        ))}
      </div>
    </li>
  );
}

/**
 * Adds a modifier group or edits one (MENU-004): its name, how many to choose (0 makes it
 * optional) and its options with their price changes. An option left out is archived; orders
 * that chose it keep it.
 */
function GroupDialog({
  group,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  group: ModifierGroupView | undefined;
  onSaved: (saved: ModifierGroupView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const [form, setForm] = useState<GroupForm>(() =>
    group === undefined ? emptyGroupForm() : groupFormOf(group),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const problems = checkGroup(form);
  const problemOf = (field: string): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`menuEditor.modifiers.dialog.${problem}`)
      : undefined;
  };
  const setOption = (key: string, change: Partial<OptionForm>) => {
    setForm((current) => ({
      ...current,
      options: current.options.map((option) =>
        option.key === key ? { ...option, ...change } : option,
      ),
    }));
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(undefined);
    const body = groupRequestOf(form);
    try {
      const saved =
        group === undefined
          ? await controller.api.createModifierGroup({ body })
          : await controller.api.updateModifierGroup({ params: { id: group.id }, body });
      onSaved(saved);
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const countProblem = problemOf('count');
  const optionsProblem = problemOf('options');
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="lg"
      title={
        group === undefined
          ? t('menuEditor.modifiers.dialog.addTitle')
          : t('menuEditor.modifiers.dialog.editTitle', { name: group.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('menuEditor.modifiers.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('menuEditor.modifiers.dialog.save')}
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
          void save();
        }}
      >
        <TextField
          label={t('menuEditor.modifiers.dialog.name')}
          hint={t('menuEditor.modifiers.dialog.nameHint')}
          value={form.name}
          maxLength={60}
          autoComplete="off"
          required
          data-autofocus
          error={problemOf('name')}
          onChange={(event) => {
            const name = event.target.value;
            setForm((current) => ({ ...current, name }));
          }}
        />
        <div className="menu-editor__row">
          <TextField
            label={t('menuEditor.modifiers.dialog.min')}
            hint={t('menuEditor.modifiers.dialog.minHint')}
            inputMode="numeric"
            autoComplete="off"
            value={form.min}
            maxLength={2}
            error={countProblem}
            onChange={(event) => {
              const min = event.target.value;
              setForm((current) => ({ ...current, min }));
            }}
          />
          <TextField
            label={t('menuEditor.modifiers.dialog.max')}
            inputMode="numeric"
            autoComplete="off"
            value={form.max}
            maxLength={2}
            onChange={(event) => {
              const max = event.target.value;
              setForm((current) => ({ ...current, max }));
            }}
          />
        </div>
        <fieldset className="menu-editor__section">
          <legend className="menu-editor__legend">
            {t('menuEditor.modifiers.dialog.options')}
          </legend>
          <p className="rp-field__hint">{t('menuEditor.modifiers.dialog.optionPriceHint')}</p>
          {form.options.map((option, index) => (
            <div key={option.key} className="menu-option-row">
              <div className="menu-editor__row menu-editor__row--removable">
                <TextField
                  label={t('menuEditor.modifiers.dialog.optionName', { number: index + 1 })}
                  value={option.name}
                  maxLength={60}
                  autoComplete="off"
                  error={problemOf(`option:${option.key}:name`)}
                  onChange={(event) => {
                    setOption(option.key, { name: event.target.value });
                  }}
                />
                <TextField
                  label={t('menuEditor.modifiers.dialog.optionPrice', { number: index + 1 })}
                  inputMode="decimal"
                  autoComplete="off"
                  value={option.priceDelta}
                  error={problemOf(`option:${option.key}:price`)}
                  onChange={(event) => {
                    setOption(option.key, { priceDelta: event.target.value });
                  }}
                />
                <IconButton
                  label={t('menuEditor.modifiers.dialog.removeOption', { number: index + 1 })}
                  icon={<Icon name="close" />}
                  disabled={form.options.length === 1}
                  onClick={() => {
                    setForm((current) => ({
                      ...current,
                      options: current.options.filter((other) => other.key !== option.key),
                    }));
                  }}
                />
              </div>
              <label className="console-check">
                <input
                  type="checkbox"
                  checked={option.available}
                  onChange={(event) => {
                    setOption(option.key, { available: event.target.checked });
                  }}
                />
                {t('menuEditor.modifiers.dialog.optionAvailable', { number: index + 1 })}
              </label>
            </div>
          ))}
          {optionsProblem === undefined ? null : (
            <p className="rp-field__error">{optionsProblem}</p>
          )}
          {form.options.length < 50 ? (
            <div>
              <Button
                variant="secondary"
                startIcon={<Icon name="plus" />}
                onClick={() => {
                  setForm((current) => ({
                    ...current,
                    options: [...current.options, emptyOption()],
                  }));
                }}
              >
                {t('menuEditor.modifiers.dialog.addOption')}
              </Button>
            </div>
          ) : null}
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
