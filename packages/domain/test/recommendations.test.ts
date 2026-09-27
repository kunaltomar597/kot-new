import { describe, expect, it } from 'vitest';
import {
  courseIndexes,
  daypartAt,
  type Dayparts,
  DomainError,
  inTimeWindow,
  type ItemCount,
  type RecoCategory,
  type RecoItem,
  recommend,
  type RecommendationInput,
  type RecommendationRuleDef,
  ruleIsOn,
  timeOfDayOf,
} from '../src/index.js';

const categories: RecoCategory[] = [
  { id: 'starters', name: 'Starters', parentId: null },
  { id: 'mains', name: 'Mains', parentId: null },
  { id: 'rice', name: 'Rice', parentId: 'mains' },
  { id: 'breads', name: 'Breads', parentId: null },
  { id: 'desserts', name: 'Desserts', parentId: null },
  { id: 'beverages', name: 'beverages', parentId: null },
  { id: 'sides', name: 'Sides', parentId: null },
];

const ALL = ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'] as const;
const item = (id: string, categoryId: string, changes: Partial<RecoItem> = {}): RecoItem => ({
  id,
  name: id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' '),
  categoryId,
  foodType: 'VEG',
  available: true,
  stockCount: null,
  channels: ALL,
  repeatable: false,
  ...changes,
});

const items: RecoItem[] = [
  item('paneer-tikka', 'starters'),
  item('chicken-tikka', 'starters', { foodType: 'NON_VEG' }),
  item('butter-chicken', 'mains', { foodType: 'NON_VEG' }),
  item('dal-makhani', 'mains'),
  item('veg-biryani', 'rice'),
  item('egg-curry', 'mains', { foodType: 'EGG' }),
  item('naan', 'breads', { repeatable: true }),
  item('gulab-jamun', 'desserts'),
  item('kulfi', 'desserts', { stockCount: 0 }),
  item('lassi', 'beverages', { repeatable: true }),
  item('mojito', 'beverages', { available: false }),
  item('raita', 'sides'),
  item('chef-special', 'mains', { channels: ['POS', 'WAITER_APP'] }),
  item('old-soup', 'starters', { archived: true }),
];

/** Lunch over the last 30 days. */
const lunch: ItemCount[] = [
  { itemId: 'butter-chicken', quantity: 50 },
  { itemId: 'naan', quantity: 40 },
  { itemId: 'lassi', quantity: 30 },
  { itemId: 'dal-makhani', quantity: 25 },
  { itemId: 'paneer-tikka', quantity: 20 },
  { itemId: 'gulab-jamun', quantity: 10 },
  { itemId: 'raita', quantity: 5 },
  { itemId: 'kulfi', quantity: 45 },
  { itemId: 'mojito', quantity: 35 },
  { itemId: 'chef-special', quantity: 60 },
  { itemId: 'old-soup', quantity: 70 },
];

const rule = (id: string, changes: Partial<RecommendationRuleDef> = {}): RecommendationRuleDef => ({
  id,
  priority: 50,
  when: { kind: 'ITEM', itemId: 'veg-biryani' },
  suggest: { kind: 'ITEM', itemId: 'raita' },
  channels: ALL,
  timeWindow: null,
  activeFrom: null,
  activeUntil: null,
  label: null,
  ...changes,
});

const input = (changes: Partial<RecommendationInput> = {}): RecommendationInput => ({
  items,
  categories,
  rules: [],
  bestSellers: lunch,
  daypart: 'LUNCH',
  channel: 'TABLE_TABLET',
  ordered: [],
  vegOnly: false,
  time: '13:00',
  businessDate: '2026-09-27',
  courseSequence: ['Starters', 'Mains', 'Breads', 'Desserts', 'Beverages'],
  limit: 6,
  ...changes,
});

const ids = (changes: Partial<RecommendationInput> = {}) =>
  recommend(input(changes)).map((suggestion) => suggestion.itemId);

