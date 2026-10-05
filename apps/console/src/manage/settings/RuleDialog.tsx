import {
  type NotificationEvent,
  type NotificationRule,
  PAGER_TEXT_MAX,
  reachOf,
  recipientChoices,
  repeatChoices,
  VIBRATION_PATTERNS,
  type VibrationPattern,
  withRule,
} from '@rp/domain';
import { Button, ChoiceGroup, Dialog, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import {
  draftProblems,
  escalationAfter,
  factoryRule,
  fixedPlacesOf,
  normalized,
  overridesOf,
  pagerPreview,
  pagerTextHint,
  type RuleProblemText,
  type RuleTiming,
  repeatText,
  sameRule,
  withPlaces,
  withRecipients,
} from './notification-rules-view.js';
import { updateRequestOf } from './settings-view.js';

const isVibration = (value: string): value is VibrationPattern =>
  (VIBRATION_PATTERNS as readonly string[]).includes(value);

/**
 * Changes one alert's rule (P4-03b, NTF-002, PGR-006): who gets it, whether it shows on pagers and
 * the waiter app and on the POS and dashboard, what the pager shows and how it buzzes, whether it
 * goes on to the managers after N and how it repeats, with the factory rule one press away and an
 * optional reason for the audit log (AUD-001). The rule is checked as the server checks it. Saving
 * reads the rules again first, so a change another manager made to a different alert meanwhile
 * is kept.
 */
export function RuleDialog({
  event,
  rule,
  timing,
  onSaved,
  onClose,
}: {
  event: NotificationEvent;
  rule: NotificationRule;
  timing: RuleTiming;
  onSaved: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const name = t(`alerts.type.${event}`);
  const [draft, setDraft] = useState<NotificationRule>(rule);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const problems = draftProblems(t, event, draft);
  const problemOf = (field: RuleProblemText['field']): string | undefined => {
    if (!submitted) return undefined;
    const texts = problems.filter((problem) => problem.field === field).map((each) => each.text);
    return texts.length === 0 ? undefined : texts.join(' ');
  };
  const factory = factoryRule(event);
  const isFactory = sameRule(event, draft, factory);
  const reach = reachOf(draft);
  const choices = recipientChoices(event);
  const fixedPlaces = fixedPlacesOf(event);
  const preview = pagerPreview(t, draft);
  const otherProblem = problemOf('other');

  const save = async () => {
    setSubmitted(true);
    if (problems.length > 0) return;
    if (sameRule(event, draft, rule)) {
      onClose();
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const { settings } = await controller.api.listSettings();
      await controller.api.updateSetting({
        params: { key: 'notifications.rules' },
        body: updateRequestOf(withRule(overridesOf(settings), event, normalized(draft)), reason),
      });
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
      title={name}
      description={t(`notificationRules.events.${event}`)}
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
        <ChoiceGroup
          legend={t('notificationRules.dialog.who')}
          hint={choices.length === 1 ? t('notificationRules.dialog.onlyChosen') : undefined}
          mode="multiple"
          options={choices.map((kind) => ({
            id: kind,
            label: t(`notificationRules.recipients.${kind}`),
            disabled: choices.length === 1,
          }))}
          value={draft.recipients}
          error={problemOf('recipients')}
          onChange={(chosen) => {
            setDraft((current) => withRecipients(current, chosen));
          }}
        />
        <ChoiceGroup
          legend={t('notificationRules.dialog.where')}
          hint={
            fixedPlaces.length === 0
              ? undefined
              : t('notificationRules.dialog.alsoOn', {
                  places: new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(
                    fixedPlaces.map((place) => t(`notificationRules.places.${place}`)),
                  ),
                })
          }
          mode="multiple"
          options={[
            { id: 'PHONES', label: t('notificationRules.places.PHONES') },
            { id: 'SCREENS', label: t('notificationRules.places.SCREENS') },
          ]}
          value={[...(reach.phones ? ['PHONES'] : []), ...(reach.screens ? ['SCREENS'] : [])]}
          error={problemOf('places')}
          onChange={(chosen) => {
            setDraft((current) => withPlaces(event, current, chosen));
          }}
        />
        {reach.phones ? (
          <>
            <TextField
              label={t('notificationRules.dialog.pagerText')}
              hint={pagerTextHint(t, event)}
              autoComplete="off"
              maxLength={PAGER_TEXT_MAX}
              value={draft.pagerText ?? ''}
              error={problemOf('pagerText')}
              onChange={(change) => {
                const pagerText = change.target.value;
                setDraft((current) => ({ ...current, pagerText }));
              }}
            />
            {preview === null ? null : (
              <p className="settings-default__text" aria-live="polite">
                {t('notificationRules.dialog.preview', { text: preview })}
              </p>
            )}
            <Select
              label={t('notificationRules.dialog.vibration')}
              hint={t('notificationRules.dialog.vibrationHint')}
              value={draft.vibration}
              options={VIBRATION_PATTERNS.map((pattern) => ({
                value: pattern,
                label: t(`notificationRules.vibration.${pattern}`),
              }))}
              onChange={(change) => {
                const vibration = change.target.value;
                if (isVibration(vibration)) setDraft((current) => ({ ...current, vibration }));
              }}
            />
          </>
        ) : null}
        <label className="console-check">
          <input
            type="checkbox"
            checked={draft.escalate}
            onChange={(change) => {
              const escalate = change.target.checked;
              setDraft((current) => ({ ...current, escalate }));
            }}
          />
          {t('notificationRules.dialog.escalate', { after: escalationAfter(t, timing) })}
        </label>
        <Select
          label={t('notificationRules.dialog.repeat')}
          value={draft.repeat}
          options={repeatChoices(event).map((policy) => ({
            value: policy,
            label: repeatText(t, policy, timing),
          }))}
          onChange={(change) => {
            const chosen = repeatChoices(event).find((policy) => policy === change.target.value);
            if (chosen !== undefined) setDraft((current) => ({ ...current, repeat: chosen }));
          }}
        />
        <div className="settings-default">
          <p className="settings-default__text">
            {t(
              isFactory
                ? 'notificationRules.dialog.factory'
                : 'notificationRules.dialog.notFactory',
            )}
          </p>
          {isFactory ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(factory);
              }}
            >
              {t('notificationRules.dialog.useFactory')}
            </Button>
          )}
        </div>
        <TextField
          label={t('settings.dialog.reason')}
          hint={t('settings.dialog.reasonHint')}
          value={reason}
          maxLength={200}
          autoComplete="off"
          onChange={(change) => {
            setReason(change.target.value);
          }}
        />
        {otherProblem === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {otherProblem}
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
