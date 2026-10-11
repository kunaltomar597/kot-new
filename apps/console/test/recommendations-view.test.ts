import { IDS, MENU } from '@rp/ordering/testing';
import { describe, expect, it } from 'vitest';
import {
  checkRuleDraft,
  featuredDishes,
  menuNames,
  ruleDraftOf,
  ruleRequestOf,
  targetName,
  withPreference,
} from '../src/manage/settings/recommendations-view.js';
import { ruleView } from './recommendations-fixture.js';

const names = menuNames(MENU);

describe('[REC-002] a rule as the form holds it', () => {
  it('starts a new rule on every channel at priority 50, and asks what to pair', () => {
    const draft = ruleDraftOf();
    expect(draft.channels).toEqual(['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR']);
    expect(draft.priority).toBe('50');
    expect(checkRuleDraft(draft)).toEqual(['WHEN_REQUIRED', 'SUGGEST_REQUIRED']);
    expect(ruleRequestOf(draft)).toBeUndefined();
  });

  it('turns a rule into a draft and back into the same request', () => {
    const rule = ruleView({
      timeWindow: { start: '12:00', end: '15:30' },
      activeFrom: '2026-10-01',
      activeUntil: '2026-10-31',
      label: 'Cools the spice',
      channels: ['QR', 'POS'],
    });
    expect(ruleRequestOf(ruleDraftOf(rule))).toEqual({
      when: rule.when,
      suggest: rule.suggest,
      priority: rule.priority,
      // Listed in the order of the channels, each once.
      channels: ['POS', 'QR'],
      timeWindow: { start: '12:00', end: '15:30' },
      activeFrom: '2026-10-01',
      activeUntil: '2026-10-31',
      label: 'Cools the spice',
      active: true,
    });
  });

  it('finds what the server would refuse before it is sent', () => {
    const base = ruleDraftOf(ruleView());
    expect(checkRuleDraft({ ...base, suggestId: base.whenId })).toEqual(['SAME_DISH']);
    expect(checkRuleDraft({ ...base, priority: '1001' })).toEqual(['PRIORITY']);
    expect(checkRuleDraft({ ...base, priority: '2.5' })).toEqual(['PRIORITY']);
    expect(checkRuleDraft({ ...base, channels: [] })).toEqual(['CHANNELS_REQUIRED']);
    expect(checkRuleDraft({ ...base, hours: true, start: '12:00', end: '12:00' })).toEqual([
      'HOURS',
    ]);
    expect(checkRuleDraft({ ...base, hours: true, start: '22:00', end: '02:00' })).toEqual([]);
    expect(checkRuleDraft({ ...base, from: '2026-10-02', until: '2026-10-01' })).toEqual(['DATES']);
    expect(ruleRequestOf({ ...base, label: '   ', hours: false, start: '9' })).toMatchObject({
      label: null,
      timeWindow: null,
    });
  });

  it('names dishes and categories from the published menu', () => {
    expect(targetName({ kind: 'ITEM', itemId: IDS.dal }, names)).toBe('Dal Makhani');
    expect(targetName({ kind: 'CATEGORY', categoryId: IDS.starters }, names)).toBe('Starters');
    expect(targetName({ kind: 'ITEM', itemId: IDS.session }, names)).toBeUndefined();
  });
});

describe('[REC-009] pinned, boosted and blocked dishes', () => {
  it('lists pinned, then boosted, then blocked, each by name', () => {
    expect(
      featuredDishes(
        {
          [IDS.jamun]: 'BLOCK',
          [IDS.tikka]: 'BOOST',
          [IDS.dal]: 'PIN',
          [IDS.thali]: 'BOOST',
          [IDS.session]: 'PIN',
        },
        names,
      ).map((dish) => `${dish.preference}:${dish.name ?? '?'}`),
    ).toEqual([
      'PIN:?',
      'PIN:Dal Makhani',
      'BOOST:Paneer Tikka',
      'BOOST:Veg Thali Combo',
      'BLOCK:Gulab Jamun',
    ]);
  });

  it('changes or removes one dish, keeping the others', () => {
    const preferences = { [IDS.dal]: 'PIN', [IDS.tikka]: 'BOOST' } as const;
    expect(withPreference(preferences, IDS.dal, 'BLOCK')).toEqual({
      [IDS.dal]: 'BLOCK',
      [IDS.tikka]: 'BOOST',
    });
    expect(withPreference(preferences, IDS.dal, undefined)).toEqual({ [IDS.tikka]: 'BOOST' });
    expect(withPreference({}, IDS.jamun, 'PIN')).toEqual({ [IDS.jamun]: 'PIN' });
  });
});
