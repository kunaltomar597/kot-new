import type { SettingKey } from '@rp/contracts';
import { effectiveRule, type NotificationEvent, type NotificationRule, reachOf } from '@rp/domain';
import type { Translator } from '@rp/i18n';
import { Badge, Button, ErrorState, LoadingState, useToast } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { useSecondFactor } from '../../owner/second-factor.js';
import {
  escalationAfter,
  isChanged,
  isFixed,
  overridesOf,
  pagerPreview,
  peopleOf,
  placesOf,
  RULE_GROUPS,
  type RuleTiming,
  repeatText,
  rulesSettingOf,
  TIMING_SETTINGS,
  timingOf,
} from './notification-rules-view.js';
import { RuleDialog } from './RuleDialog.js';
import { SettingDialog } from './SettingDialog.js';
import { SettingRow } from './SettingRow.js';
import { accessOf, type PrinterNames, settingLabel } from './settings-view.js';

/** No setting on this page names a printer. */
const NO_PRINTERS: PrinterNames = new Map();

type Editing =
  | { readonly kind: 'setting'; readonly key: SettingKey }
  | { readonly kind: 'rule'; readonly event: NotificationEvent };

/**
 * The Notifications page (P4-03b, NTF-002, NTF-003, PGR-006): N, R and the nudge messages, then a
 * rule for each alert of Appendix C, grouped as the alert centre groups them, saying whom it
 * alerts, where it shows, what the pager shows and how it buzzes, and what happens when nobody
 * acknowledges it. A changed rule is marked; the kitchen's order changes and the unreachable
 * waiter's alerts always happen and are shown without a Change button. The rules are kept in the
 * setting `notifications.rules` and the page follows `SettingsChanged`.
 */
export function NotificationsScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const { data, reload } = useLive(
    async () => (await controller.api.listSettings()).settings,
    (type) => type === 'SettingsChanged',
  );
  const [editing, setEditing] = useState<Editing | undefined>();

  let content: ReactNode;
  let dialog: ReactNode = null;
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
    const settings = data.value;
    const overrides = overridesOf(settings);
    const timing = timingOf(settings);
    const rulesSetting = rulesSettingOf(settings);
    const mayChangeRules = rulesSetting !== undefined && accessOf(rulesSetting) === 'EDIT';
    const timingSettings = TIMING_SETTINGS.flatMap((key) => {
      const view = settings.find((setting) => setting.key === key);
      return view === undefined ? [] : [{ ...view, key }];
    });
    content = (
      <>
        <section className="settings-group" aria-labelledby="notifications-timing">
          <h3 id="notifications-timing" className="settings-group__heading">
            {t('notificationRules.timing')}
          </h3>
          <ul className="staff-list">
            {timingSettings.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                printerNames={NO_PRINTERS}
                onChange={() => {
                  setEditing({ kind: 'setting', key: setting.key });
                }}
              />
            ))}
          </ul>
        </section>
        {RULE_GROUPS.map(({ group, events }) => (
          <section
            key={group}
            className="settings-group"
            aria-labelledby={`notifications-group-${group}`}
          >
            <h3 id={`notifications-group-${group}`} className="settings-group__heading">
              {t(`notificationRules.groups.${group}`)}
            </h3>
            <ul className="staff-list">
              {events.map((event) => (
                <RuleRow
                  key={event}
                  event={event}
                  rule={effectiveRule(event, overrides)}
                  changed={isChanged(overrides, event)}
                  timing={timing}
                  editable={mayChangeRules}
                  onChange={() => {
                    setEditing({ kind: 'rule', event });
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </>
    );
    if (editing?.kind === 'setting') {
      const open = timingSettings.find((setting) => setting.key === editing.key);
      if (open !== undefined) {
        dialog = (
          <SettingDialog
            key={open.key}
            setting={open}
            printers={[]}
            printerNames={NO_PRINTERS}
            withSecondFactor={withSecondFactor}
            onSaved={() => {
              toast.show({
                title: t('settings.dialog.saved', { name: settingLabel(t, open.key) }),
                tone: 'success',
              });
              setEditing(undefined);
              reload();
            }}
            onClose={() => {
              setEditing(undefined);
            }}
          />
        );
      }
    } else if (editing?.kind === 'rule') {
      const { event } = editing;
      dialog = (
        <RuleDialog
          key={event}
          event={event}
          rule={effectiveRule(event, overrides)}
          timing={timing}
          onSaved={() => {
            toast.show({
              title: t('notificationRules.dialog.saved', { name: t(`alerts.type.${event}`) }),
              tone: 'success',
            });
            setEditing(undefined);
            reload();
          }}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      );
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-notifications">
      <h2 id="dashboard-notifications" className="dashboard-section__heading">
        {t('notificationRules.title')}
      </h2>
      <p className="dashboard-section__hint">{t('notificationRules.intro')}</p>
      {content}
      {dialog}
      {secondFactorDialog}
    </section>
  );
}

/** What always happens for an Appendix C row that has no rule to change. */
function fixedNote(t: Translator, event: NotificationEvent): string | undefined {
  switch (event) {
    case 'ORDER_CHANGED':
    case 'WAITER_UNREACHABLE':
      return t(`notificationRules.fixed.${event}`);
    default:
      return undefined;
  }
}

/** One alert's rule: whom it alerts, where, the pager's text and buzz, repeats and escalation. */
function RuleRow({
  event,
  rule,
  changed,
  timing,
  editable,
  onChange,
}: {
  event: NotificationEvent;
  rule: NotificationRule;
  changed: boolean;
  timing: RuleTiming;
  editable: boolean;
  onChange: () => void;
}) {
  const t = useT();
  const name = t(`alerts.type.${event}`);
  const fixed = isFixed(event) ? fixedNote(t, event) : undefined;
  const preview = reachOf(rule).phones ? pagerPreview(t, rule) : null;
  return (
    <li className="staff-row">
      <div className="staff-row__who">
        <h4 className="staff-row__name">{name}</h4>
        <p className="settings-row__value">
          {t('notificationRules.row.to', { people: peopleOf(t, rule) })}
        </p>
        <p className="staff-row__contact">{t(`notificationRules.events.${event}`)}</p>
        <p className="staff-row__states">
          {placesOf(event, rule).map((place) => (
            <Badge key={place} tone="neutral">
              {t(`notificationRules.places.${place}`)}
            </Badge>
          ))}
          {changed ? <Badge tone="info">{t('notificationRules.row.changed')}</Badge> : null}
          {fixed === undefined ? null : (
            <Badge tone="neutral">{t('notificationRules.row.fixed')}</Badge>
          )}
        </p>
        {fixed === undefined ? (
          <>
            {preview === null ? null : (
              <p className="staff-row__contact">
                {t('notificationRules.row.pager', {
                  text: preview,
                  vibration: t(`notificationRules.vibration.${rule.vibration}`),
                })}
              </p>
            )}
            <p className="staff-row__contact">{repeatText(t, rule.repeat, timing)}</p>
            {rule.escalate ? (
              <p className="staff-row__contact">
                {t('notificationRules.row.escalates', { after: escalationAfter(t, timing) })}
              </p>
            ) : null}
          </>
        ) : (
          <p className="staff-row__contact">{fixed}</p>
        )}
      </div>
      {editable && fixed === undefined ? (
        <div className="staff-row__actions">
          <Button
            variant="secondary"
            aria-label={t('notificationRules.row.changeLabel', { name })}
            onClick={onChange}
          >
            {t('settings.row.change')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