describe('[REC-004] best sellers', () => {
  it('suggests the best sellers of the time of day when nothing is ordered, starters first', () => {
    const suggestions = recommend(input({ limit: 5 }));
    expect(suggestions.map((suggestion) => suggestion.itemId)).toEqual([
      'paneer-tikka',
      'butter-chicken',
      'naan',
      'lassi',
      'dal-makhani',
    ]);
    expect(suggestions[0]).toEqual({
      itemId: 'paneer-tikka',
      layer: 'BEST_SELLER',
      reason: { kind: 'BEST_SELLER', daypart: 'LUNCH' },
    });
  });

  it('[REC-005] after the starters favours the mains, and puts a course already served last', () => {
    expect(ids({ ordered: ['paneer-tikka'], limit: 10 })).toEqual([
      'butter-chicken',
      'dal-makhani',
      'naan',
      'lassi',
      'gulab-jamun',
      'raita',
    ]);
    // Past the mains: breads next, then desserts and drinks; starters and mains come last.
    expect(ids({ ordered: ['chicken-tikka', 'butter-chicken'], limit: 10 })).toEqual([
      'naan',
      'lassi',
      'gulab-jamun',
      'raita',
      'dal-makhani',
      'paneer-tikka',
    ]);
  });

  it('knows the time of day, a dinner that runs past midnight, and the hours outside them', () => {
    const dayparts: Dayparts = {
      BREAKFAST: { start: '07:00', end: '11:00' },
      LUNCH: { start: '11:00', end: '16:00' },
      EVENING: { start: '16:00', end: '19:00' },
      DINNER: { start: '19:00', end: '04:00' },
    };
    expect(daypartAt('07:00', dayparts)).toBe('BREAKFAST');
    expect(daypartAt('10:59', dayparts)).toBe('BREAKFAST');
    expect(daypartAt('11:00', dayparts)).toBe('LUNCH');
    expect(daypartAt('17:30', dayparts)).toBe('EVENING');
    expect(daypartAt('23:45', dayparts)).toBe('DINNER');
    expect(daypartAt('01:30', dayparts)).toBe('DINNER');
    expect(daypartAt('05:00', dayparts)).toBeNull();
    // Outside every window the best sellers of the whole day are used, and say so.
    expect(recommend(input({ daypart: null, limit: 1 }))[0]?.reason).toEqual({
      kind: 'BEST_SELLER',
      daypart: null,
    });
  });

  it('reads local time in India', () => {
    expect(timeOfDayOf(new Date('2026-09-27T07:00:00Z'), 'Asia/Kolkata')).toBe('12:30');
    expect(timeOfDayOf(new Date('2026-09-27T19:45:00Z'))).toBe('01:15');
    expect(inTimeWindow('03:59', { start: '19:00', end: '04:00' })).toBe(true);
    expect(inTimeWindow('04:00', { start: '19:00', end: '04:00' })).toBe(false);
    expect(inTimeWindow('12:00', { start: '12:00', end: '12:00' })).toBe(false);
  });
});

describe('[REC-005] filters on every layer', () => {
  it('leaves out what cannot be served on this channel now', () => {
    const suggested = ids({ limit: 20 });
    // Sold out, not available, archived, and a dish the tablet does not show.
    for (const hidden of ['kulfi', 'mojito', 'old-soup', 'chef-special']) {
      expect(suggested).not.toContain(hidden);
    }
    // The waiter's phone shows the chef's special.
    expect(ids({ channel: 'WAITER_APP', limit: 20 })).toContain('chef-special');
  });

  it('leaves out what is in the order already, unless it is repeatable', () => {
    const suggested = ids({ ordered: ['butter-chicken', 'naan', 'lassi'], limit: 20 });
    expect(suggested).not.toContain('butter-chicken');
    expect(suggested).toContain('naan');
    expect(suggested).toContain('lassi');
  });

  it('shows only veg dishes when the table shows veg only (egg is not veg)', () => {
    const rules = [
      rule('naan-mains', {
        when: { kind: 'ITEM', itemId: 'naan' },
        suggest: { kind: 'CATEGORY', categoryId: 'mains' },
      }),
    ];
    // The rule's mains without chicken and egg; then desserts (the next course after breads),
    // drinks and sides, and last the courses served already.
    expect(ids({ vegOnly: true, rules, ordered: ['naan'], limit: 20 })).toEqual([
      'dal-makhani',
      'veg-biryani',
      'gulab-jamun',
      'lassi',
      'raita',
      'naan',
      'paneer-tikka',
    ]);
    expect(ids({ vegOnly: false, rules, ordered: ['naan'], limit: 20 })).toContain('egg-curry');
  });

  it('skips a rule’s suggestion that is sold out, and the next rule fills in', () => {
    const rules = [
      rule('sold-out', { priority: 90, suggest: { kind: 'ITEM', itemId: 'kulfi' } }),
      rule('raita', { priority: 10 }),
    ];
    const [first] = recommend(input({ rules, ordered: ['veg-biryani'] }));
    expect(first?.itemId).toBe('raita');
  });

  it('takes a sub-category’s course from its parent unless it names one itself', () => {
    const indexes = courseIndexes(
      [...categories, { id: 'naan-basket', name: 'BREADS', parentId: 'mains' }],
      ['Starters', 'Mains', 'Breads'],
    );
    expect(indexes.get('rice')).toBe(1);
    expect(indexes.get('naan-basket')).toBe(2);
    expect(indexes.get('beverages')).toBeUndefined();
    expect(indexes.has('sides')).toBe(false);
  });
});

