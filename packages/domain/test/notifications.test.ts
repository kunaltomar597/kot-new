import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_RULES,
  dueActions,
  effectiveRule,
  initialDeadlines,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  pagerTextFor,
  type RecipientContext,
  resolveRecipients,
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
