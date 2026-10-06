import { ApiRequestError } from '@rp/api-client';
import type {
  MenuSnapshot,
  RecommendationPreference,
  RecommendationPreferenceView,
  RecommendationRuleView,
} from '@rp/contracts';
import type { RecoChannel } from '@rp/domain';
import type { Tone } from '@rp/design-tokens';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Select,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { DishPreferenceDialog, SuggestionRuleDialog } from './SuggestionDialogs.js';
import {
  CHANNELS,
  channelsText,
  datesText,
  dishesOf,
  hoursText,
  preferenceRows,
  previewRow,
  requestOfRule,
  ruleReason,
  ruleTitle,
} from './suggestions-view.js';

/** What the page reads: the published menu (null before the first publish), rules, preferences. */
interface SuggestionsData {
  readonly menu: MenuSnapshot | null;
  readonly rules: readonly RecommendationRuleView[];
  readonly preferences: readonly RecommendationPreferenceView[];
}

/** A published menu or a dish's availability changes what can be chosen and suggested. */
const AFFECTS = new Set(['MenuPublished', 'ItemAvailabilityChanged']);

/** How many suggestions the preview asks for, as a tablet shows them. */
const PREVIEW_LIMIT = 6;

const PREFERENCE_TONES: Record<RecommendationPreference, Tone> = {
  NORMAL: 'neutral',
  PIN: 'success',
  BOOST: 'info',
  BLOCK: 'danger',
};

type Open =
  | { readonly kind: 'ADD_RULE' }
  | { readonly kind: 'EDIT_RULE' | 'ARCHIVE_RULE'; readonly rule: RecommendationRuleView }
  | { readonly kind: 'DISH'; readonly itemId: string | undefined };

/**
 * The Suggestions page (P4-03c, MGR-007, REC-002, REC-009): the restaurant's rules ("if the order
 * has X, suggest Y") with their priority, places, hours, dates and words, paused or removed with a
 * reason; its pinned, boosted and blocked dishes; and a preview of what a table is suggested now,
 * read from the server as the tablets read it. Every change is audited by the server.
 */
