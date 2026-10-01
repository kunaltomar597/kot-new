import type { MenuSnapshot, RecommendationRuleView, RecommendationTarget } from '@rp/contracts';
import { formatDisplayDate, ITEM_PREFERENCES, type ItemPreference } from '@rp/domain';
import {
  Badge,
  Button,
  ChoiceGroup,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  TextField,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { Link } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../menu/ReasonDialog.js';
import {
  checkRuleDraft,
  featuredDishes,
  LABEL_MAX,
  menuNames,
  type MenuNames,
  type Preferences,
  PRIORITY_MAX,
  RULE_CHANNELS,
  type RuleChannel,
  type RuleDraft,
  type RuleProblem,
  ruleDraftOf,
  ruleRequestOf,
  type TargetKind,
  targetName,
  withPreference,
} from './recommendations-view.js';

type Translate = ReturnType<typeof useT>;

interface PageData {
  readonly rules: readonly RecommendationRuleView[];
  readonly menu: MenuSnapshot;
  readonly names: MenuNames;
  readonly preferences: Preferences;
  readonly editable: boolean;
}

/** "With Veg Biryani, suggest Raita", for a row and its actions. */
function summaryOf(rule: RecommendationRuleView, names: MenuNames, t: Translate): string {
  const name = (target: RecommendationTarget) => {
    const found = targetName(target, names);
    if (found === undefined) return t('recoPage.rules.gone');
    return target.kind === 'CATEGORY' ? t('recoPage.rules.category', { name: found }) : found;
  };
  return t('recoPage.rules.summary', { when: name(rule.when), suggest: name(rule.suggest) });
}

/** Priority, channels, hours and dates, in one line. */
function detailsOf(rule: RecommendationRuleView, t: Translate): string {
  const parts = [
    t('recoPage.rules.priority', { value: rule.priority }),
    rule.channels.map((channel) => t(`recoPage.channel.${channel}`)).join(', '),
    rule.timeWindow === null
      ? t('recoPage.rules.allDay')
      : t('recoPage.rules.hours', { start: rule.timeWindow.start, end: rule.timeWindow.end }),
  ];
  const from = rule.activeFrom === null ? undefined : formatDisplayDate(rule.activeFrom);
  const until = rule.activeUntil === null ? undefined : formatDisplayDate(rule.activeUntil);
  if (from !== undefined && until !== undefined) {
    parts.push(t('recoPage.rules.between', { from, until }));
  } else if (from !== undefined) {
    parts.push(t('recoPage.rules.from', { date: from }));
  } else if (until !== undefined) {
    parts.push(t('recoPage.rules.until', { date: until }));
  }
  return parts.join(' · ');
}

/**
 * The Suggestions page (P4-03c, REC-002, REC-009): the restaurant's rules ("with biryani, suggest
 * raita") over the rules API of P3-04, each added, changed, paused or archived with a reason, and
 * the dishes it pins, boosts or blocks, kept in the `reco.itemPreferences` setting.
 */
export function RecommendationsScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    async (): Promise<PageData> => {
      const [rules, menu, settings] = await Promise.all([
        controller.api.listRecommendationRules(),
        controller.api.getMenu(),
        controller.api.listSettings(),
      ]);
      const preferences = settings.settings.find(
        (setting) => setting.key === 'reco.itemPreferences',
      );
      return {
        rules: rules.rules,
        menu,
        names: menuNames(menu),
        // The server checked the value against the catalogue's schema.
        preferences: (preferences?.value ?? {}) as Preferences,
        editable: preferences?.editable === true,
      };
    },
    (type) => type === 'SettingsChanged' || type === 'MenuPublished',
  );
  const [editing, setEditing] = useState<RecommendationRuleView | 'new' | undefined>();
  const [archiving, setArchiving] = useState<RecommendationRuleView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = useCallback(() => {
    setEditing(undefined);
    setArchiving(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** Runs a change; a dialog shows a failure inline, a row action as a toast. */
  const run = async (action: () => Promise<unknown>, done: string, inDialog: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      toast.show({ title: done, tone: 'success' });
      close();
      reload();
    } catch (failure) {
      setBusy(false);
      if (inDialog) setError(messageOf(failure, t));
      else toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
  };

  const savePreferences = (preferences: Preferences) =>
    run(
      () =>
        controller.api.updateSetting({
          params: { key: 'reco.itemPreferences' },
          body: { value: preferences },
        }),
      t('recoPage.featured.saved'),
      false,
    );

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('recoPage.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const { rules, names, preferences, editable } = data.value;
    content = (
      <>
        <section className="device-group" aria-labelledby="reco-rules">
          <div className="staff-header">
            <h3 id="reco-rules" className="device-group__heading">
              {t('recoPage.rules.title')}
            </h3>
            {editable ? (
              <Button
                onClick={() => {
                  setEditing('new');
                }}
              >
                {t('recoPage.rules.add')}
              </Button>
            ) : null}
          </div>
          <p className="dashboard-section__hint">{t('recoPage.rules.hint')}</p>
          {rules.length === 0 ? (
            <EmptyState
              title={t('recoPage.rules.empty')}
              description={t('recoPage.rules.emptyHint')}
            />
          ) : (
            <ul className="staff-list" aria-labelledby="reco-rules">
              {rules.map((rule) => {
                const summary = summaryOf(rule, names, t);
                return (
                  <li key={rule.id} className="staff-row">
                    <div className="staff-row__who">
                      <h4 className="staff-row__name">{summary}</h4>
                      {rule.label === null ? null : <p className="staff-row__role">{rule.label}</p>}
                      <p className="staff-row__contact">{detailsOf(rule, t)}</p>
                      <p className="staff-row__states">
                        {rule.active ? (
                          <Badge tone="success">{t('recoPage.rules.on')}</Badge>
                        ) : (
                          <Badge tone="neutral">{t('recoPage.rules.paused')}</Badge>
                        )}
                      </p>
                    </div>
                    {editable ? (
                      <div
                        className="staff-row__actions"
                        role="group"
                        aria-label={t('recoPage.rules.actionsFor', { name: summary })}
                      >
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setEditing(rule);
                          }}
                        >
                          {t('recoPage.rules.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            const request = ruleRequestOf({
                              ...ruleDraftOf(rule),
                              active: !rule.active,
                            });
                            if (request === undefined) {
                              setEditing(rule);
                              return;
                            }
                            void run(
                              () =>
                                controller.api.updateRecommendationRule({
                                  params: { ruleId: rule.id },
                                  body: request,
                                }),
                              rule.active
                                ? t('recoPage.rules.pausedDone')
                                : t('recoPage.rules.resumedDone'),
                              false,
                            );
                          }}
                        >
                          {rule.active ? t('recoPage.rules.pause') : t('recoPage.rules.resume')}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setArchiving(rule);
                          }}
                        >
                          {t('recoPage.rules.archive')}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <FeaturedDishes
          menu={data.value.menu}
          names={names}
          preferences={preferences}
          editable={editable}
          busy={busy}
          onChange={(next) => {
            void savePreferences(next);
          }}
        />
      </>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-reco">
      <div className="staff-header">
        <h2 id="dashboard-reco" className="dashboard-section__heading">
          {t('recoPage.title')}
        </h2>
        <Link to="/manage/settings" className="staff-pages__link">
          {t('recoPage.back')}
        </Link>
      </div>
      <p className="dashboard-section__hint">{t('recoPage.intro')}</p>
      {data.status === 'ready' && !data.value.editable ? (
        <p className="dashboard-section__hint">{t('recoPage.readOnly')}</p>
      ) : null}
      {content}
      {editing !== undefined && data.status === 'ready' ? (
        <RuleDialog
          rule={editing === 'new' ? undefined : editing}
          menu={data.value.menu}
          busy={busy}
          error={error}
          onSave={(request) => {
            void run(
              () =>
                editing === 'new'
                  ? controller.api.createRecommendationRule({ body: request })
                  : controller.api.updateRecommendationRule({
                      params: { ruleId: editing.id },
                      body: request,
                    }),
              editing === 'new' ? t('recoPage.rules.added') : t('recoPage.rules.saved'),
              true,
            );
          }}
          onClose={close}
        />
      ) : null}
      {archiving !== undefined && data.status === 'ready' ? (
        <ReasonDialog
          title={t('recoPage.rules.archiveTitle')}
          description={t('recoPage.rules.archiveDescription', {
            name: summaryOf(archiving, data.value.names, t),
          })}
          confirmLabel={t('recoPage.rules.archive')}
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void run(
              () =>
                controller.api.archiveRecommendationRule({
                  params: { ruleId: archiving.id },
                  body: { reason },
                }),
              t('recoPage.rules.archived'),
              true,
            );
          }}
          onCancel={close}
        />
      ) : null}
    </section>
  );
}

/** The dishes the restaurant pins, boosts or blocks (REC-009), and a form to add one. */
function FeaturedDishes({
  menu,
  names,
  preferences,
  editable,
  busy,
  onChange,
}: {
  menu: MenuSnapshot;
  names: MenuNames;
  preferences: Preferences;
  editable: boolean;
  busy: boolean;
  onChange: (preferences: Preferences) => void;
}) {
  const t = useT();
  const [dish, setDish] = useState('');
  const [how, setHow] = useState<ItemPreference>('PIN');
  const dishes = featuredDishes(preferences, names);
  const choices = menu.items
    .filter((item) => preferences[item.id] === undefined)
    .sort((a, b) => a.name.localeCompare(b.name, 'en-IN'));
  const howOptions = ITEM_PREFERENCES.map((preference) => ({
    value: preference,
    label: t(`recoPage.featured.choice.${preference}`),
  }));
  return (
    <section className="device-group" aria-labelledby="reco-featured">
      <h3 id="reco-featured" className="device-group__heading">
        {t('recoPage.featured.title')}
      </h3>
      <p className="dashboard-section__hint">{t('recoPage.featured.hint')}</p>
      {dishes.length === 0 ? (
        <EmptyState title={t('recoPage.featured.empty')} />
      ) : (
        <ul className="staff-list" aria-labelledby="reco-featured">
          {dishes.map((entry) => {
            const name = entry.name ?? t('recoPage.featured.gone');
            return (
              <li key={entry.itemId} className="staff-row">
                <div className="staff-row__who">
                  <h4 className="staff-row__name">{name}</h4>
                  <p className="staff-row__states">
                    <Badge
                      tone={
                        entry.preference === 'BLOCK'
                          ? 'danger'
                          : entry.preference === 'PIN'
                            ? 'info'
                            : 'success'
                      }
                    >
                      {t(`recoPage.featured.preference.${entry.preference}`)}
                    </Badge>
                  </p>
                </div>
                {editable ? (
                  <div className="staff-row__actions">
                    <Select
                      label={t('recoPage.featured.howFor', { name })}
                      value={entry.preference}
                      options={howOptions}
                      disabled={busy}
                      onChange={(event) => {
                        onChange(
                          withPreference(
                            preferences,
                            entry.itemId,
                            event.target.value as ItemPreference,
                          ),
                        );
                      }}
                    />
                    <Button
                      variant="ghost"
                      disabled={busy}
                      aria-label={t('recoPage.featured.removeFor', { name })}
                      onClick={() => {
                        onChange(withPreference(preferences, entry.itemId, undefined));
                      }}
                    >
                      {t('recoPage.featured.remove')}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {editable ? (
        <form
          className="menu-form__row"
          aria-label={t('recoPage.featured.add')}
          onSubmit={(event) => {
            event.preventDefault();
            if (dish === '') return;
            onChange(withPreference(preferences, dish, how));
            setDish('');
          }}
        >
          <Select
            label={t('recoPage.featured.dish')}
            placeholder={t('recoPage.featured.chooseDish')}
            value={dish}
            options={choices.map((item) => ({ value: item.id, label: item.name }))}
            onChange={(event) => {
              setDish(event.target.value);
            }}
          />
          <Select
            label={t('recoPage.featured.how')}
            value={how}
            options={howOptions}
            onChange={(event) => {
              setHow(event.target.value as ItemPreference);
            }}
          />
          <Button type="submit" variant="secondary" disabled={busy || dish === ''}>
            {t('recoPage.featured.add')}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function RuleDialog({
  rule,
  menu,
  busy,
  error,
  onSave,
  onClose,
}: {
  rule: RecommendationRuleView | undefined;
  menu: MenuSnapshot;
  busy: boolean;
  error: string | undefined;
  onSave: (request: NonNullable<ReturnType<typeof ruleRequestOf>>) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState<RuleDraft>(() => ruleDraftOf(rule));
  const [submitted, setSubmitted] = useState(false);
  const problems = checkRuleDraft(draft);
  const problemText = (...kinds: RuleProblem[]) => {
    const problem = problems.find((entry) => kinds.includes(entry));
    return submitted && problem !== undefined ? t(`recoPage.problems.${problem}`) : undefined;
  };
  const change = (changes: Partial<RuleDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  };
  const items = [...menu.items]
    .sort((a, b) => a.name.localeCompare(b.name, 'en-IN'))
    .map((item) => ({ value: item.id, label: item.name }));
  const categories = [...menu.categories]
    .sort((a, b) => a.name.localeCompare(b.name, 'en-IN'))
    .map((category) => ({ value: category.id, label: category.name }));
  const kinds = (['ITEM', 'CATEGORY'] as const).map((kind) => ({
    value: kind,
    label: t(`recoPage.dialog.kinds.${kind}`),
  }));

  const target = (
    legend: string,
    kind: TargetKind,
    id: string,
    onKind: (kind: TargetKind) => void,
    onId: (id: string) => void,
    problem: string | undefined,
  ) => (
    <fieldset className="menu-form__section">
      <legend>{legend}</legend>
      <div className="menu-form__row">
        <Select
          label={t('recoPage.dialog.kind')}
          value={kind}
          options={kinds}
          onChange={(event) => {
            onKind(event.target.value as TargetKind);
          }}
        />
        <Select
          label={kind === 'ITEM' ? t('recoPage.dialog.dish') : t('recoPage.dialog.category')}
          placeholder={
            kind === 'ITEM' ? t('recoPage.dialog.chooseDish') : t('recoPage.dialog.chooseCategory')
          }
          value={id}
          options={kind === 'ITEM' ? items : categories}
          error={problem}
          onChange={(event) => {
            onId(event.target.value);
          }}
        />
      </div>
    </fieldset>
  );

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      title={rule === undefined ? t('recoPage.dialog.addTitle') : t('recoPage.dialog.editTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('recoPage.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('recoPage.dialog.save')}
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
          const request = ruleRequestOf(draft);
          if (request !== undefined) onSave(request);
        }}
      >
        {target(
          t('recoPage.dialog.when'),
          draft.whenKind,
          draft.whenId,
          (whenKind) => {
            change({ whenKind, whenId: '' });
          },
          (whenId) => {
            change({ whenId });
          },
          problemText('WHEN_REQUIRED'),
        )}
        {target(
          t('recoPage.dialog.suggest'),
          draft.suggestKind,
          draft.suggestId,
          (suggestKind) => {
            change({ suggestKind, suggestId: '' });
          },
          (suggestId) => {
            change({ suggestId });
          },
          problemText('SUGGEST_REQUIRED', 'SAME_DISH'),
        )}
        <TextField
          label={t('recoPage.dialog.label')}
          hint={t('recoPage.dialog.labelHint')}
          value={draft.label}
          maxLength={LABEL_MAX}
          autoComplete="off"
          onChange={(event) => {
            change({ label: event.target.value });
          }}
        />
        <TextField
          label={t('recoPage.dialog.priority')}
          hint={t('recoPage.dialog.priorityHint')}
          value={draft.priority}
          inputMode="numeric"
          maxLength={String(PRIORITY_MAX).length}
          autoComplete="off"
          error={problemText('PRIORITY')}
          onChange={(event) => {
            change({ priority: event.target.value });
          }}
        />
        <ChoiceGroup
          legend={t('recoPage.dialog.channels')}
          mode="multiple"
          options={RULE_CHANNELS.map((channel) => ({
            id: channel,
            label: t(`recoPage.channel.${channel}`),
          }))}
          value={[...draft.channels]}
          error={problemText('CHANNELS_REQUIRED')}
          onChange={(channels) => {
            change({ channels: channels as RuleChannel[] });
          }}
        />
        <label className="menu-toolbar__check">
          <input
            type="checkbox"
            checked={draft.hours}
            onChange={(event) => {
              change({ hours: event.target.checked });
            }}
          />
          {t('recoPage.dialog.hours')}
        </label>
        {draft.hours ? (
          <div className="menu-form__row">
            <TextField
              label={t('recoPage.dialog.start')}
              type="time"
              value={draft.start}
              onChange={(event) => {
                change({ start: event.target.value });
              }}
            />
            <TextField
              label={t('recoPage.dialog.end')}
              type="time"
              value={draft.end}
              error={problemText('HOURS')}
              onChange={(event) => {
                change({ end: event.target.value });
              }}
            />
          </div>
        ) : null}
        <div className="menu-form__row">
          <TextField
            label={t('recoPage.dialog.from')}
            type="date"
            value={draft.from}
            onChange={(event) => {
              change({ from: event.target.value });
            }}
          />
          <TextField
            label={t('recoPage.dialog.until')}
            type="date"
            value={draft.until}
            error={problemText('DATES')}
            onChange={(event) => {
              change({ until: event.target.value });
            }}
          />
        </div>
        <label className="menu-toolbar__check">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(event) => {
              change({ active: event.target.checked });
            }}
          />
          {t('recoPage.dialog.active')}
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
