import { describe, expect, it } from 'vitest';
import {
  channelsFor,
  DEFAULT_NOTIFICATION_RULES,
  dueActions,
  effectiveRule,
  FIXED_EVENTS,
  fixedChannels,
  initialDeadlines,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationRuleOverride,
  overrideFor,
  overrideProblems,
  pagerPlaceholders,
  pagerTextFor,
  reachesConsole,
  reachesPagerAndApp,
  reachOf,
  type RecipientContext,
  recipientChoices,
  repeatChoices,
  resolveRecipients,
  ruleProblems,
  withRule,
} from '../src/index.js';

const context = (overrides: Partial<RecipientContext> = {}): RecipientContext => ({
  responsibleWaiterId: 'ravi',
  sectionWaiterIds: ['ravi', 'sunita'],
  allWaiterIds: ['ravi', 'sunita', 'arjun'],
  managersOnDuty: ['vikram'],
  cashiersOnDuty: ['neha'],
  ownerIds: ['asha'],
  selectedIds: ['sunita'],
  wearerId: 'arjun',
  onBreak: new Set(),
  reachable: () => true,
  ...overrides,
});

const TIMING = { escalationSeconds: 60, repeatSeconds: 60 };
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 26, 12, 0, seconds));

describe('[NTF-002] [NTF-003] the Appendix C matrix', () => {
  // Event, recipients with everyone reachable, pager text for table 7, escalates, repeat.
  const MATRIX: readonly [NotificationEvent, string[], string | null, boolean, string][] = [
    ['ORDER_PENDING_APPROVAL', ['ravi'], 'T7 NEW ORDER', true, 'UNTIL_ACKED'],
    ['ITEM_READY', ['ravi'], 'T7 READY', true, 'UNTIL_ACKED'],
    ['WATER_REQUEST', ['ravi'], 'T7 WATER', true, 'UNTIL_ACKED'],
    ['WAITER_REQUEST', ['ravi'], 'T7 WAITER', true, 'UNTIL_ACKED'],
    ['BILL_REQUEST', ['ravi', 'neha'], 'T7 BILL', true, 'UNTIL_ACKED'],
    ['READY_NOT_COLLECTED', ['vikram'], 'T7 FOOD WAITING', false, 'UNTIL_ACKED'],
    ['MANAGER_NUDGE', ['sunita'], 'MGR: Check T7', false, 'UNTIL_ACKED'],
    ['ORDER_CHANGED', [], null, false, 'NONE'],
    ['WAITER_UNREACHABLE', ['vikram'], null, false, 'NONE'],
    ['DEVICE_LOW_BATTERY_OR_OFFLINE', ['vikram', 'arjun'], 'LOW BATTERY', false, 'ONCE_PER_STATE'],
    ['PRINTER_OFFLINE', ['vikram', 'neha'], null, false, 'UNTIL_RESOLVED'],
    ['DISK_OR_BACKUP', ['asha', 'vikram'], null, false, 'DAILY'],
    ['LICENSE_STATE', ['asha', 'vikram'], null, false, 'DAILY'],
  ];

  it('covers every event type', () => {
    expect(MATRIX.map(([event]) => event).sort()).toEqual([...NOTIFICATION_EVENTS].sort());
  });

  it.each(MATRIX)('%s', (event, people, pager, escalate, repeat) => {
    const rule = DEFAULT_NOTIFICATION_RULES[event];
    const resolved = resolveRecipients(rule, context());
    expect(resolved.staffIds).toEqual(people);
    expect(resolved.escalateNow).toBe(false);
    expect(resolved.stations).toBe(event === 'ORDER_CHANGED');
    expect(pagerTextFor(rule.pagerText, { table: '7', message: 'Check T7' })).toBe(pager);
    expect(rule.escalate).toBe(escalate);
    expect(rule.repeat).toBe(repeat);
  });
});

