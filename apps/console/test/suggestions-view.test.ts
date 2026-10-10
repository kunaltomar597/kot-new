import {
  type MenuSnapshot,
  type RecommendationPreferenceView,
  RecommendationRuleRequest,
  type RecommendationRuleView,
} from '@rp/contracts';
import { IDS, MENU } from '@rp/ordering/testing';
import { describe, expect, it } from 'vitest';
import {
  CHANNELS,
  categoriesOf,
  categoryChoice,
  channelsText,
  checkRule,
  datesText,
  dishesOf,
  emptyRuleForm,
  hoursText,
  preferenceOf,
  preferenceRows,
  previewRow,
  requestOfRule,
  ruleFormOf,
  ruleReason,
  ruleRequestOf,
  ruleTitle,
  sameRuleRequest,
  takesLabel,
  targetText,
} from '../src/manage/settings/suggestions-view.js';
import { t } from './harness.js';

const BIRYANI = '0199a0e0-0000-7000-8000-000000000090';
const GONE = '0199a0e0-0000-7000-8000-000000000099';
const RULE = '0199a0e0-0000-7000-8000-0000000000f1';

/** The fixture menu with a sub-category and an archived dish. */
const menu: MenuSnapshot = {
  ...MENU,
  categories: [
    ...MENU.categories,
    { id: BIRYANI, name: 'Biryani', parentId: IDS.mains, displayOrder: 1 },
  ],
  items: [...MENU.items, { ...MENU.items[1]!, id: GONE, name: 'Old Kebab', archived: true }],
};

const rule = (changes: Partial<RecommendationRuleView> = {}): RecommendationRuleView => ({
  id: RULE,
  when: { kind: 'ITEM', itemId: IDS.tikka },
  suggest: { kind: 'CATEGORY', categoryId: IDS.mains },
  priority: 70,
  channels: ['POS', 'TABLE_TABLET'],
  timeWindow: { start: '18:00', end: '23:30' },
  activeFrom: '2026-10-01',
  activeUntil: '2026-10-31',
  label: 'Cools the spice',
  active: true,
  archivedAt: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  ...changes,
});

describe('[REC-002] the Suggestions page’s rules in words', () => {
  it('says what a rule does: the dish, any dish of a category, or that it is gone', () => {
    expect(targetText(t, { kind: 'ITEM', itemId: IDS.tikka }, menu)).toBe('Paneer Tikka');
    expect(targetText(t, { kind: 'CATEGORY', categoryId: IDS.mains }, menu)).toBe(
      t('suggestions.rules.anyOf', { category: 'Main Course' }),
    );
    expect(targetText(t, { kind: 'ITEM', itemId: RULE }, menu)).toBe(
      t('suggestions.rules.goneDish'),
    );
    expect(targetText(t, { kind: 'CATEGORY', categoryId: RULE }, menu)).toBe(
      t('suggestions.rules.goneCategory'),
    );
    expect(ruleTitle(t, rule(), menu)).toBe(
      'If the order has Paneer Tikka, suggest any Main Course',
    );
  });

  it('[REC-006] shows the restaurant’s words, or what the tablets say without them', () => {
    expect(ruleReason(t, rule(), menu)).toBe('Cools the spice');
    expect(ruleReason(t, rule({ label: null }), menu)).toBe('Goes well with Paneer Tikka');
    expect(
      ruleReason(
        t,
        rule({ label: null, when: { kind: 'CATEGORY', categoryId: IDS.starters } }),
        menu,
      ),
    ).toBe('Goes well with Starters');
  });

  it('says its hours, dates and places', () => {
    expect(hoursText(t, rule())).toBe('18:00 to 23:30');
    expect(hoursText(t, rule({ timeWindow: { start: '22:00', end: '02:00' } }))).toBe(
      '22:00 to 02:00 the next day',
    );
    expect(hoursText(t, rule({ timeWindow: null }))).toBe(t('suggestions.rules.row.allDay'));
    expect(datesText(t, rule())).toBe('1 Oct 2026 to 31 Oct 2026');
    expect(datesText(t, rule({ activeUntil: null }))).toBe('From 1 Oct 2026');
    expect(datesText(t, rule({ activeFrom: null }))).toBe('Until 31 Oct 2026');
    expect(datesText(t, rule({ activeFrom: null, activeUntil: null }))).toBe(
      t('suggestions.rules.row.everyDay'),
    );
    // In the order the dialog offers them, whatever order they were stored in.
    expect(channelsText(t, ['POS', 'TABLE_TABLET'])).toEqual(['Table tablet', 'POS']);
    expect(CHANNELS).toHaveLength(4);
  });

  it('offers the published dishes by name and the categories in menu order', () => {
    expect(dishesOf(menu).map((dish) => dish.name)).toEqual([
      'Dal Makhani',
      'Gulab Jamun',
      'Paneer Tikka',
      'Rasmalai',
      'Veg Thali Combo',
    ]);
    const categories = categoriesOf(menu);
    expect(categories.map((category) => category.name)).toEqual([
      'Starters',
      'Main Course',
      'Biryani',
    ]);
    expect(categories.map((category) => categoryChoice(t, category, menu))).toEqual([
      'Starters',
      'Main Course',
      'Biryani (Main Course)',
    ]);
  });
});

