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

export interface NotificationRule {
  readonly recipients: readonly RecipientKind[];
  readonly channels: readonly NotificationChannel[];
  /** What a pager shows; `{table}` and `{message}` are filled in. Null: no pager text. */
  readonly pagerText: string | null;
  /** Unacknowledged after N seconds, the managers on duty are alerted too (NTF-005). */
  readonly escalate: boolean;
  readonly repeat: RepeatPolicy;
}

const rule = (
  recipients: readonly RecipientKind[],
  channels: readonly NotificationChannel[],
  pagerText: string | null,
  escalate: boolean,
  repeat: RepeatPolicy,
): NotificationRule => ({ recipients, channels, pagerText, escalate, repeat });

/** BRD Appendix C, the factory defaults (N = R = 60 s are settings). */
export const DEFAULT_NOTIFICATION_RULES: Readonly<Record<NotificationEvent, NotificationRule>> = {
  ORDER_PENDING_APPROVAL: rule(
    ['RESPONSIBLE_WAITER'],
    ['PAGER', 'WAITER_APP', 'POS'],
    '{table} NEW ORDER',
    true,
    'UNTIL_ACKED',
  ),
  ITEM_READY: rule(
    ['RESPONSIBLE_WAITER'],
    ['PAGER', 'WAITER_APP', 'TABLET'],
    '{table} READY',
    true,
    'UNTIL_ACKED',
  ),
  WATER_REQUEST: rule(
    ['RESPONSIBLE_WAITER'],
    ['PAGER', 'WAITER_APP'],
    '{table} WATER',
    true,
    'UNTIL_ACKED',
  ),
  WAITER_REQUEST: rule(
    ['RESPONSIBLE_WAITER'],
    ['PAGER', 'WAITER_APP'],
    '{table} WAITER',
    true,
    'UNTIL_ACKED',
  ),
  BILL_REQUEST: rule(
    ['RESPONSIBLE_WAITER', 'CASHIER'],
    ['PAGER', 'WAITER_APP', 'POS'],
    '{table} BILL',
    true,
    'UNTIL_ACKED',
  ),
  READY_NOT_COLLECTED: rule(
    ['MANAGERS_ON_DUTY'],
    ['POS', 'DASHBOARD', 'PAGER'],
    '{table} FOOD WAITING',
    false,
    'UNTIL_ACKED',
  ),
  MANAGER_NUDGE: rule(
    ['SELECTED'],
    ['PAGER', 'WAITER_APP'],
    'MGR: {message}',
    false,
    'UNTIL_ACKED',
  ),
  ORDER_CHANGED: rule(['STATION'], ['KDS', 'PRINTED_SLIP'], null, false, 'NONE'),
  WAITER_UNREACHABLE: rule(['MANAGERS_ON_DUTY'], ['POS', 'DASHBOARD'], null, false, 'NONE'),
  DEVICE_LOW_BATTERY_OR_OFFLINE: rule(
    ['MANAGERS_ON_DUTY', 'WEARER'],
    ['DASHBOARD', 'WAITER_APP', 'PAGER'],
    'LOW BATTERY',
    false,
    'ONCE_PER_STATE',
  ),
  PRINTER_OFFLINE: rule(
    ['MANAGERS_ON_DUTY', 'CASHIER'],
    ['POS', 'DASHBOARD'],
    null,
    false,
    'UNTIL_RESOLVED',
  ),
  DISK_OR_BACKUP: rule(
    ['OWNER', 'MANAGERS_ON_DUTY'],
    ['POS', 'DASHBOARD', 'CONTROL_PLANE'],
    null,
    false,
    'DAILY',
  ),
  LICENSE_STATE: rule(['OWNER', 'MANAGERS_ON_DUTY'], ['POS', 'DASHBOARD'], null, false, 'DAILY'),
};

/** A manager's change to one event's rule (NTF-002); anything left out keeps the default. */
export type NotificationRuleOverride = Partial<NotificationRule>;

export function effectiveRule(
  event: NotificationEvent,
  overrides: Readonly<Partial<Record<NotificationEvent, NotificationRuleOverride>>> = {},
): NotificationRule {
  return { ...DEFAULT_NOTIFICATION_RULES[event], ...overrides[event] };
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