describe('[NTF-005] [NTF-007] [NTF-009] recipients', () => {
  const ready = DEFAULT_NOTIFICATION_RULES.ITEM_READY;

  it('goes to the managers at once when the waiter has neither pager nor app connected', () => {
    const resolved = resolveRecipients(ready, context({ reachable: (id) => id !== 'ravi' }));
    expect(resolved).toEqual({ staffIds: ['ravi', 'vikram'], stations: false, escalateNow: true });
  });

  it('goes to the managers while the waiter is on break, and when nobody looks after the table', () => {
    expect(resolveRecipients(ready, context({ onBreak: new Set(['ravi']) }))).toEqual({
      staffIds: ['vikram'],
      stations: false,
      escalateNow: true,
    });
    expect(resolveRecipients(ready, context({ responsibleWaiterId: null })).staffIds).toEqual([
      'vikram',
    ]);
    const section = effectiveRule('WATER_REQUEST', {
      WATER_REQUEST: { recipients: ['SECTION_WAITERS'] },
    });
    expect(
      resolveRecipients(section, context({ onBreak: new Set(['ravi', 'sunita']) })),
    ).toMatchObject({ staffIds: ['vikram'], escalateNow: true });
    expect(resolveRecipients(section, context({ onBreak: new Set(['ravi']) })).staffIds).toEqual([
      'sunita',
    ]);
  });

  it('[BILL-015] does not alert the waiter who asked for the bill; the cashier still hears', () => {
    const bill = DEFAULT_NOTIFICATION_RULES.BILL_REQUEST;
    // Ravi asked on his phone: not alerted, and not "missing", even with his pager off.
    expect(
      resolveRecipients(bill, context({ askedById: 'ravi', reachable: (id) => id !== 'ravi' })),
    ).toEqual({ staffIds: ['neha'], stations: false, escalateNow: false });
    // Neha asked at the POS: Ravi is told, Neha is not.
    expect(resolveRecipients(bill, context({ askedById: 'neha' })).staffIds).toEqual(['ravi']);
    // Someone else's request changes nothing.
    expect(resolveRecipients(bill, context({ askedById: null })).staffIds).toEqual([
      'ravi',
      'neha',
    ]);
    // A manager who asked while nobody looks after the table is still called with the others.
    expect(
      resolveRecipients(bill, context({ askedById: 'vikram', responsibleWaiterId: null })),
    ).toEqual({ staffIds: ['neha', 'vikram'], stations: false, escalateNow: true });
  });

  it('lets a manager send an event to all waiters or a cashier instead (NTF-002)', () => {
    const rule = effectiveRule('WATER_REQUEST', {
      WATER_REQUEST: { recipients: ['ALL_WAITERS', 'CASHIER'], escalate: false },
    });
    expect(rule.channels).toEqual(['PAGER', 'WAITER_APP']);
    expect(resolveRecipients(rule, context()).staffIds).toEqual([
      'ravi',
      'sunita',
      'arjun',
      'neha',
    ]);
    expect(effectiveRule('ITEM_READY')).toEqual(DEFAULT_NOTIFICATION_RULES.ITEM_READY);
  });
});

describe('[NTF-004] [NTF-005] repeat and escalation deadlines', () => {
  const rule = DEFAULT_NOTIFICATION_RULES.BILL_REQUEST;

  it('escalates after N and repeats every R until acknowledged', () => {
    const start = initialDeadlines(rule, at(0), TIMING, false);
    expect(start).toEqual({ escalateAt: at(60), nextRepeatAt: at(60) });
    expect(dueActions(rule, start, at(59), TIMING)).toEqual([]);
    const due = dueActions(rule, start, at(60), TIMING);
    expect(due.map((action) => action.kind)).toEqual(['ESCALATE', 'REPEAT']);
    expect(due.at(-1)?.next).toEqual({ escalateAt: null, nextRepeatAt: at(120) });
  });

  it('does not escalate twice, and folds missed repeats into one after a restart', () => {
    const escalated = initialDeadlines(rule, at(0), TIMING, true);
    expect(escalated.escalateAt).toBeNull();
    const due = dueActions(rule, { escalateAt: null, nextRepeatAt: at(60) }, at(250), TIMING);
    expect(due).toEqual([{ kind: 'REPEAT', next: { escalateAt: null, nextRepeatAt: at(300) } }]);
  });

  it('never repeats NONE or ONCE_PER_STATE alerts, and repeats DAILY ones a day later', () => {
    expect(
      initialDeadlines(DEFAULT_NOTIFICATION_RULES.ORDER_CHANGED, at(0), TIMING, false),
    ).toEqual({
      escalateAt: null,
      nextRepeatAt: null,
    });
    const daily = initialDeadlines(DEFAULT_NOTIFICATION_RULES.DISK_OR_BACKUP, at(0), TIMING, false);
    expect(daily.nextRepeatAt?.getTime()).toBe(at(0).getTime() + 86_400_000);
  });
});