describe('[REC-002] the rule dialog', () => {
  it('asks for what the order has and what to suggest, and checks the rest as the server does', () => {
    expect(checkRule(emptyRuleForm())).toEqual({
      when: 'whenMissing',
      suggest: 'suggestMissing',
    });
    const form = { ...emptyRuleForm(), whenId: IDS.tikka, suggestId: IDS.dal };
    expect(checkRule(form)).toEqual({});
    expect(checkRule({ ...form, suggestId: IDS.tikka }).suggest).toBe('sameDish');
    // A dish and its category are different things to name.
    expect(checkRule({ ...form, suggestKind: 'CATEGORY', suggestId: IDS.tikka })).toEqual({});
    for (const priority of ['', '1001', '2.5', '-1', 'ten']) {
      expect(checkRule({ ...form, priority }).priority, priority).toBe('priority');
    }
    expect(checkRule({ ...form, priority: ' 1000 ' })).toEqual({});
    expect(checkRule({ ...form, channels: [] }).channels).toBe('channels');
    const hours = { ...form, hoursOnly: true, start: '18:00', end: '23:30' };
    expect(checkRule(hours)).toEqual({});
    expect(checkRule({ ...hours, end: '18:00' }).hours).toBe('hours');
    expect(checkRule({ ...hours, end: '' }).hours).toBe('hours');
    expect(checkRule({ ...hours, start: '24:00' }).hours).toBe('hours');
    const dates = { ...form, datesOnly: true, from: '2026-10-01', until: '2026-10-31' };
    expect(checkRule(dates)).toEqual({});
    expect(checkRule({ ...dates, until: '' })).toEqual({});
    expect(checkRule({ ...dates, from: '', until: '' }).dates).toBe('dates');
    expect(checkRule({ ...dates, from: '2026-11-01' }).dates).toBe('dates');
    expect(checkRule({ ...dates, from: '1 Oct' }).dates).toBe('dates');
  });

  it('turns the form into the request, and a rule into the form and back', () => {
    const form = {
      ...emptyRuleForm(),
      whenId: IDS.tikka,
      suggestKind: 'CATEGORY' as const,
      suggestId: IDS.mains,
      priority: ' 80 ',
      channels: ['POS', 'TABLE_TABLET'] as const,
      hoursOnly: true,
      start: '12:00',
      end: '15:00',
      datesOnly: true,
      from: '2026-10-01',
      label: '  Perfect pair ',
    };
    const request = ruleRequestOf(form);
    expect(request).toEqual({
      when: { kind: 'ITEM', itemId: IDS.tikka },
      suggest: { kind: 'CATEGORY', categoryId: IDS.mains },
      priority: 80,
      channels: ['TABLE_TABLET', 'POS'],
      timeWindow: { start: '12:00', end: '15:00' },
      activeFrom: '2026-10-01',
      activeUntil: null,
      label: 'Perfect pair',
      active: true,
    });
    expect(RecommendationRuleRequest.safeParse(request).success).toBe(true);
    // Hours and dates switched off are not sent, whatever was typed; empty words are none.
    expect(
      ruleRequestOf({ ...form, hoursOnly: false, datesOnly: false, label: ' ' }),
    ).toMatchObject({
      timeWindow: null,
      activeFrom: null,
      activeUntil: null,
      label: null,
    });
    const view = rule();
    // The same rule, its channels in the order the dialog offers them.
    expect(ruleRequestOf(ruleFormOf(view)).channels).toEqual(['TABLE_TABLET', 'POS']);
    expect(sameRuleRequest(ruleRequestOf(ruleFormOf(view)), requestOfRule(view))).toBe(true);
    expect(
      sameRuleRequest(ruleRequestOf({ ...ruleFormOf(view), priority: '71' }), requestOfRule(view)),
    ).toBe(false);
    expect(
      ruleFormOf(rule({ timeWindow: null, activeFrom: null, activeUntil: null })),
    ).toMatchObject({ hoursOnly: false, datesOnly: false, start: '', from: '' });
    expect(requestOfRule(view, { active: false })).toEqual({
      ...requestOfRule(view),
      active: false,
    });
  });
});

