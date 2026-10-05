import { type SettingKey, type SettingView, settingDefinition } from '@rp/contracts';
import {
  canonicalJson,
  channelsFor,
  DEFAULT_NOTIFICATION_RULES,
  effectiveRule,
  FIXED_EVENTS,
  fixedChannels,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationRule,
  type NotificationRuleOverrides,
  overrideFor,
  PAGER_TEXT_MAX,
  pagerPlaceholders,
  pagerTextFor,
  RECIPIENT_KINDS,
  reachOf,
  type RepeatPolicy,
  type RuleProblem,
  ruleProblems,
} from '@rp/domain';
import type { Translator } from '@rp/i18n';
import { formatNumber } from './settings-view.js';

/** The Notifications page's groups (P4-03b, NTF-003), each with its alerts in the order shown. */
export const RULE_GROUPS = [
  {
    group: 'orders',
    events: ['ORDER_PENDING_APPROVAL', 'ITEM_READY', 'READY_NOT_COLLECTED', 'ORDER_CHANGED'],
  },
  { group: 'tables', events: ['WATER_REQUEST', 'WAITER_REQUEST', 'BILL_REQUEST'] },
  { group: 'staff', events: ['MANAGER_NUDGE', 'WAITER_UNREACHABLE'] },
  {
    group: 'system',
    events: ['DEVICE_LOW_BATTERY_OR_OFFLINE', 'PRINTER_OFFLINE', 'DISK_OR_BACKUP', 'LICENSE_STATE'],
  },
] as const satisfies readonly {
  readonly group: string;
  readonly events: readonly NotificationEvent[];
}[];
export type RuleGroup = (typeof RULE_GROUPS)[number]['group'];

/** N, R and the nudge messages: the settings shown above the rules, edited as on the General page. */
export const TIMING_SETTINGS = [
  'notifications.escalationSeconds',
  'notifications.repeatSeconds',
  'notifications.nudgePresets',
] as const satisfies readonly SettingKey[];

const RULES_KEY = 'notifications.rules' satisfies SettingKey;

/** The setting the rules are kept in, as the server listed it. */
export function rulesSettingOf(settings: readonly SettingView[]): SettingView | undefined {
  return settings.find((setting) => setting.key === RULES_KEY);
}

/**
 * The restaurant's changes to the factory rules, as the server listed them. The server lists only
 * values it accepts; anything else reads as no changes rather than breaking the page.
 */
export function overridesOf(settings: readonly SettingView[]): NotificationRuleOverrides {
  const schema = settingDefinition(RULES_KEY)?.schema;
  const parsed = schema?.safeParse(rulesSettingOf(settings)?.value);
  return parsed?.success === true ? (parsed.data as NotificationRuleOverrides) : {};
}

/** N and R (NTF-002, NTF-005), in seconds, as the rules use them. */
export interface RuleTiming {
  readonly escalationSeconds: number;
  readonly repeatSeconds: number;
}

export function timingOf(settings: readonly SettingView[]): RuleTiming {
  const seconds = (key: SettingKey): number => {
    const value = settings.find((setting) => setting.key === key)?.value;
    return typeof value === 'number' ? value : (settingDefinition(key)?.defaultValue as number);
  };
  return {
    escalationSeconds: seconds('notifications.escalationSeconds'),
    repeatSeconds: seconds('notifications.repeatSeconds'),
  };
}

/** Whether the restaurant changed an alert's rule from the factory rule. */
export function isChanged(overrides: NotificationRuleOverrides, event: NotificationEvent): boolean {
  return overrideFor(event, effectiveRule(event, overrides)) !== undefined;
}

/** Whether two rules do the same thing for an event (channels compared by where they reach). */
export function sameRule(
  event: NotificationEvent,
  a: NotificationRule,
  b: NotificationRule,
): boolean {
  return (
    canonicalJson(overrideFor(event, normalized(a)) ?? {}) ===
    canonicalJson(overrideFor(event, normalized(b)) ?? {})
  );
}

/** The rule as it is saved: the pager text trimmed, and none when it is empty. */
export function normalized(rule: NotificationRule): NotificationRule {
  const text = rule.pagerText?.trim() ?? '';
  return { ...rule, pagerText: text === '' ? null : text };
}

/** Where a rule shows an alert, for its badges: people's devices first, then its fixed places. */
export type RulePlace = 'PHONES' | 'SCREENS' | 'TABLET' | 'KDS' | 'PRINTED_SLIP' | 'CONTROL_PLANE';

const FIXED_PLACE: Readonly<Partial<Record<NotificationChannel, RulePlace>>> = {
  TABLET: 'TABLET',
  KDS: 'KDS',
  PRINTED_SLIP: 'PRINTED_SLIP',
  CONTROL_PLANE: 'CONTROL_PLANE',
};

/** The places an event always shows beyond people's devices (the table's tablet, the kitchen). */
export function fixedPlacesOf(event: NotificationEvent): RulePlace[] {
  return fixedChannels(event).flatMap((channel) => {
    const place = FIXED_PLACE[channel];
    return place === undefined ? [] : [place];
  });
}

export function placesOf(event: NotificationEvent, rule: NotificationRule): RulePlace[] {
  const reach = reachOf(rule);
  return [
    ...(reach.phones ? (['PHONES'] as const) : []),
    ...(reach.screens ? (['SCREENS'] as const) : []),
    ...fixedPlacesOf(event),
  ];
}