describe('[NTF-008] pager text', () => {
  it('fits the pager and keeps a label that is not a number', () => {
    expect(pagerTextFor('{table} READY', { table: 'Patio 2' })).toBe('PATIO 2 READY');
    expect(pagerTextFor('MGR: {message}', { message: 'Come to the counter please now' })).toBe(
      'MGR: Come to the cou',
    );
    expect(pagerTextFor('{table} BILL', { table: null })).toBe('BILL');
    expect(pagerTextFor(null, {})).toBeNull();
  });
});

describe('[WTR-006] [NTF-005] what reaches the pager and the waiter app', () => {
  const alert = (channels: readonly string[], escalatedTo: readonly string[] = []) => ({
    recipientIds: ['ravi', 'vikram'],
    channels,
    escalatedTo,
  });

  it('shows a recipient every alert whose rule names the pager or the app', () => {
    expect(reachesPagerAndApp(alert(['PAGER', 'WAITER_APP', 'POS']), 'ravi')).toBe(true);
    expect(reachesPagerAndApp(alert(['PAGER']), 'ravi')).toBe(true);
    expect(reachesPagerAndApp(alert(['WAITER_APP']), 'ravi')).toBe(true);
    expect(reachesPagerAndApp(alert(['PAGER']), 'sunita')).toBe(false);
  });

  it('keeps POS and dashboard alerts off pagers and phones, unless escalated to the person', () => {
    expect(reachesPagerAndApp(alert(['POS', 'DASHBOARD']), 'vikram')).toBe(false);
    expect(reachesPagerAndApp(alert(['POS', 'DASHBOARD'], ['vikram']), 'vikram')).toBe(true);
    expect(reachesPagerAndApp(alert(['POS', 'DASHBOARD'], ['vikram']), 'ravi')).toBe(false);
  });
});

describe('[MGR-008] [NTF-005] what asks for a person at the POS and the dashboard', () => {
  const alert = (channels: readonly string[], escalatedTo: readonly string[] = []) => ({
    recipientIds: ['neha', 'vikram'],
    channels,
    escalatedTo,
  });

  it('asks a recipient when the rule names the POS or the dashboard', () => {
    expect(reachesConsole(alert(['PAGER', 'WAITER_APP', 'POS']), 'neha')).toBe(true);
    expect(reachesConsole(alert(['DASHBOARD']), 'vikram')).toBe(true);
    expect(reachesConsole(alert(['POS']), 'sunita')).toBe(false);
  });

  it('keeps pager and phone alerts off the console, unless escalated to the person', () => {
    expect(reachesConsole(alert(['PAGER', 'WAITER_APP']), 'vikram')).toBe(false);
    expect(reachesConsole(alert(['PAGER', 'WAITER_APP'], ['vikram']), 'vikram')).toBe(true);
    expect(reachesConsole(alert(['PAGER', 'WAITER_APP'], ['vikram']), 'neha')).toBe(false);
  });
});