describe('[REC-002] manual rules', () => {
  it('suggests what a rule names when the order has its dish, before any best seller', () => {
    const rules = [rule('biryani-raita', { label: 'Cools the spice' })];
    const suggestions = recommend(input({ rules, ordered: ['veg-biryani'], limit: 3 }));
    expect(suggestions[0]).toEqual({
      itemId: 'raita',
      layer: 'RULE',
      reason: {
        kind: 'RULE',
        ruleId: 'biryani-raita',
        label: 'Cools the spice',
        becauseOf: 'Veg Biryani',
      },
    });
    expect(suggestions.slice(1).map((suggestion) => suggestion.layer)).toEqual([
      'BEST_SELLER',
      'BEST_SELLER',
    ]);
    // Without the dish in the order the rule stays quiet.
    const without = recommend(input({ rules, ordered: ['dal-makhani'] }));
    expect(without.some((suggestion) => suggestion.layer === 'RULE')).toBe(false);
  });

  it('matches a category with its sub-categories, and suggests a category best first', () => {
    const rules = [
      rule('mains-bread', {
        when: { kind: 'CATEGORY', categoryId: 'mains' },
        suggest: { kind: 'CATEGORY', categoryId: 'breads' },
      }),
      rule('mains-dessert', {
        priority: 40,
        when: { kind: 'CATEGORY', categoryId: 'mains' },
        suggest: { kind: 'CATEGORY', categoryId: 'desserts' },
      }),
    ];
    const suggestions = recommend(input({ rules, ordered: ['veg-biryani'], limit: 3 }));
    // Kulfi sells more but is sold out; after the rules, the best sellers fill in.
    expect(suggestions.map((suggestion) => suggestion.itemId)).toEqual([
      'naan',
      'gulab-jamun',
      'lassi',
    ]);
    expect(suggestions[0]?.reason).toMatchObject({ ruleId: 'mains-bread', becauseOf: 'Mains' });
    expect(suggestions[1]?.reason).toMatchObject({ ruleId: 'mains-dessert' });
  });

  it('follows priority, higher first, whatever order the rules come in', () => {
    const rules = [
      rule('low', { priority: 10, suggest: { kind: 'ITEM', itemId: 'lassi' } }),
      rule('high', { priority: 90 }),
      rule('mid-b', { priority: 50, suggest: { kind: 'ITEM', itemId: 'gulab-jamun' } }),
      rule('mid-a', { priority: 50, suggest: { kind: 'ITEM', itemId: 'naan' } }),
    ];
    expect(ids({ rules, ordered: ['veg-biryani'], limit: 4 })).toEqual([
      'raita',
      'naan',
      'gulab-jamun',
      'lassi',
    ]);
  });

  it('is on only for its channels, business dates and hours, also past midnight', () => {
    const base = rule('r');
    expect(ruleIsOn(base, 'QR', '2026-09-27', '13:00')).toBe(true);
    expect(ruleIsOn({ ...base, channels: ['POS'] }, 'QR', '2026-09-27', '13:00')).toBe(false);
    const dated = { ...base, activeFrom: '2026-09-27', activeUntil: '2026-09-28' };
    expect(ruleIsOn(dated, 'QR', '2026-09-26', '13:00')).toBe(false);
    expect(ruleIsOn(dated, 'QR', '2026-09-27', '13:00')).toBe(true);
    expect(ruleIsOn(dated, 'QR', '2026-09-28', '13:00')).toBe(true);
    expect(ruleIsOn(dated, 'QR', '2026-09-29', '13:00')).toBe(false);
    const late = { ...base, timeWindow: { start: '22:00', end: '02:00' } };
    expect(ruleIsOn(late, 'QR', '2026-09-27', '23:30')).toBe(true);
    expect(ruleIsOn(late, 'QR', '2026-09-27', '01:59')).toBe(true);
    expect(ruleIsOn(late, 'QR', '2026-09-27', '02:00')).toBe(false);
    expect(ruleIsOn(late, 'QR', '2026-09-27', '13:00')).toBe(false);
    expect(ids({ rules: [late], ordered: ['veg-biryani'], limit: 1 })).toEqual(['naan']);
    expect(ids({ rules: [late], ordered: ['veg-biryani'], limit: 1, time: '23:00' })).toEqual([
      'raita',
    ]);
  });
});

