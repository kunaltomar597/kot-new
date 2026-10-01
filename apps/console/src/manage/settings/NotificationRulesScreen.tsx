import {
  channelChoices,
  checkRule,
  effectiveRule,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationRule,
  type NotificationRuleOverride,
  PAGER_TEXT_MAX,
  recipientChoices,
  REPEAT_POLICIES,
  type RepeatPolicy,
  ruleOverride,
} from '@rp/domain';
import {
  Badge,
  Button,
  ChoiceGroup,
  Dialog,
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

type Overrides = Partial<Record<NotificationEvent, NotificationRuleOverride>>;
type Translate = ReturnType<typeof useT>;

interface RulesData {
  readonly overrides: Overrides;
  readonly editable: boolean;
  readonly escalation: number;
  readonly repeat: number;
}

function repeatText(repeat: RepeatPolicy, seconds: number, t: Translate): string {
  return t(`notificationRules.repeat.${repeat}`, {
    repeat: t('notificationRules.seconds', { value: seconds }),
  });
}

/**
 * The notification rules (P4-03b, NTF-002, BRD Appendix C): for each event, who is alerted, on
 * which channels, what the pager shows, whether it goes to the managers when nobody acknowledges
 * it and how it repeats. Only the differences from the factory rules are stored, in the
 * `notifications.rules` setting, so a rule set back to the factory follows later factory changes.
 */
export function NotificationRulesScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    async (): Promise<RulesData> => {
      const { settings } = await controller.api.listSettings();
      const find = (key: string) => settings.find((setting) => setting.key === key);
      const rules = find('notifications.rules');
      return {
        // The server checked the value against the catalogue's schema.
        overrides: rules?.value ?? {},
        editable: rules?.editable === true,
        escalation: Number(find('notifications.escalationSeconds')?.value ?? 60),
        repeat: Number(find('notifications.repeatSeconds')?.value ?? 60),
      };
    },
    (type) => type === 'SettingsChanged',
  );
  const [editing, setEditing] = useState<NotificationEvent | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = useCallback(() => {
    setEditing(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** Saves the whole set with this event's difference from the factory rule (or none). */
  const store = async (
    current: Overrides,
    event: NotificationEvent,
    override: NotificationRuleOverride | undefined,
    done: string,
  ) => {
    setBusy(true);
    setError(undefined);
    const next: Overrides = Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== event),
    );
    if (override !== undefined) next[event] = override;
    try {
      await controller.api.updateSetting({
        params: { key: 'notifications.rules' },
        body: { value: next },
      });
      toast.show({ title: done, tone: 'success' });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
      if (editing === undefined) toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('notificationRules.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const { overrides, editable, repeat } = data.value;
    content = (
      <ul className="staff-list" aria-label={t('notificationRules.title')}>
        {NOTIFICATION_EVENTS.map((event) => {
          const rule = effectiveRule(event, overrides);
          const name = t(`alerts.type.${event}`);
          const changed = overrides[event] !== undefined;
          return (
            <li key={event} className="staff-row">
              <div className="staff-row__who">
                <h3 className="staff-row__name">{name}</h3>
                <p className="staff-row__role">
                  {t('notificationRules.who', {
                    list: rule.recipients
                      .map((kind) => t(`notificationRules.recipient.${kind}`))
                      .join(', '),
                  })}
                </p>
                <p className="staff-row__contact">
                  {t('notificationRules.where', {
                    list: rule.channels
                      .map((channel) => t(`notificationRules.channel.${channel}`))
                      .join(', '),
                  })}
                </p>
                <p className="staff-row__contact">
                  {[
                    rule.pagerText === null
                      ? t('notificationRules.noPager')
                      : t('notificationRules.pager', { text: rule.pagerText }),
                    rule.escalate
                      ? t('notificationRules.escalates')
                      : t('notificationRules.noEscalation'),
                    repeatText(rule.repeat, repeat, t),
                  ].join(' · ')}
                </p>
                <p className="staff-row__states">
                  {changed ? (
                    <Badge tone="info">{t('notificationRules.changed')}</Badge>
                  ) : (
                    <Badge tone="neutral">{t('notificationRules.factory')}</Badge>
                  )}
                </p>
              </div>
              {editable ? (
                <div
                  className="staff-row__actions"
                  role="group"
                  aria-label={t('notificationRules.actionsFor', { name })}
                >
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditing(event);
                    }}
                  >
                    {t('notificationRules.edit')}
                  </Button>
                  {changed ? (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        void store(
                          overrides,
                          event,
                          undefined,
                          t('notificationRules.resetDone', { name }),
                        );
                      }}
                    >
                      {t('notificationRules.reset')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-rules">
      <div className="staff-header">
        <h2 id="dashboard-rules" className="dashboard-section__heading">
          {t('notificationRules.title')}
        </h2>
        <Link to="/manage/settings" className="staff-pages__link">
          {t('notificationRules.back')}
        </Link>
      </div>
      {data.status === 'ready' ? (
        <p className="dashboard-section__hint">
          {t('notificationRules.intro', {
            escalation: t('notificationRules.seconds', { value: data.value.escalation }),
            repeat: t('notificationRules.seconds', { value: data.value.repeat }),
          })}
        </p>
      ) : null}
      {content}
      {editing !== undefined && data.status === 'ready' ? (
        <RuleDialog
          event={editing}
          rule={effectiveRule(editing, data.value.overrides)}
          repeatSeconds={data.value.repeat}
          busy={busy}
          error={error}
          onSave={(rule) => {
            void store(
              data.value.overrides,
              editing,
              ruleOverride(editing, rule),
              t('notificationRules.saved', { name: t(`alerts.type.${editing}`) }),
            );
          }}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

function RuleDialog({
  event,
  rule,
  repeatSeconds,
  busy,
  error,
  onSave,
  onClose,
}: {
  event: NotificationEvent;
  rule: NotificationRule;
  repeatSeconds: number;
  busy: boolean;
  error: string | undefined;
  onSave: (rule: NotificationRule) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState<NotificationRule>(rule);
  const [submitted, setSubmitted] = useState(false);
  const problems = checkRule(draft);
  const problemText = (kinds: readonly string[]) => {
    const problem = problems.find((entry) => kinds.includes(entry));
    return submitted && problem !== undefined
      ? t(`notificationRules.problems.${problem}`)
      : undefined;
  };
  const toPager = draft.channels.includes('PAGER');
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      title={t('notificationRules.dialog.title', { name: t(`alerts.type.${event}`) })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('notificationRules.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('notificationRules.dialog.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          setSubmitted(true);
          if (problems.length > 0) return;
          onSave({
            ...draft,
            pagerText: toPager ? (draft.pagerText?.trim() ?? null) : null,
          });
        }}
      >
        <ChoiceGroup
          legend={t('notificationRules.dialog.recipients')}
          mode="multiple"
          options={recipientChoices(event).map((kind) => ({
            id: kind,
            label: t(`notificationRules.recipient.${kind}`),
          }))}
          value={[...draft.recipients]}
          error={problemText(['RECIPIENTS_REQUIRED'])}
          onChange={(recipients) => {
            setDraft((current) => ({
              ...current,
              recipients: recipients as NotificationRule['recipients'],
            }));
          }}
        />
        <ChoiceGroup
          legend={t('notificationRules.dialog.channels')}
          mode="multiple"
          options={channelChoices(event).map((channel) => ({
            id: channel,
            label: t(`notificationRules.channel.${channel}`),
          }))}
          value={[...draft.channels]}
          error={problemText(['CHANNELS_REQUIRED'])}
          onChange={(channels) => {
            setDraft((current) => ({
              ...current,
              channels: channels as NotificationRule['channels'],
            }));
          }}
        />
        {toPager ? (
          <TextField
            label={t('notificationRules.dialog.pagerText')}
            hint={t('notificationRules.dialog.pagerTextHint')}
            value={draft.pagerText ?? ''}
            maxLength={PAGER_TEXT_MAX}
            autoComplete="off"
            error={problemText(['PAGER_TEXT_REQUIRED', 'PAGER_TEXT_TOO_LONG'])}
            onChange={(changeEvent) => {
              setDraft((current) => ({ ...current, pagerText: changeEvent.target.value }));
            }}
          />
        ) : null}
        <label className="menu-toolbar__check">
          <input
            type="checkbox"
            checked={draft.escalate}
            onChange={(changeEvent) => {
              setDraft((current) => ({ ...current, escalate: changeEvent.target.checked }));
            }}
          />
          {t('notificationRules.dialog.escalate')}
        </label>
        <Select
          label={t('notificationRules.dialog.repeat')}
          value={draft.repeat}
          options={REPEAT_POLICIES.map((repeat) => ({
            value: repeat,
            label: repeatText(repeat, repeatSeconds, t),
          }))}
          onChange={(changeEvent) => {
            setDraft((current) => ({
              ...current,
              repeat: changeEvent.target.value as RepeatPolicy,
            }));
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