describe('[NTF-002] [PGR-006] what a manager may change in a rule', () => {
  const configurable = NOTIFICATION_EVENTS.filter((event) => !FIXED_EVENTS.has(event));
  const problems = (event: NotificationEvent, change: NotificationRuleOverride) =>
    ruleProblems(event, { ...DEFAULT_NOTIFICATION_RULES[event], ...change });

  it('accepts every factory rule; order changes and unreachable waiters are not alerts to shape', () => {
    expect(configurable).toHaveLength(11);
    for (const event of configurable) {
      const rule = DEFAULT_NOTIFICATION_RULES[event];
      expect(ruleProblems(event, rule), event).toEqual([]);
      expect(overrideFor(event, rule), event).toBeUndefined();
    }
    expect([...FIXED_EVENTS].sort()).toEqual(['ORDER_CHANGED', 'WAITER_UNREACHABLE']);
    expect(ruleProblems('ORDER_CHANGED', DEFAULT_NOTIFICATION_RULES.ORDER_CHANGED)).toEqual([
      'FIXED_EVENT',
    ]);
  });

  it('offers each event the people it can reach and the repeats that suit it', () => {
    expect(recipientChoices('WATER_REQUEST')).toEqual([
      'RESPONSIBLE_WAITER',
      'SECTION_WAITERS',
      'ALL_WAITERS',
      'MANAGERS_ON_DUTY',
      'CASHIER',
    ]);
    expect(recipientChoices('MANAGER_NUDGE')).toEqual(['SELECTED']);
    expect(recipientChoices('DEVICE_LOW_BATTERY_OR_OFFLINE')).toEqual([
      'MANAGERS_ON_DUTY',
      'WEARER',
      'CASHIER',
      'OWNER',
    ]);
    expect(recipientChoices('DISK_OR_BACKUP')).toEqual(['MANAGERS_ON_DUTY', 'CASHIER', 'OWNER']);
    expect(repeatChoices('ITEM_READY')).toEqual(['UNTIL_ACKED', 'NONE']);
    expect(repeatChoices('PRINTER_OFFLINE')).toEqual(['UNTIL_RESOLVED', 'UNTIL_ACKED', 'NONE']);
    expect(pagerPlaceholders('ITEM_READY')).toEqual(['{table}']);
    expect(pagerPlaceholders('MANAGER_NUDGE')).toEqual(['{message}']);
    expect(pagerPlaceholders('PRINTER_OFFLINE')).toEqual([]);
  });

  it('[WTR-006] ties the pager to the waiter app and the POS to the dashboard, keeping the rest', () => {
    expect(fixedChannels('ITEM_READY')).toEqual(['TABLET']);
    expect(fixedChannels('DISK_OR_BACKUP')).toEqual(['CONTROL_PLANE']);
    expect(fixedChannels('WATER_REQUEST')).toEqual([]);
    expect(reachOf(DEFAULT_NOTIFICATION_RULES.ORDER_PENDING_APPROVAL)).toEqual({
      phones: true,
      screens: true,
    });
    expect(reachOf(DEFAULT_NOTIFICATION_RULES.PRINTER_OFFLINE)).toEqual({
      phones: false,
      screens: true,
    });
    expect(channelsFor('ITEM_READY', { phones: true, screens: true })).toEqual([
      'PAGER',
      'WAITER_APP',
      'POS',
      'DASHBOARD',
      'TABLET',
    ]);
    expect(channelsFor('PRINTER_OFFLINE', { phones: false, screens: true })).toEqual([
      'POS',
      'DASHBOARD',
    ]);
  });

  it('refuses a rule that cannot work', () => {
    expect(problems('ITEM_READY', { recipients: [] })).toEqual(['NO_RECIPIENT']);
    expect(problems('ITEM_READY', { recipients: ['SELECTED'] })).toEqual(['RECIPIENT_NOT_ALLOWED']);
    expect(problems('ITEM_READY', { channels: ['TABLET'] })).toEqual(['NO_CHANNEL']);
    // The table's tablet stays, and the kitchen's screen is not a water request's.
    expect(problems('ITEM_READY', { channels: ['PAGER', 'WAITER_APP'] })).toEqual([
      'CHANNEL_NOT_ALLOWED',
    ]);
    expect(problems('WATER_REQUEST', { channels: ['PAGER', 'KDS'] })).toEqual([
      'CHANNEL_NOT_ALLOWED',
    ]);
    expect(problems('ITEM_READY', { pagerText: null })).toEqual(['PAGER_TEXT_MISSING']);
    expect(problems('ITEM_READY', { pagerText: '{table} READY TO SERVE NOW' })).toEqual([
      'PAGER_TEXT_TOO_LONG',
    ]);
    expect(
      problems('PRINTER_OFFLINE', {
        channels: ['PAGER', 'WAITER_APP', 'POS', 'DASHBOARD'],
        pagerText: '{table} PRINTER',
      }),
    ).toEqual(['PAGER_TEXT_PLACEHOLDER']);
    // A stray or doubled brace would reach the pager as it is.
    expect(problems('WATER_REQUEST', { pagerText: '{table WATER' })).toEqual([
      'PAGER_TEXT_PLACEHOLDER',
    ]);
    expect(problems('WATER_REQUEST', { pagerText: '{{table}} WATER' })).toEqual([
      'PAGER_TEXT_PLACEHOLDER',
    ]);
    expect(problems('WATER_REQUEST', { pagerText: '{'.repeat(5000) })).toEqual([
      'PAGER_TEXT_TOO_LONG',
      'PAGER_TEXT_PLACEHOLDER',
    ]);
    expect(problems('MANAGER_NUDGE', { pagerText: 'MGR CALLING' })).toEqual([
      'PAGER_TEXT_NEEDS_MESSAGE',
    ]);
    expect(problems('ITEM_READY', { repeat: 'DAILY' })).toEqual(['REPEAT_NOT_ALLOWED']);
    // Off the pager, it needs no pager text.
    expect(problems('PRINTER_OFFLINE', { pagerText: null })).toEqual([]);
    expect(
      overrideProblems({ ORDER_CHANGED: { escalate: true }, BILL_REQUEST: { recipients: [] } }),
    ).toEqual([
      { event: 'BILL_REQUEST', problem: 'NO_RECIPIENT' },
      { event: 'ORDER_CHANGED', problem: 'FIXED_EVENT' },
    ]);
  });

  it('keeps only what differs from the factory rule, so the rest follows it', () => {
    const water = DEFAULT_NOTIFICATION_RULES.WATER_REQUEST;
    expect(
      overrideFor('WATER_REQUEST', {
        ...water,
        recipients: ['CASHIER', 'RESPONSIBLE_WAITER'],
        vibration: 'THREE',
      }),
    ).toEqual({ recipients: ['RESPONSIBLE_WAITER', 'CASHIER'], vibration: 'THREE' });
    // The POS alone, or the POS and the dashboard, reach the same screens.
    expect(
      overrideFor('ORDER_PENDING_APPROVAL', {
        ...DEFAULT_NOTIFICATION_RULES.ORDER_PENDING_APPROVAL,
        channels: ['PAGER', 'WAITER_APP', 'POS', 'DASHBOARD'],
      }),
    ).toBeUndefined();
    expect(
      overrideFor('ITEM_READY', {
        ...DEFAULT_NOTIFICATION_RULES.ITEM_READY,
        channels: channelsFor('ITEM_READY', { phones: true, screens: true }),
      }),
    ).toEqual({ channels: ['PAGER', 'WAITER_APP', 'POS', 'DASHBOARD', 'TABLET'] });
    const changed = withRule({ ITEM_READY: { escalate: false } }, 'WATER_REQUEST', {
      ...water,
      repeat: 'NONE',
    });
    expect(changed).toEqual({ ITEM_READY: { escalate: false }, WATER_REQUEST: { repeat: 'NONE' } });
    // Back to the factory rule.
    expect(withRule(changed, 'ITEM_READY', DEFAULT_NOTIFICATION_RULES.ITEM_READY)).toEqual({
      WATER_REQUEST: { repeat: 'NONE' },
    });
  });
});
