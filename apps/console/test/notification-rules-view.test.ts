import {
  DEFAULT_NOTIFICATION_RULES,
  NOTIFICATION_EVENTS,
  recipientChoices,
  repeatChoices,
  VIBRATION_PATTERNS,
} from '@rp/domain';
import { describe, expect, it } from 'vitest';
import {
  draftProblems,
  escalationAfter,
  factoryRule,
  fixedPlacesOf,
  isChanged,
  isFixed,
  normalized,
  overridesOf,
  pagerPreview,
  pagerTextHint,
  peopleOf,
  placesOf,
  problemTexts,
  RULE_GROUPS,
  repeatText,
  rulesSettingOf,
  sameRule,
  TIMING_SETTINGS,
  timingOf,
  withPlaces,
  withRecipients,
} from '../src/manage/settings/notification-rules-view.js';
import { EDITED_ELSEWHERE } from '../src/manage/settings/settings-view.js';
import { t } from './harness.js';
import { settingViews } from './settings-fixture.js';

const TIMING = { escalationSeconds: 60, repeatSeconds: 60 };

describe('[NTF-002] [NTF-003] the notification rules page', () => {
  it('shows every alert of Appendix C once, in words, with N, R and the nudge messages', () => {
    const shown = RULE_GROUPS.flatMap((group) => group.events);
    expect([...shown].sort()).toEqual([...NOTIFICATION_EVENTS].sort());
    expect(new Set(shown).size).toBe(NOTIFICATION_EVENTS.length);
    for (const { group, events } of RULE_GROUPS) {
      expect(t(`notificationRules.groups.${group}`)).not.toBe('');
      for (const event of events) {
        expect(t(`alerts.type.${event}`), event).not.toBe('');
        expect(t(`notificationRules.events.${event}`), event).not.toBe('');
        for (const kind of recipientChoices(event)) {
          expect(t(`notificationRules.recipients.${kind}`), kind).not.toBe('');
        }
        for (const policy of repeatChoices(event)) {
          expect(repeatText(t, policy, TIMING), policy).not.toBe('');
        }
        expect(peopleOf(t, factoryRule(event)), event).not.toBe('');
        for (const place of placesOf(event, factoryRule(event))) {
          expect(t(`notificationRules.places.${place}`), place).not.toBe('');
        }
      }
    }
    for (const pattern of VIBRATION_PATTERNS) {
      expect(t(`notificationRules.vibration.${pattern}`)).not.toBe('');
    }
    // N, R and the nudge messages are on the General page too; only the rules are not.
    expect(TIMING_SETTINGS.some((key) => EDITED_ELSEWHERE.has(key))).toBe(false);
    expect(EDITED_ELSEWHERE.has('notifications.rules')).toBe(true);
  });

  it('reads the restaurant’s changes and N and R from the settings', () => {
    const changes = { BILL_REQUEST: { recipients: ['CASHIER'] } };
    const settings = settingViews('MANAGER', {
      'notifications.rules': changes,
      'notifications.escalationSeconds': 90,
    });
    expect(rulesSettingOf(settings)?.key).toBe('notifications.rules');
    expect(overridesOf(settings)).toEqual(changes);
    expect(timingOf(settings)).toEqual({ escalationSeconds: 90, repeatSeconds: 60 });
    expect(isChanged(overridesOf(settings), 'BILL_REQUEST')).toBe(true);
    expect(isChanged(overridesOf(settings), 'WATER_REQUEST')).toBe(false);
    // A change that matches the factory rule is no change.
    expect(isChanged({ ITEM_READY: { vibration: 'ONE_LONG' } }, 'ITEM_READY')).toBe(false);
    // A value the console cannot read shows the factory rules instead of breaking the page.
    expect(overridesOf(settingViews('MANAGER', { 'notifications.rules': 'nonsense' }))).toEqual({});
    expect(overridesOf([])).toEqual({});
    expect(timingOf([])).toEqual(TIMING);
  });

  it('says whom an alert goes to and where it shows', () => {
    expect(peopleOf(t, factoryRule('BILL_REQUEST'))).toBe(
      `${t('notificationRules.people.RESPONSIBLE_WAITER')} and ${t('notificationRules.people.CASHIER')}`,
    );
    // In the order they are offered, whatever order they were stored in.
    expect(peopleOf(t, { recipients: ['OWNER', 'MANAGERS_ON_DUTY'] })).toBe(
      `${t('notificationRules.people.MANAGERS_ON_DUTY')} and ${t('notificationRules.people.OWNER')}`,
    );
    expect(placesOf('ITEM_READY', factoryRule('ITEM_READY'))).toEqual(['PHONES', 'TABLET']);
    expect(placesOf('BILL_REQUEST', factoryRule('BILL_REQUEST'))).toEqual(['PHONES', 'SCREENS']);
    expect(placesOf('DISK_OR_BACKUP', factoryRule('DISK_OR_BACKUP'))).toEqual([
      'SCREENS',
      'CONTROL_PLANE',
    ]);
    expect(placesOf('ORDER_CHANGED', factoryRule('ORDER_CHANGED'))).toEqual([
      'KDS',
      'PRINTED_SLIP',
    ]);
    expect(fixedPlacesOf('WATER_REQUEST')).toEqual([]);
    expect(isFixed('ORDER_CHANGED')).toBe(true);
    expect(isFixed('WAITER_UNREACHABLE')).toBe(true);
    expect(isFixed('WATER_REQUEST')).toBe(false);
  });

  it('[PGR-006] previews the pager’s text with a table or a message, and says what it fills in', () => {
    expect(pagerPreview(t, factoryRule('WATER_REQUEST'))).toBe('T7 WATER');
    expect(pagerPreview(t, { pagerText: '{table} cheque' })).toBe('T7 CHEQUE');
    expect(pagerPreview(t, factoryRule('MANAGER_NUDGE'))).toBe(
      `MGR: ${t('notificationRules.dialog.exampleMessage')}`,
    );
    expect(pagerPreview(t, factoryRule('DEVICE_LOW_BATTERY_OR_OFFLINE'))).toBe('LOW BATTERY');
    expect(pagerPreview(t, { pagerText: '  ' })).toBeNull();
    expect(pagerPreview(t, factoryRule('PRINTER_OFFLINE'))).toBeNull();
    expect(pagerTextHint(t, 'WATER_REQUEST')).toBe(
      t('notificationRules.dialog.pagerTextTable', {
        max: 20,
        placeholder: '{table}',
        example: 'T7',
      }),
    );
    expect(pagerTextHint(t, 'MANAGER_NUDGE')).toBe(
      t('notificationRules.dialog.pagerTextMessage', { max: 20, placeholder: '{message}' }),
    );
    expect(pagerTextHint(t, 'DEVICE_LOW_BATTERY_OR_OFFLINE')).toBe(
      t('notificationRules.dialog.pagerTextHint', { max: 20 }),
    );
  });

  it('says how an unanswered alert repeats and when it goes to the managers', () => {
    const timing = { escalationSeconds: 90, repeatSeconds: 30 };
    expect(repeatText(t, 'UNTIL_ACKED', timing)).toBe(
      t('notificationRules.repeat.UNTIL_ACKED', { every: '30 seconds' }),
    );
    expect(repeatText(t, 'NONE', timing)).toBe(t('notificationRules.repeat.NONE'));
    expect(escalationAfter(t, timing)).toBe('90 seconds');
  });

  it('edits a rule: whom it alerts and where, back to the factory rule, compared by what it does', () => {
    const bill = factoryRule('BILL_REQUEST');
    expect(withRecipients(bill, ['CASHIER', 'MANAGERS_ON_DUTY']).recipients).toEqual([
      'MANAGERS_ON_DUTY',
      'CASHIER',
    ]);
    expect(withPlaces('ITEM_READY', factoryRule('ITEM_READY'), ['SCREENS']).channels).toEqual([
      'POS',
      'DASHBOARD',
      'TABLET',
    ]);
    // Taking the POS away and putting it back gives the same rule, with the dashboard too.
    const back = withPlaces('BILL_REQUEST', withPlaces('BILL_REQUEST', bill, ['PHONES']), [
      'PHONES',
      'SCREENS',
    ]);
    expect(back.channels).toEqual(['PAGER', 'WAITER_APP', 'POS', 'DASHBOARD']);
    expect(sameRule('BILL_REQUEST', back, bill)).toBe(true);
    expect(sameRule('BILL_REQUEST', { ...bill, pagerText: ' {table} BILL ' }, bill)).toBe(true);
    expect(sameRule('BILL_REQUEST', { ...bill, vibration: 'THREE' }, bill)).toBe(false);
    expect(normalized({ ...bill, pagerText: '  ' }).pagerText).toBeNull();
    expect(normalized({ ...bill, pagerText: ' {table} PAY ' }).pagerText).toBe('{table} PAY');
    expect(factoryRule('BILL_REQUEST')).toBe(DEFAULT_NOTIFICATION_RULES.BILL_REQUEST);
  });

  it('says what stops a rule from working, beside the field it is about', () => {
    const water = factoryRule('WATER_REQUEST');
    expect(draftProblems(t, 'WATER_REQUEST', water)).toEqual([]);
    expect(draftProblems(t, 'WATER_REQUEST', { ...water, recipients: [], channels: [] })).toEqual([
      { field: 'recipients', text: t('notificationRules.dialog.problems.NO_RECIPIENT') },
      { field: 'places', text: t('notificationRules.dialog.problems.NO_CHANNEL') },
    ]);
    expect(draftProblems(t, 'WATER_REQUEST', { ...water, pagerText: '' })).toEqual([
      { field: 'pagerText', text: t('notificationRules.dialog.problems.PAGER_TEXT_MISSING') },
    ]);
    expect(draftProblems(t, 'WATER_REQUEST', { ...water, pagerText: '{message} NOW' })).toEqual([
      {
        field: 'pagerText',
        text: t('notificationRules.dialog.problems.PAGER_TEXT_PLACEHOLDER', { allowed: '{table}' }),
      },
    ]);
    expect(
      draftProblems(t, 'PRINTER_OFFLINE', {
        ...factoryRule('PRINTER_OFFLINE'),
        channels: ['PAGER', 'WAITER_APP'],
        pagerText: '{table} PRINTER',
      }),
    ).toEqual([
      {
        field: 'pagerText',
        text: t('notificationRules.dialog.problems.PAGER_TEXT_NO_PLACEHOLDER'),
      },
    ]);
    expect(
      draftProblems(t, 'MANAGER_NUDGE', { ...factoryRule('MANAGER_NUDGE'), pagerText: 'MGR' }),
    ).toEqual([
      {
        field: 'pagerText',
        text: t('notificationRules.dialog.problems.PAGER_TEXT_NEEDS_MESSAGE', {
          placeholder: '{message}',
        }),
      },
    ]);
    expect(
      problemTexts(t, 'WATER_REQUEST', [
        'PAGER_TEXT_TOO_LONG',
        'RECIPIENT_NOT_ALLOWED',
        'CHANNEL_NOT_ALLOWED',
        'REPEAT_NOT_ALLOWED',
        'FIXED_EVENT',
      ]).map((problem) => problem.field),
    ).toEqual(['pagerText', 'recipients', 'places', 'other', 'other']);
    expect(problemTexts(t, 'WATER_REQUEST', ['PAGER_TEXT_TOO_LONG'])[0]?.text).toBe(
      t('notificationRules.dialog.problems.PAGER_TEXT_TOO_LONG', { max: 20 }),
    );
  });
});
