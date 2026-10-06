import type {
  MenuSnapshot,
  RecommendationPreference,
  RecommendationPreferenceView,
  RecommendationRuleView,
} from '@rp/contracts';
import { Button, ChoiceGroup, Dialog, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import {
  CHANNELS,
  categoriesOf,
  categoryChoice,
  checkRule,
  dishesOf,
  emptyRuleForm,
  LABEL_MAX,
  PREFERENCES,
  PRIORITY_MAX,
  preferenceOf,
  type RuleField,
  type RuleForm,
  requestOfRule,
  ruleFormOf,
  ruleRequestOf,
  sameRuleRequest,
  type TargetKind,
  takesLabel,
} from './suggestions-view.js';

const isPreference = (value: string): value is RecommendationPreference =>
  (PREFERENCES as readonly string[]).includes(value);

/** One side of a rule: a dish, or any dish of a category, chosen from the published menu. */
function TargetFields({
  legend,
  kind,
  id,
  menu,
  error,
  autoFocus,
  onChange,
}: {
  legend: string;
  kind: TargetKind;
  id: string;
  menu: MenuSnapshot;
  error: string | undefined;
  autoFocus?: boolean;
  onChange: (kind: TargetKind, id: string) => void;
}) {
  const t = useT();
  const name = useId();
  return (
    <fieldset className="settings-window">
      <legend className="settings-window__legend">{legend}</legend>
      <div className="menu-facts">
        {(['ITEM', 'CATEGORY'] as const).map((choice) => (
          <label key={choice} className="console-check">
            <input
              type="radio"
              name={name}
              checked={kind === choice}
              onChange={() => {
                onChange(choice, '');
              }}
            />
            {t(`suggestions.rules.dialog.kind.${choice}`)}
          </label>
        ))}
      </div>
      {kind === 'ITEM' ? (
        <Select
          label={t('suggestions.rules.dialog.dish')}
          placeholder={t('suggestions.rules.dialog.chooseDish')}
          required
          data-autofocus={autoFocus === true ? true : undefined}
          value={id}
          error={error}
          options={dishesOf(menu).map((dish) => ({ value: dish.id, label: dish.name }))}
          onChange={(change) => {
            onChange('ITEM', change.target.value);
          }}
        />
      ) : (
        <Select
          label={t('suggestions.rules.dialog.category')}
          placeholder={t('suggestions.rules.dialog.chooseCategory')}
          required
          value={id}
          error={error}
          options={categoriesOf(menu).map((category) => ({
            value: category.id,
            label: categoryChoice(t, category, menu),
          }))}
          onChange={(change) => {
            onChange('CATEGORY', change.target.value);
          }}
        />
      )}
    </fieldset>
  );
}

/**
 * Adds a rule or changes one (REC-002): if the order has a dish or any dish of a category, suggest
 * another, with a priority, the places it shows, and optionally hours, dates and the restaurant's
 * own words. Checked as the server checks it; the server's refusal is shown as it says it.
 */
export function SuggestionRuleDialog({
  rule,
  menu,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  rule: RecommendationRuleView | undefined;
  menu: MenuSnapshot;
  onSaved: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const [form, setForm] = useState<RuleForm>(() =>
    rule === undefined ? emptyRuleForm() : ruleFormOf(rule),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const problems = checkRule(form);
  const problemOf = (field: RuleField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`suggestions.rules.dialog.problems.${problem}`)
      : undefined;
  };
  const change = (changes: Partial<RuleForm>) => {
    setForm((current) => ({ ...current, ...changes }));
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    const body = ruleRequestOf(form);
    // Nothing changed: nothing to send.
    if (rule !== undefined && sameRuleRequest(body, requestOfRule(rule))) {
      onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (rule === undefined) await controller.api.createRecommendationRule({ body });
      else await controller.api.updateRecommendationRule({ params: { ruleId: rule.id }, body });
      onSaved();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t(
        rule === undefined
          ? 'suggestions.rules.dialog.addTitle'
          : 'suggestions.rules.dialog.editTitle',
      )}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('settings.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('settings.dialog.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(submit) => {
          submit.preventDefault();
          void save();
        }}
      >
        <TargetFields
          legend={t('suggestions.rules.dialog.when')}
          kind={form.whenKind}
          id={form.whenId}
          menu={menu}
          error={problemOf('when')}
          autoFocus
          onChange={(whenKind, whenId) => {
            change({ whenKind, whenId });
          }}
        />
        <TargetFields
          legend={t('suggestions.rules.dialog.suggest')}
          kind={form.suggestKind}
          id={form.suggestId}
          menu={menu}
          error={problemOf('suggest')}
          onChange={(suggestKind, suggestId) => {
            change({ suggestKind, suggestId });
          }}
        />
        <TextField
          label={t('suggestions.rules.dialog.priority')}
          hint={t('suggestions.rules.dialog.priorityHint')}
          className="menu-editor__short"
          inputMode="numeric"
          autoComplete="off"
          maxLength={String(PRIORITY_MAX).length}
          value={form.priority}
          error={problemOf('priority')}
          onChange={(event) => {
            change({ priority: event.target.value });
          }}
        />
        <ChoiceGroup
          legend={t('suggestions.rules.dialog.channels')}
          mode="multiple"
          options={CHANNELS.map((channel) => ({
            id: channel,
            label: t(`menuEditor.editor.channel.${channel}`),
          }))}
          value={form.channels}
          error={problemOf('channels')}
          onChange={(chosen) => {
            change({ channels: CHANNELS.filter((channel) => chosen.includes(channel)) });
          }}
        />
        <label className="console-check">
          <input
            type="checkbox"
            checked={form.hoursOnly}
            onChange={(event) => {
              change({ hoursOnly: event.target.checked });
            }}
          />
          {t('suggestions.rules.dialog.hoursOnly')}
        </label>
        {form.hoursOnly ? (
          <fieldset className="settings-window">
            <legend className="settings-window__legend">
              {t('suggestions.rules.dialog.hours')}
            </legend>
            <div className="settings-window__times">
              <TextField
                label={t('settings.dialog.start')}
                type="time"
                value={form.start}
                error={problemOf('hours')}
                onChange={(event) => {
                  change({ start: event.target.value });
                }}
              />
              <TextField
                label={t('settings.dialog.end')}
                type="time"
                value={form.end}
                onChange={(event) => {
                  change({ end: event.target.value });
                }}
              />
            </div>
            {form.end !== '' && form.end < form.start ? (
              <p className="dashboard-section__hint">{t('settings.dialog.overnight')}</p>
            ) : null}
          </fieldset>
        ) : null}
        <label className="console-check">
          <input
            type="checkbox"
            checked={form.datesOnly}
            onChange={(event) => {
              change({ datesOnly: event.target.checked });
            }}
          />
          {t('suggestions.rules.dialog.datesOnly')}
        </label>
        {form.datesOnly ? (
          <fieldset className="settings-window">
            <legend className="settings-window__legend">
              {t('suggestions.rules.dialog.dates')}
            </legend>
            <div className="settings-window__times">
              <TextField
                label={t('suggestions.rules.dialog.from')}
                type="date"
                value={form.from}
                error={problemOf('dates')}
                onChange={(event) => {
                  change({ from: event.target.value });
                }}
              />
              <TextField
                label={t('suggestions.rules.dialog.until')}
                type="date"
                value={form.until}
                onChange={(event) => {
                  change({ until: event.target.value });
                }}
              />
            </div>
          </fieldset>
        ) : null}
        <TextField
          label={t('suggestions.rules.dialog.label')}
          hint={t('suggestions.rules.dialog.labelHint')}
          autoComplete="off"
          maxLength={LABEL_MAX}
          value={form.label}
          onChange={(event) => {
            change({ label: event.target.value });
          }}
        />
        <label className="console-check">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(event) => {
              change({ active: event.target.checked });
            }}
          />
          {t('suggestions.rules.dialog.active')}
        </label>
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Pins, boosts or blocks a dish, or puts it back as usual (REC-009), with the restaurant's own
 * words for a pinned or boosted one and an optional reason for the audit log (AUD-001). Without a
 * dish, it asks which one first.
 */
export function DishPreferenceDialog({
  itemId,
  menu,
  preferences,
  onSaved,
  onClose,
}: {
  /** Undefined to choose a dish first. */
  itemId: string | undefined;
  menu: MenuSnapshot;
  preferences: readonly RecommendationPreferenceView[];
  onSaved: (name: string, preference: RecommendationPreference) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const [dishId, setDishId] = useState(itemId ?? '');
  const current = preferenceOf(preferences, dishId);
  const [preference, setPreference] = useState<RecommendationPreference>(current.preference);
  const [label, setLabel] = useState(current.label ?? '');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const dish = menu.items.find((item) => item.id === dishId);
  const name = dish?.name ?? t('suggestions.dishes.unpublished');

  const save = async () => {
    setSubmitted(true);
    if (dishId === '') return;
    const words = takesLabel(preference) && label.trim() !== '' ? label.trim() : null;
    if (preference === current.preference && words === current.label) {
      onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = reason.trim();
      await controller.api.setRecommendationPreference({
        params: { itemId: dishId },
        body: { preference, label: words, ...(trimmed !== '' && { reason: trimmed }) },
      });
      onSaved(name, preference);
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={
        itemId === undefined
          ? t('suggestions.dishes.dialog.addTitle')
          : t('suggestions.dishes.dialog.title', { name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('settings.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('settings.dialog.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(submit) => {
          submit.preventDefault();
          void save();
        }}
      >
        {itemId === undefined ? (
          <Select
            label={t('suggestions.dishes.dialog.dish')}
            placeholder={t('suggestions.dishes.dialog.chooseDish')}
            required
            data-autofocus
            value={dishId}
            error={
              submitted && dishId === '' ? t('suggestions.dishes.dialog.dishMissing') : undefined
            }
            options={dishesOf(menu).map((entry) => ({ value: entry.id, label: entry.name }))}
            onChange={(change) => {
              const chosen = change.target.value;
              const existing = preferenceOf(preferences, chosen);
              setDishId(chosen);
              setPreference(existing.preference === 'NORMAL' ? 'PIN' : existing.preference);
              setLabel(existing.label ?? '');
            }}
          />
        ) : null}
        <ChoiceGroup
          legend={t('suggestions.dishes.dialog.how')}
          hint={preference === 'PIN' ? t('suggestions.dishes.dialog.pinHint') : undefined}
          mode="single"
          options={PREFERENCES.map((choice) => ({
            id: choice,
            label: t(`suggestions.dishes.dialog.choice.${choice}`),
          }))}
          value={[preference]}
          onChange={([chosen]) => {
            if (chosen !== undefined && isPreference(chosen)) setPreference(chosen);
          }}
        />
        {takesLabel(preference) ? (
          <TextField
            label={t('suggestions.dishes.dialog.label')}
            hint={t('suggestions.dishes.dialog.labelHint')}
            autoComplete="off"
            maxLength={LABEL_MAX}
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
        ) : null}
        <TextField
          label={t('settings.dialog.reason')}
          hint={t('settings.dialog.reasonHint')}
          autoComplete="off"
          maxLength={200}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