export function SuggestionsScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    async (): Promise<SuggestionsData> => {
      const [menu, rules, preferences] = await Promise.all([
        controller.api.getMenu().catch((failure: unknown) => {
          if (failure instanceof ApiRequestError && failure.code === 'MENU_NOT_PUBLISHED') {
            return null;
          }
          throw failure;
        }),
        controller.api.listRecommendationRules(),
        controller.api.listRecommendationPreferences(),
      ]);
      return { menu, rules: rules.rules, preferences: preferences.preferences };
    },
    (type) => AFFECTS.has(type),
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /** Changes on every save, so the preview reads again. */
  const [version, setVersion] = useState(0);

  const close = () => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  };
  const changed = (title: string) => {
    toast.show({ title, tone: 'success' });
    close();
    reload();
    setVersion((current) => current + 1);
  };

  const setActive = async (rule: RecommendationRuleView, active: boolean) => {
    try {
      await controller.api.updateRecommendationRule({
        params: { ruleId: rule.id },
        body: requestOfRule(rule, { active }),
      });
      changed(t(active ? 'suggestions.rules.resumed' : 'suggestions.rules.paused'));
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
  };

  const archive = async (rule: RecommendationRuleView, reason: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.archiveRecommendationRule({
        params: { ruleId: rule.id },
        body: { reason },
      });
      changed(t('suggestions.rules.archived'));
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  let content: ReactNode;
  let dialog: ReactNode = null;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('suggestions.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else if (data.value.menu === null) {
    content = <EmptyState title={t('suggestions.noMenu')} />;
  } else {
    const { rules, preferences } = data.value;
    const menu = data.value.menu;
    const dishes = preferenceRows(t, preferences, menu);
    content = (
      <>
        <section className="settings-group" aria-labelledby="suggestions-rules">
          <div className="staff-header">
            <h3 id="suggestions-rules" className="settings-group__heading">
              {t('suggestions.rules.title')}
            </h3>
            <Button
              startIcon={<Icon name="plus" />}
              onClick={() => {
                setOpen({ kind: 'ADD_RULE' });
              }}
            >
              {t('suggestions.rules.add')}
            </Button>
          </div>
          <p className="dashboard-section__hint">{t('suggestions.rules.intro')}</p>
          {rules.length === 0 ? (
            <EmptyState title={t('suggestions.rules.none')} />
          ) : (
            <ul className="staff-list">
              {rules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  menu={menu}
                  onEdit={() => {
                    setOpen({ kind: 'EDIT_RULE', rule });
                  }}
                  onToggle={() => {
                    void setActive(rule, !rule.active);
                  }}
                  onArchive={() => {
                    setOpen({ kind: 'ARCHIVE_RULE', rule });
                  }}
                />
              ))}
            </ul>
          )}
        </section>
        <section className="settings-group" aria-labelledby="suggestions-dishes">
          <div className="staff-header">
            <h3 id="suggestions-dishes" className="settings-group__heading">
              {t('suggestions.dishes.title')}
            </h3>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen({ kind: 'DISH', itemId: undefined });
              }}
            >
              {t('suggestions.dishes.add')}
            </Button>
          </div>
          <p className="dashboard-section__hint">{t('suggestions.dishes.intro')}</p>
          {dishes.length === 0 ? (
            <EmptyState title={t('suggestions.dishes.none')} />
          ) : (
            <ul className="staff-list">
              {dishes.map(({ preference, name }) => (
                <li key={preference.itemId} className="staff-row">
                  <div className="staff-row__who">
                    <h4 className="staff-row__name">{name}</h4>
                    <p className="staff-row__states">
                      <Badge tone={PREFERENCE_TONES[preference.preference]}>
                        {t(`suggestions.dishes.preference.${preference.preference}`)}
                      </Badge>
                    </p>
                    {preference.label === null ? null : (
                      <p className="staff-row__contact">
                        {t('suggestions.dishes.shows', { text: preference.label })}
                      </p>
                    )}
                  </div>
                  <div className="staff-row__actions">
                    <Button
                      variant="secondary"
                      aria-label={t('suggestions.dishes.changeLabel', { name })}
                      onClick={() => {
                        setOpen({ kind: 'DISH', itemId: preference.itemId });
                      }}
                    >
                      {t('suggestions.dishes.change')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <Preview menu={menu} version={version} />
      </>
    );
    if (open?.kind === 'ADD_RULE' || open?.kind === 'EDIT_RULE') {
      dialog = (
        <SuggestionRuleDialog
          rule={open.kind === 'EDIT_RULE' ? open.rule : undefined}
          menu={menu}
          onSaved={() => {
            changed(t('suggestions.rules.dialog.saved'));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ARCHIVE_RULE') {
      dialog = (
        <ReasonDialog
          title={t('suggestions.rules.archiveDialog.title')}
          description={t('suggestions.rules.archiveDialog.description', {
            title: ruleTitle(t, open.rule, menu),
          })}
          label={t('suggestions.rules.archiveDialog.reason')}
          confirmLabel={t('suggestions.rules.archiveDialog.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void archive(open.rule, reason);
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'DISH') {
      dialog = (
        <DishPreferenceDialog
          key={open.itemId ?? 'new'}
          itemId={open.itemId}
          menu={menu}
          preferences={preferences}
          onSaved={(name, preference) => {
            changed(t(`suggestions.dishes.dialog.saved.${preference}`, { name }));
          }}
          onClose={close}
        />
      );
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-suggestions">
      <h2 id="dashboard-suggestions" className="dashboard-section__heading">
        {t('suggestions.title')}
      </h2>
      <p className="dashboard-section__hint">{t('suggestions.intro')}</p>
      {content}
      {dialog}
    </section>
  );
}

/** One rule: what it does, the words shown with it, priority, hours, dates and places. */
function RuleRow({
  rule,
  menu,
  onEdit,
  onToggle,
  onArchive,
}: {
  rule: RecommendationRuleView;
  menu: MenuSnapshot;
  onEdit: () => void;
  onToggle: () => void;
  onArchive: () => void;
}) {
  const t = useT();
  const title = ruleTitle(t, rule, menu);
  return (
    <li className="staff-row" data-inactive={rule.active ? undefined : true}>
      <div className="staff-row__who">
        <h4 className="staff-row__name">
          {title}
          {rule.active ? null : <Badge tone="neutral">{t('suggestions.rules.row.paused')}</Badge>}
        </h4>
        <p className="settings-row__value">
          {t('suggestions.rules.row.shows', { text: ruleReason(t, rule, menu) })}
        </p>
        <p className="staff-row__contact menu-facts">
          <span>{t('suggestions.rules.row.priority', { priority: rule.priority })}</span>
          <span>{hoursText(t, rule)}</span>
          <span>{datesText(t, rule)}</span>
        </p>
        <p className="staff-row__states">
          {channelsText(t, rule.channels).map((channel) => (
            <Badge key={channel} tone="neutral">
              {channel}
            </Badge>
          ))}
        </p>
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('suggestions.rules.row.actionsFor', { title })}
      >
        <Button variant="secondary" onClick={onEdit}>
          {t('suggestions.rules.row.edit')}
        </Button>
        <Button variant="secondary" onClick={onToggle}>
          {t(rule.active ? 'suggestions.rules.row.pause' : 'suggestions.rules.row.resume')}
        </Button>
        <Button variant="secondary" onClick={onArchive}>
          {t('suggestions.rules.row.archive')}
        </Button>
      </div>
    </li>
  );
}

/**
 * What a table is suggested now (REC-001, REC-006): the server's suggestions for a place and,
 * optionally, a dish in the order, with the reason the tablets show and where each comes from.
 * Read again after every change on the page and when the menu or a dish's availability changes.
 */
function Preview({ menu, version }: { menu: MenuSnapshot; version: number }) {
  const t = useT();
  const controller = useConsole();
  const [channel, setChannel] = useState<RecoChannel>('TABLE_TABLET');
  const [dish, setDish] = useState('');
  const { data, reload } = useLive(
    async () =>
      (
        await controller.api.getRecommendations({
          query: { channel, cart: dish === '' ? [] : [dish], limit: PREVIEW_LIMIT },
        })
      ).recommendations,
    (type) => AFFECTS.has(type),
  );
  // The first read is the live data's own; a change of place, dish or settings reads again.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [channel, dish, version, reload]);

  let list: ReactNode;
  if (data.status === 'loading') {
    list = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    list = (
      <ErrorState
        title={t('suggestions.preview.failed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else if (data.value.length === 0) {
    list = <EmptyState title={t('suggestions.preview.none')} />;
  } else {
    list = (
      <ol className="staff-list" aria-label={t('suggestions.preview.list')}>
        {data.value.map((suggestion) => {
          const row = previewRow(t, suggestion, menu);
          return (
            <li key={row.itemId} className="staff-row">
              <div className="staff-row__who">
                <h4 className="staff-row__name">{row.name}</h4>
                <p className="staff-row__contact">{row.reason}</p>
              </div>
              <p className="staff-row__states">
                <Badge tone="neutral">{row.layer}</Badge>
              </p>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <section className="settings-group" aria-labelledby="suggestions-preview">
      <h3 id="suggestions-preview" className="settings-group__heading">
        {t('suggestions.preview.title')}
      </h3>
      <p className="dashboard-section__hint">{t('suggestions.preview.intro')}</p>
      <div className="menu-editor__row">
        <Select
          label={t('suggestions.preview.channel')}
          value={channel}
          options={CHANNELS.map((option) => ({
            value: option,
            label: t(`menuEditor.editor.channel.${option}`),
          }))}
          onChange={(change) => {
            const chosen = CHANNELS.find((option) => option === change.target.value);
            if (chosen !== undefined) {
              setChannel(chosen);
            }
          }}
        />
        <Select
          label={t('suggestions.preview.dish')}
          value={dish}
          options={[
            { value: '', label: t('suggestions.preview.nothing') },
            ...dishesOf(menu).map((entry) => ({ value: entry.id, label: entry.name })),
          ]}
          onChange={(change) => {
            setDish(change.target.value);
          }}
        />
      </div>
      {list}
    </section>
  );
}
