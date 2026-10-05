/**
 * Notification rules (P2-03, NTF-001 to NTF-009, BRD Appendix C): which events alert whom, on which
 * channels, what a pager shows, whether an unacknowledged alert repeats and escalates to the
 * managers on duty. Pure: the server resolves the people and keeps the deadlines.
 */

export const NOTIFICATION_EVENTS = [
  'ORDER_PENDING_APPROVAL',
  'ITEM_READY',
  'WATER_REQUEST',
  'WAITER_REQUEST',
  'BILL_REQUEST',
  'READY_NOT_COLLECTED',
  'MANAGER_NUDGE',
  'ORDER_CHANGED',
  'WAITER_UNREACHABLE',
  'DEVICE_LOW_BATTERY_OR_OFFLINE',
  'PRINTER_OFFLINE',
  'DISK_OR_BACKUP',
  'LICENSE_STATE',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Who an alert goes to (NTF-002). */
export const RECIPIENT_KINDS = [
  'RESPONSIBLE_WAITER',
  'SECTION_WAITERS',
  'ALL_WAITERS',
  'MANAGERS_ON_DUTY',
  'CASHIER',
  'STATION',
  'OWNER',
  /** The person wearing a pager, for its own battery (Appendix C). */
  'WEARER',
  /** The waiters a manager chose for a nudge (NTF-008). */
  'SELECTED',
] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export const NOTIFICATION_CHANNELS = [
  'PAGER',
  'WAITER_APP',
  'POS',
  'DASHBOARD',
  'KDS',
  'TABLET',
  'PRINTED_SLIP',
  'CONTROL_PLANE',
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * How an alert comes back: every R seconds until acknowledged, never, once per state change, until
 * the cause is resolved, or once a day.
 */
export const REPEAT_POLICIES = [
  'UNTIL_ACKED',
  'NONE',
  'ONCE_PER_STATE',
  'UNTIL_RESOLVED',
  'DAILY',
] as const;
export type RepeatPolicy = (typeof REPEAT_POLICIES)[number];

/** PGR-006: how a pager buzzes for an alert ⚙. */
export const VIBRATION_PATTERNS = ['ONE_LONG', 'TWO_SHORT', 'THREE', 'ONE_SHORT'] as const;
export type VibrationPattern = (typeof VIBRATION_PATTERNS)[number];

export interface NotificationRule {
  readonly recipients: readonly RecipientKind[];
  readonly channels: readonly NotificationChannel[];
  /** What a pager shows; `{table}` and `{message}` are filled in. Null: no pager text. */
  readonly pagerText: string | null;
  /** How the pager buzzes (PGR-006); an escalated alert always buzzes three times. */
  readonly vibration: VibrationPattern;
  /** Unacknowledged after N seconds, the managers on duty are alerted too (NTF-005). */
  readonly escalate: boolean;
  readonly repeat: RepeatPolicy;
}

const rule = (
  recipients: readonly RecipientKind[],
  channels: readonly NotificationChannel[],
  pagerText: string | null,
  vibration: VibrationPattern,
  escalate: boolean,
  repeat: RepeatPolicy,
): NotificationRule => ({ recipients, channels, pagerText, vibration, escalate, repeat });

/**
 * BRD Appendix C, the factory defaults (N = R = 60 s are settings), with PGR-006's vibrations:
 * ready = one long, a request = two short, the manager = three.
 */
export const DEFAULT_NOTIFICATION_RULES: Readonly<Record<NotificationEvent, NotificationRule>> = {
  ORDER_PENDING_APPROVAL: rule(
    ['RESPONSIBLE_WAITER'],
    ['PAGER', 'WAITER_APP', 'POS'],
    '{table} NEW ORDER',
    'TWO_SHORT',
    true,
    'UNTIL_ACKED',
  ),
  ITEM_READY: rule(
    ['RESPONSIBLE_WAITER'],
    ['PAGER', 'WAITER_APP', 'TABLET'],
    '{table} READY',
    'ONE_LONG',
    true,
    'UNTIL_ACKED',
  ),
  WATER_REQUEST: rule(
    ['RESPONSIBLE_WAITER'],
    ['PAGER', 'WAITER_APP'],
    '{table} WATER',
    'TWO_SHORT',
    true,
    'UNTIL_ACKED',
  ),
  WAITER_REQUEST: rule(
    ['RESPONSIBLE_WAITER'],
    ['PAGER', 'WAITER_APP'],
    '{table} WAITER',
    'TWO_SHORT',
    true,
    'UNTIL_ACKED',
  ),
  BILL_REQUEST: rule(
    ['RESPONSIBLE_WAITER', 'CASHIER'],
    ['PAGER', 'WAITER_APP', 'POS'],
    '{table} BILL',
    'TWO_SHORT',
    true,
    'UNTIL_ACKED',
  ),
  READY_NOT_COLLECTED: rule(
    ['MANAGERS_ON_DUTY'],
    ['POS', 'DASHBOARD', 'PAGER'],
    '{table} FOOD WAITING',
    'THREE',
    false,
    'UNTIL_ACKED',
  ),
  MANAGER_NUDGE: rule(
    ['SELECTED'],
    ['PAGER', 'WAITER_APP'],
    'MGR: {message}',
    'THREE',
    false,
    'UNTIL_ACKED',
  ),
  ORDER_CHANGED: rule(['STATION'], ['KDS', 'PRINTED_SLIP'], null, 'ONE_SHORT', false, 'NONE'),
  WAITER_UNREACHABLE: rule(
    ['MANAGERS_ON_DUTY'],
    ['POS', 'DASHBOARD'],
    null,
    'THREE',
    false,
    'NONE',
  ),
  DEVICE_LOW_BATTERY_OR_OFFLINE: rule(
    ['MANAGERS_ON_DUTY', 'WEARER'],
    ['DASHBOARD', 'WAITER_APP', 'PAGER'],
    'LOW BATTERY',
    'ONE_SHORT',
    false,
    'ONCE_PER_STATE',
  ),
  PRINTER_OFFLINE: rule(
    ['MANAGERS_ON_DUTY', 'CASHIER'],
    ['POS', 'DASHBOARD'],
    null,
    'ONE_SHORT',
    false,
    'UNTIL_RESOLVED',
  ),
  DISK_OR_BACKUP: rule(
    ['OWNER', 'MANAGERS_ON_DUTY'],
    ['POS', 'DASHBOARD', 'CONTROL_PLANE'],
    null,
    'ONE_SHORT',
    false,
    'DAILY',
  ),
  LICENSE_STATE: rule(
    ['OWNER', 'MANAGERS_ON_DUTY'],
    ['POS', 'DASHBOARD'],
    null,
    'ONE_SHORT',
    false,
    'DAILY',
  ),
};

/** A manager's change to one event's rule (NTF-002); anything left out keeps the default. */
export type NotificationRuleOverride = Partial<NotificationRule>;

/** A restaurant's changes to the factory rules, by event (the setting `notifications.rules`). */
export type NotificationRuleOverrides = Readonly<
  Partial<Record<NotificationEvent, NotificationRuleOverride>>
>;

export function effectiveRule(
  event: NotificationEvent,
  overrides: NotificationRuleOverrides = {},
): NotificationRule {
  return { ...DEFAULT_NOTIFICATION_RULES[event], ...overrides[event] };
}

/**
 * Appendix C rows that say what always happens rather than an alert a manager shapes: the kitchen
 * gets order changes on its screen and a printed slip from the order engine (P1-06, P1-07), and a
 * waiter nobody can reach has their alerts go straight to the managers (NTF-007, NTF-009).
 */
export const FIXED_EVENTS: ReadonlySet<NotificationEvent> = new Set<NotificationEvent>([
  'ORDER_CHANGED',
  'WAITER_UNREACHABLE',
]);

/** Events about a table, whose pager text can name it with `{table}`. */
export const TABLE_ALERTS: ReadonlySet<NotificationEvent> = new Set<NotificationEvent>([
  'ORDER_PENDING_APPROVAL',
  'ITEM_READY',
  'WATER_REQUEST',
  'WAITER_REQUEST',
  'BILL_REQUEST',
  'READY_NOT_COLLECTED',
]);

const TABLE_RECIPIENTS: readonly RecipientKind[] = [
  'RESPONSIBLE_WAITER',
  'SECTION_WAITERS',
  'ALL_WAITERS',
  'MANAGERS_ON_DUTY',
  'CASHIER',
];

/**
 * Whom a manager may choose for an event (NTF-002): the people the event can reach. A table's
 * events go to its waiter, its section's waiters, every waiter, the managers or the cashier; a
 * nudge to the waiters the manager picks; a device's to the managers, the cashier, the Owner and,
 * for a pager, its wearer; the restaurant's own to the managers, the cashier and the Owner.
 */
export function recipientChoices(event: NotificationEvent): readonly RecipientKind[] {
  if (TABLE_ALERTS.has(event)) return TABLE_RECIPIENTS;
  switch (event) {
    case 'MANAGER_NUDGE':
      return ['SELECTED'];
    case 'ORDER_CHANGED':
      return ['STATION'];
    case 'DEVICE_LOW_BATTERY_OR_OFFLINE':
      return ['MANAGERS_ON_DUTY', 'WEARER', 'CASHIER', 'OWNER'];
    default:
      return ['MANAGERS_ON_DUTY', 'CASHIER', 'OWNER'];
  }
}

/** The pager and the waiter app show the same alerts (WTR-006). */
export const PHONE_CHANNELS: readonly NotificationChannel[] = ['PAGER', 'WAITER_APP'];
/** The POS and the dashboard are one console; either shows what asks for the person (MGR-008). */
export const SCREEN_CHANNELS: readonly NotificationChannel[] = ['POS', 'DASHBOARD'];

/**
 * What an event shows beyond people's devices, as its factory rule has it: the table's tablet for
 * food ready, the kitchen's screen and slip, the vendor for disk and backups. Kept as it is.
 */
export function fixedChannels(event: NotificationEvent): readonly NotificationChannel[] {
  return DEFAULT_NOTIFICATION_RULES[event].channels.filter(
    (channel) => !PHONE_CHANNELS.includes(channel) && !SCREEN_CHANNELS.includes(channel),
  );
}

/** Where a rule reaches people: on their pager and waiter app, on the POS and dashboard. */
export interface RuleReach {
  readonly phones: boolean;
  readonly screens: boolean;
}

export function reachOf(rule: Pick<NotificationRule, 'channels'>): RuleReach {
  return {
    phones: rule.channels.some((channel) => PHONE_CHANNELS.includes(channel)),
    screens: rule.channels.some((channel) => SCREEN_CHANNELS.includes(channel)),
  };
}

/** An event's channels for a reach, with its fixed channels kept. */
export function channelsFor(event: NotificationEvent, reach: RuleReach): NotificationChannel[] {
  return [
    ...(reach.phones ? PHONE_CHANNELS : []),
    ...(reach.screens ? SCREEN_CHANNELS : []),
    ...fixedChannels(event),
  ];
}

/** How an event's alert may come back: its factory way, every R until acknowledged, or never. */
export function repeatChoices(event: NotificationEvent): readonly RepeatPolicy[] {
  return [
    ...new Set<RepeatPolicy>([DEFAULT_NOTIFICATION_RULES[event].repeat, 'UNTIL_ACKED', 'NONE']),
  ];
}

/** What an event's pager text may fill in: the table, or the manager's message. */
export function pagerPlaceholders(event: NotificationEvent): readonly string[] {
  if (event === 'MANAGER_NUDGE') return ['{message}'];
  return TABLE_ALERTS.has(event) ? ['{table}'] : [];
}

export type RuleProblem =
  | 'FIXED_EVENT'
  | 'NO_RECIPIENT'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'NO_CHANNEL'
  | 'CHANNEL_NOT_ALLOWED'
  | 'PAGER_TEXT_MISSING'
  | 'PAGER_TEXT_TOO_LONG'
  | 'PAGER_TEXT_PLACEHOLDER'
  | 'PAGER_TEXT_NEEDS_MESSAGE'
  | 'REPEAT_NOT_ALLOWED';

/**
 * What stops a rule from working for its event (NTF-002): nobody or somebody the event cannot reach,
 * no pager, app or console to show it on, a pager with nothing to show or filling in what the event
 * does not have (a nudge must keep `{message}`), or a repeat the event does not offer.
 */
export function ruleProblems(event: NotificationEvent, rule: NotificationRule): RuleProblem[] {
  if (FIXED_EVENTS.has(event)) return ['FIXED_EVENT'];
  const problems: RuleProblem[] = [];
  const choices = recipientChoices(event);
  if (rule.recipients.length === 0) problems.push('NO_RECIPIENT');
  if (rule.recipients.some((kind) => !choices.includes(kind))) {
    problems.push('RECIPIENT_NOT_ALLOWED');
  }
  const reach = reachOf(rule);
  const fixed = fixedChannels(event);
  if (!reach.phones && !reach.screens) problems.push('NO_CHANNEL');
  if (
    rule.channels.some(
      (channel) =>
        !PHONE_CHANNELS.includes(channel) &&
        !SCREEN_CHANNELS.includes(channel) &&
        !fixed.includes(channel),
    ) ||
    fixed.some((channel) => !rule.channels.includes(channel))
  ) {
    problems.push('CHANNEL_NOT_ALLOWED');
  }
  if (reach.phones) {
    const text = rule.pagerText?.trim() ?? '';
    const placeholders = pagerPlaceholders(event);
    if (text === '') {
      problems.push('PAGER_TEXT_MISSING');
    } else {
      if (text.length > PAGER_TEXT_MAX) problems.push('PAGER_TEXT_TOO_LONG');
      const used = text.match(/\{[^}]*\}/g) ?? [];
      if (used.some((placeholder) => !placeholders.includes(placeholder))) {
        problems.push('PAGER_TEXT_PLACEHOLDER');
      }
      if (placeholders.includes('{message}') && !text.includes('{message}')) {
        problems.push('PAGER_TEXT_NEEDS_MESSAGE');
      }
    }
  }
  if (!repeatChoices(event).includes(rule.repeat)) problems.push('REPEAT_NOT_ALLOWED');
  return problems;
}

/** Every problem of a restaurant's changes, by event (the server refuses them, NTF-002). */
export function overrideProblems(
  overrides: NotificationRuleOverrides,
): { readonly event: NotificationEvent; readonly problem: RuleProblem }[] {
  return NOTIFICATION_EVENTS.filter((event) => overrides[event] !== undefined).flatMap((event) =>
    ruleProblems(event, effectiveRule(event, overrides)).map((problem) => ({ event, problem })),
  );
}

const sameMembers = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * The change from the factory rule that gives `rule`: only what differs, so what a manager left
 * alone keeps following the factory rule. Undefined when it is the factory rule. Recipients are in
 * the order of `recipientChoices`; channels are compared by reach.
 */
export function overrideFor(
  event: NotificationEvent,
  rule: NotificationRule,
): NotificationRuleOverride | undefined {
  const factory = DEFAULT_NOTIFICATION_RULES[event];
  const reach = reachOf(rule);
  const factoryReach = reachOf(factory);
  const change: NotificationRuleOverride = {
    ...(!sameMembers(rule.recipients, factory.recipients) && {
      recipients: recipientChoices(event).filter((kind) => rule.recipients.includes(kind)),
    }),
    ...((reach.phones !== factoryReach.phones || reach.screens !== factoryReach.screens) && {
      channels: channelsFor(event, reach),
    }),
    ...(rule.pagerText !== factory.pagerText && { pagerText: rule.pagerText }),
    ...(rule.vibration !== factory.vibration && { vibration: rule.vibration }),
    ...(rule.escalate !== factory.escalate && { escalate: rule.escalate }),
    ...(rule.repeat !== factory.repeat && { repeat: rule.repeat }),
  };
  return Object.keys(change).length === 0 ? undefined : change;
}

/** The restaurant's changes with one event's rule set to `rule` (or back to the factory rule). */
export function withRule(
  overrides: NotificationRuleOverrides,
  event: NotificationEvent,
  rule: NotificationRule,
): Partial<Record<NotificationEvent, NotificationRuleOverride>> {
  const { [event]: _previous, ...others } = overrides;
  const change = overrideFor(event, rule);
  return change === undefined ? others : { ...others, [event]: change };
}

/** A pager line: at most 20 characters on the wrist display (PGR), in capitals as Appendix C. */
export const PAGER_TEXT_MAX = 20;

/** "5" → "T5"; a label that already starts with letters ("Patio 2") stays as it is. */
function tableTag(label: string | null | undefined): string {
  if (label === undefined || label === null) return '';
  return /^\d/.test(label) ? `T${label}` : label;
}

export function pagerTextFor(
  template: string | null,
  values: { readonly table?: string | null; readonly message?: string | null },
): string | null {
  if (template === null) return null;
  const text = template
    .replace('{table}', tableTag(values.table))
    .replace('{message}', values.message ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const shown = template.includes('{message}') ? text : text.toUpperCase();
  return shown.slice(0, PAGER_TEXT_MAX);
}

/** What decides where an alert shows: the people it went to and its channels. */
export interface AlertDelivery {
  readonly recipientIds: readonly string[];
  readonly channels: readonly string[];
  readonly escalatedTo: readonly string[];
}

/**
 * Whether an alert goes to the person's pager and waiter app (P2-06a). Both show the same alerts
 * (WTR-006): those the person receives whose rule names the pager or the app, and any alert
 * escalated to them, which reaches a manager's pager and app whatever its channels (NTF-005).
 */
export function reachesPagerAndApp(alert: AlertDelivery, staffId: string): boolean {
  if (!alert.recipientIds.includes(staffId)) return false;
  return (
    alert.channels.includes('PAGER') ||
    alert.channels.includes('WAITER_APP') ||
    alert.escalatedTo.includes(staffId)
  );
}

/**
 * Whether an alert asks for the person at the console, on the POS or the manager dashboard
 * (P2-06c, MGR-008): they receive it and its rule names one of those, or it was escalated to them,
 * which reaches the managers' screens whatever its channels (NTF-005). Managers also see everyone
 * else's open alerts there, without being asked to act on them.
 */
export function reachesConsole(alert: AlertDelivery, staffId: string): boolean {
  if (!alert.recipientIds.includes(staffId)) return false;
  return (
    alert.channels.includes('POS') ||
    alert.channels.includes('DASHBOARD') ||
    alert.escalatedTo.includes(staffId)
  );
}

/** The restaurant's people as they are right now, for resolving a rule. */
export interface RecipientContext {
  readonly responsibleWaiterId: string | null;
  readonly sectionWaiterIds: readonly string[];
  readonly allWaiterIds: readonly string[];
  readonly managersOnDuty: readonly string[];
  readonly cashiersOnDuty: readonly string[];
  readonly ownerIds: readonly string[];
  readonly selectedIds: readonly string[];
  readonly wearerId: string | null;
  /** Waiters who set "On break" (NTF-009): their alerts go to the managers until they return. */
  readonly onBreak: ReadonlySet<string>;
  /** Whether a person's pager or waiter app is connected (NTF-007). */
  readonly reachable: (staffId: string) => boolean;
  /**
   * The person whose own request raised the alert, e.g. a waiter asking for the bill on their phone
   * (P2-06d): they know already, so they are not alerted, and as the responsible waiter they are
   * not missing either, so the managers are not called at once on their account.
   */
  readonly askedById?: string | null;
}

export interface ResolvedRecipients {
  readonly staffIds: readonly string[];
  /** The station(s) of the event are alerted (kitchen screens and slips). */
  readonly stations: boolean;
  /**
   * The managers are alerted now instead of after N seconds: the responsible waiter is missing, on
   * break, or has neither pager nor app connected (NTF-007, NTF-009).
   */
  readonly escalateNow: boolean;
}

const WAITER_KINDS: ReadonlySet<RecipientKind> = new Set([
  'RESPONSIBLE_WAITER',
  'SECTION_WAITERS',
  'ALL_WAITERS',
  'SELECTED',
]);

export function resolveRecipients(
  rule: NotificationRule,
  context: RecipientContext,
): ResolvedRecipients {
  const people = new Set<string>();
  let waiterWanted = false;
  let waiterFound = false;
  let stations = false;
  let escalateNow = false;
  const addWaiters = (ids: readonly string[]) => {
    for (const id of ids) {
      if (context.onBreak.has(id)) continue;
      people.add(id);
      waiterFound = true;
    }
  };
  for (const kind of rule.recipients) {
    if (WAITER_KINDS.has(kind)) waiterWanted = true;
    switch (kind) {
      case 'RESPONSIBLE_WAITER': {
        const waiter = context.responsibleWaiterId;
        if (waiter !== null && waiter === context.askedById) {
          waiterFound = true;
          break;
        }
        if (waiter === null || context.onBreak.has(waiter) || !context.reachable(waiter)) {
          escalateNow = true;
        }
        if (waiter !== null && !context.onBreak.has(waiter)) {
          people.add(waiter);
          waiterFound = true;
        }
        break;
      }
      case 'SECTION_WAITERS':
        addWaiters(context.sectionWaiterIds);
        break;
      case 'ALL_WAITERS':
        addWaiters(context.allWaiterIds);
        break;
      case 'SELECTED':
        addWaiters(context.selectedIds);
        break;
      case 'MANAGERS_ON_DUTY':
        for (const id of context.managersOnDuty) people.add(id);
        break;
      case 'CASHIER':
        for (const id of context.cashiersOnDuty) people.add(id);
        break;
      case 'OWNER':
        for (const id of context.ownerIds) people.add(id);
        break;
      case 'WEARER':
        if (context.wearerId !== null) people.add(context.wearerId);
        break;
      case 'STATION':
        stations = true;
        break;
    }
  }
  // Whoever asked knows already; an escalation still reaches every manager on duty.
  if (context.askedById !== undefined && context.askedById !== null) {
    people.delete(context.askedById);
  }
  // Nobody to take a waiter's alert: the managers take it at once.
  if (waiterWanted && !waiterFound) escalateNow = true;
  if (escalateNow) for (const id of context.managersOnDuty) people.add(id);
  return { staffIds: [...people], stations, escalateNow };
}

/** When an alert next needs attention (persisted, so timers survive a restart). */
export interface AlertDeadlines {
  readonly escalateAt: Date | null;
  readonly nextRepeatAt: Date | null;
}

export interface NotificationTiming {
  /** N (NTF-005), seconds. */
  readonly escalationSeconds: number;
  /** R (NTF-002), seconds. */
  readonly repeatSeconds: number;
}

const later = (from: Date, seconds: number) => new Date(from.getTime() + seconds * 1000);

export function initialDeadlines(
  rule: NotificationRule,
  now: Date,
  timing: NotificationTiming,
  escalatedAlready: boolean,
): AlertDeadlines {
  return {
    escalateAt: rule.escalate && !escalatedAlready ? later(now, timing.escalationSeconds) : null,
    nextRepeatAt:
      rule.repeat === 'UNTIL_ACKED' || rule.repeat === 'UNTIL_RESOLVED'
        ? later(now, timing.repeatSeconds)
        : rule.repeat === 'DAILY'
          ? later(now, 24 * 60 * 60)
          : null,
  };
}

export type DueAction =
  | { readonly kind: 'ESCALATE'; readonly next: AlertDeadlines }
  | { readonly kind: 'REPEAT'; readonly next: AlertDeadlines };

/**
 * What an open alert needs at `now`: escalation first (NTF-005), then a repeat (every R until
 * acknowledged). Several missed repeats (the server was down) come out as one repeat, not a burst.
 */
export function dueActions(
  rule: NotificationRule,
  deadlines: AlertDeadlines,
  now: Date,
  timing: NotificationTiming,
): DueAction[] {
  const actions: DueAction[] = [];
  let { escalateAt, nextRepeatAt } = deadlines;
  if (escalateAt !== null && escalateAt <= now) {
    escalateAt = null;
    actions.push({ kind: 'ESCALATE', next: { escalateAt, nextRepeatAt } });
  }
  if (nextRepeatAt !== null && nextRepeatAt <= now) {
    const step = rule.repeat === 'DAILY' ? 24 * 60 * 60 : timing.repeatSeconds;
    let next = nextRepeatAt;
    while (next <= now) next = later(next, step);
    nextRepeatAt = next;
    actions.push({ kind: 'REPEAT', next: { escalateAt, nextRepeatAt } });
  }
  return actions;
}