/** The people a rule alerts, in a sentence ("the table’s waiter and the cashier"). */
export function peopleOf(t: Translator, rule: Pick<NotificationRule, 'recipients'>): string {
  const kinds = RECIPIENT_KINDS.filter((kind) => rule.recipients.includes(kind));
  return new Intl.ListFormat(t.locale, { style: 'long', type: 'conjunction' }).format(
    kinds.map((kind) => t(`notificationRules.people.${kind}`)),
  );
}

/** The table and message a pager preview fills in. */
const EXAMPLE_TABLE = '7';

/** What a pager shows for the rule, with an example table and message; null when none. */
export function pagerPreview(
  t: Translator,
  rule: Pick<NotificationRule, 'pagerText'>,
): string | null {
  const text = rule.pagerText?.trim() ?? '';
  if (text === '') return null;
  return pagerTextFor(text, {
    table: EXAMPLE_TABLE,
    message: t('notificationRules.dialog.exampleMessage'),
  });
}

/** The hint under the pager text: its length and what it fills in. */
export function pagerTextHint(t: Translator, event: NotificationEvent): string {
  const [placeholder] = pagerPlaceholders(event);
  if (placeholder === '{message}') {
    return t('notificationRules.dialog.pagerTextMessage', { max: PAGER_TEXT_MAX, placeholder });
  }
  if (placeholder === '{table}') {
    return t('notificationRules.dialog.pagerTextTable', {
      max: PAGER_TEXT_MAX,
      placeholder,
      example: pagerTextFor('{table}', { table: EXAMPLE_TABLE }) ?? '',
    });
  }
  return t('notificationRules.dialog.pagerTextHint', { max: PAGER_TEXT_MAX });
}

/** How an unacknowledged alert comes back, in words. */
export function repeatText(t: Translator, repeat: RepeatPolicy, timing: RuleTiming): string {
  return t(`notificationRules.repeat.${repeat}`, {
    every: formatNumber(t, 'seconds', timing.repeatSeconds),
  });
}

/** N in words, for "after N without an acknowledgement". */
export function escalationAfter(t: Translator, timing: RuleTiming): string {
  return formatNumber(t, 'seconds', timing.escalationSeconds);
}

/** A problem with the rule being edited, and the field it belongs to. */
export interface RuleProblemText {
  readonly field: 'recipients' | 'places' | 'pagerText' | 'other';
  readonly text: string;
}

export function problemTexts(
  t: Translator,
  event: NotificationEvent,
  problems: readonly RuleProblem[],
): RuleProblemText[] {
  const placeholders = pagerPlaceholders(event);
  return problems.map((problem): RuleProblemText => {
    switch (problem) {
      case 'NO_RECIPIENT':
      case 'RECIPIENT_NOT_ALLOWED':
        return { field: 'recipients', text: t(`notificationRules.dialog.problems.${problem}`) };
      case 'NO_CHANNEL':
      case 'CHANNEL_NOT_ALLOWED':
        return { field: 'places', text: t(`notificationRules.dialog.problems.${problem}`) };
      case 'PAGER_TEXT_MISSING':
        return {
          field: 'pagerText',
          text: t('notificationRules.dialog.problems.PAGER_TEXT_MISSING'),
        };
      case 'PAGER_TEXT_TOO_LONG':
        return {
          field: 'pagerText',
          text: t('notificationRules.dialog.problems.PAGER_TEXT_TOO_LONG', { max: PAGER_TEXT_MAX }),
        };
      case 'PAGER_TEXT_PLACEHOLDER':
        return {
          field: 'pagerText',
          text:
            placeholders.length === 0
              ? t('notificationRules.dialog.problems.PAGER_TEXT_NO_PLACEHOLDER')
              : t('notificationRules.dialog.problems.PAGER_TEXT_PLACEHOLDER', {
                  allowed: new Intl.ListFormat(t.locale, { type: 'disjunction' }).format(
                    placeholders,
                  ),
                }),
        };
      case 'PAGER_TEXT_NEEDS_MESSAGE':
        return {
          field: 'pagerText',
          text: t('notificationRules.dialog.problems.PAGER_TEXT_NEEDS_MESSAGE', {
            placeholder: '{message}',
          }),
        };
      case 'REPEAT_NOT_ALLOWED':
      case 'FIXED_EVENT':
        return { field: 'other', text: t(`notificationRules.dialog.problems.${problem}`) };
    }
  });
}

/** What stops the rule being edited from working, in words. */
export function draftProblems(
  t: Translator,
  event: NotificationEvent,
  draft: NotificationRule,
): RuleProblemText[] {
  return problemTexts(t, event, ruleProblems(event, draft));
}

/** The rule going to the people chosen, in the order they are offered. */
export function withRecipients(
  rule: NotificationRule,
  chosen: readonly string[],
): NotificationRule {
  return { ...rule, recipients: RECIPIENT_KINDS.filter((kind) => chosen.includes(kind)) };
}

/** The rule shown where chosen: on pagers and the waiter app, on the POS and dashboard. */
export function withPlaces(
  event: NotificationEvent,
  rule: NotificationRule,
  chosen: readonly string[],
): NotificationRule {
  return {
    ...rule,
    channels: channelsFor(event, {
      phones: chosen.includes('PHONES'),
      screens: chosen.includes('SCREENS'),
    }),
  };
}

/** Whether an Appendix C row always happens and has no rule to change. */
export function isFixed(event: NotificationEvent): boolean {
  return FIXED_EVENTS.has(event);
}

/** The factory rule of an alert (BRD Appendix C). */
export function factoryRule(event: NotificationEvent): NotificationRule {
  return DEFAULT_NOTIFICATION_RULES[event];
}