describe('[REC-009] pinned, boosted and blocked dishes and the preview', () => {
  const preference = (
    itemId: string,
    kind: RecommendationPreferenceView['preference'],
    label: string | null = null,
  ): RecommendationPreferenceView => ({
    itemId,
    preference: kind,
    label,
    updatedAt: '2026-10-05T08:00:00.000Z',
  });

  it('lists pinned dishes first, then boosted, then blocked, by name', () => {
    const rows = preferenceRows(
      t,
      [
        preference(IDS.jamun, 'BLOCK'),
        preference(IDS.tikka, 'PIN', 'Chef’s special'),
        preference(IDS.thali, 'NORMAL'),
        preference(IDS.rasmalai, 'BOOST'),
        preference(IDS.dal, 'PIN'),
      ],
      menu,
    );
    expect(rows.map((row) => [row.name, row.preference.preference])).toEqual([
      ['Dal Makhani', 'PIN'],
      ['Paneer Tikka', 'PIN'],
      ['Rasmalai', 'BOOST'],
      ['Gulab Jamun', 'BLOCK'],
    ]);
    // A dish not on the published menu (yet) is still listed.
    expect(preferenceRows(t, [preference(RULE, 'BLOCK')], menu)[0]?.name).toBe(
      t('suggestions.dishes.unpublished'),
    );
    expect(preferenceOf([preference(IDS.dal, 'BOOST', 'Fresh')], IDS.dal)).toEqual({
      preference: 'BOOST',
      label: 'Fresh',
    });
    expect(preferenceOf([], IDS.dal)).toEqual({ preference: 'NORMAL', label: null });
    expect(['NORMAL', 'PIN', 'BOOST', 'BLOCK'].filter((kind) => takesLabel(kind as 'PIN'))).toEqual(
      ['PIN', 'BOOST'],
    );
  });

  it('[REC-006] previews a suggestion with the reason the tablets show and where it comes from', () => {
    expect(
      previewRow(
        t,
        { itemId: IDS.dal, layer: 'PINNED', reason: { kind: 'PINNED', label: null } },
        menu,
      ),
    ).toEqual({ itemId: IDS.dal, name: 'Dal Makhani', reason: 'Our pick', layer: 'Pinned' });
    expect(
      previewRow(
        t,
        {
          itemId: IDS.jamun,
          layer: 'RULE',
          reason: { kind: 'RULE', ruleId: RULE, label: null, becauseOf: 'Paneer Tikka' },
        },
        menu,
      ),
    ).toMatchObject({
      reason: 'Goes well with Paneer Tikka',
      layer: t('suggestions.preview.layer.RULE'),
    });
    expect(
      previewRow(
        t,
        {
          itemId: IDS.tikka,
          layer: 'BEST_SELLER',
          reason: { kind: 'BEST_SELLER', daypart: 'LUNCH' },
        },
        menu,
      ),
    ).toMatchObject({ reason: 'Bestseller at lunch', layer: 'Best seller' });
  });
});