describe('[REC-001] [REC-006] layers and reasons', () => {
  it('puts rules first, then learned pairings, then best sellers, never the same dish twice', () => {
    const suggestions = recommend(
      input({
        rules: [rule('biryani-raita')],
        learned: [
          { fromItemId: 'veg-biryani', toItemId: 'lassi', score: 2 },
          { fromItemId: 'veg-biryani', toItemId: 'raita', score: 5 },
          { fromItemId: 'veg-biryani', toItemId: 'gulab-jamun', score: 3 },
          // Learned from a dish that is not in this order: not used.
          { fromItemId: 'paneer-tikka', toItemId: 'naan', score: 9 },
        ],
        ordered: ['veg-biryani'],
        limit: 5,
      }),
    );
    expect(suggestions.map(({ itemId, layer }) => `${layer}:${itemId}`)).toEqual([
      'RULE:raita',
      'LEARNED:gulab-jamun',
      'LEARNED:lassi',
      'BEST_SELLER:naan',
      'BEST_SELLER:butter-chicken',
    ]);
    expect(suggestions[1]?.reason).toEqual({ kind: 'LEARNED', becauseOf: 'Veg Biryani' });
    for (const suggestion of suggestions) expect(suggestion.reason.kind).toBe(suggestion.layer);
  });

  it('gives at most the number asked for, and refuses a number that is not whole', () => {
    expect(ids({ limit: 2 })).toHaveLength(2);
    expect(ids({ limit: 0 })).toEqual([]);
    expect(() => recommend(input({ limit: 1.5 }))).toThrow(DomainError);
    expect(() => recommend(input({ limit: -1 }))).toThrow(DomainError);
  });

  it('[REC-007] depends only on the table’s order, time and channel', () => {
    const first = recommend(input({ ordered: ['dal-makhani', 'naan'] }));
    const second = recommend(input({ ordered: ['naan', 'dal-makhani'] }));
    expect(second).toEqual(first);
  });
});

describe('[NFR-P09] [REC-011] speed', () => {
  it('answers for a 1,000-dish menu with 200 rules in well under 200 ms', () => {
    const big: RecoItem[] = Array.from({ length: 1_000 }, (_, index) =>
      item(`dish-${String(index)}`, categories[index % categories.length]?.id ?? 'mains', {
        foodType: index % 3 === 0 ? 'NON_VEG' : 'VEG',
        repeatable: index % 10 === 0,
      }),
    );
    const rules = Array.from({ length: 200 }, (_, index) =>
      rule(`rule-${String(index)}`, {
        priority: index % 100,
        when:
          index % 2 === 0
            ? { kind: 'ITEM', itemId: `dish-${String(index)}` }
            : {
                kind: 'CATEGORY',
                categoryId: categories[index % categories.length]?.id ?? 'mains',
              },
        suggest:
          index % 3 === 0
            ? {
                kind: 'CATEGORY',
                categoryId: categories[(index + 1) % categories.length]?.id ?? 'sides',
              }
            : { kind: 'ITEM', itemId: `dish-${String((index * 7) % 1_000)}` },
        timeWindow: index % 4 === 0 ? { start: '11:00', end: '16:00' } : null,
      }),
    );
    const bestSellers = big.map((dish, index) => ({ itemId: dish.id, quantity: 1_000 - index }));
    const ordered = Array.from({ length: 20 }, (_, index) => `dish-${String(index * 13)}`);
    const timings: number[] = [];
    for (let run = 0; run < 50; run += 1) {
      const started = performance.now();
      const suggestions = recommend(
        input({ items: big, rules, bestSellers, ordered, vegOnly: run % 2 === 0, limit: 8 }),
      );
      timings.push(performance.now() - started);
      expect(suggestions).toHaveLength(8);
    }
    timings.sort((a, b) => a - b);
    // The 95th percentile, far inside the 200 ms the server has for the whole request.
    expect(timings[Math.floor(timings.length * 0.95)]).toBeLessThan(50);
  });
});
