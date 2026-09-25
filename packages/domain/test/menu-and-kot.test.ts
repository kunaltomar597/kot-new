import { describe, expect, it } from 'vitest';
import {
  splitIntoKots,
  unitPriceOf,
  validateSelection,
  type SelectableItemDef,
} from '../src/index.js';

const naan: SelectableItemDef = { id: 'naan', basePrice: 6000 };

const paneerTikka: SelectableItemDef = {
  id: 'paneer-tikka',
  basePrice: 30_000,
  variants: [
    { id: 'half', name: 'Half', price: 18_000 },
    { id: 'full', name: 'Full', price: 30_000 },
  ],
  modifierGroups: [
    {
      id: 'spice',
      name: 'Spice level',
      minSelections: 1,
      maxSelections: 1,
      options: [
        { id: 'mild', name: 'Mild', priceDelta: 0 },
        { id: 'hot', name: 'Hot', priceDelta: 0 },
      ],
    },
    {
      id: 'addons',
      name: 'Add-ons',
      minSelections: 0,
      maxSelections: 2,
      options: [
        { id: 'cheese', name: 'Extra cheese', priceDelta: 4000 },
        { id: 'no-onion', name: 'No onion', priceDelta: -500 },
        { id: 'butter', name: 'Butter', priceDelta: 2000 },
      ],
    },
  ],
};

describe('[MENU-012] shared variant and modifier selection', () => {
  it('[MENU-003] prices variants and [MENU-004] modifier deltas', () => {
    expect(unitPriceOf(naan, {})).toBe(6000);
    expect(
      unitPriceOf(paneerTikka, {
        variantId: 'half',
        modifiers: [
          { groupId: 'spice', optionIds: ['hot'] },
          { groupId: 'addons', optionIds: ['cheese', 'no-onion'] },
        ],
      }),
    ).toBe(21_500);
  });

  it('reports every problem with a selection', () => {
    expect(validateSelection(paneerTikka, {}).map((issue) => issue.code)).toEqual([
      'VARIANT_REQUIRED',
      'TOO_FEW_MODIFIERS',
    ]);
    expect(
      validateSelection(paneerTikka, {
        variantId: 'large',
        modifiers: [
          { groupId: 'spice', optionIds: ['mild', 'hot'] },
          { groupId: 'addons', optionIds: ['cheese', 'cheese', 'unknown'] },
          { groupId: 'addons', optionIds: [] },
          { groupId: 'toppings', optionIds: [] },
        ],
      }).map((issue) => issue.code),
    ).toEqual([
      'UNKNOWN_VARIANT',
      'DUPLICATE_MODIFIER_GROUP',
      'UNKNOWN_MODIFIER_GROUP',
      'TOO_MANY_MODIFIERS',
      'DUPLICATE_MODIFIER_OPTION',
      'UNKNOWN_MODIFIER_OPTION',
    ]);
    expect(validateSelection(naan, { variantId: 'half' }).map((issue) => issue.code)).toEqual([
      'VARIANT_NOT_APPLICABLE',
    ]);
    expect(
      validateSelection(
        {
          id: 'x',
          basePrice: 100,
          modifierGroups: [
            {
              id: 'g',
              name: 'G',
              minSelections: 0,
              maxSelections: 1,
              options: [{ id: 'o', name: 'O', priceDelta: -200 }],
            },
          ],
        },
        { modifiers: [{ groupId: 'g', optionIds: ['o'] }] },
      ).map((issue) => issue.code),
    ).toEqual(['NEGATIVE_PRICE']);
  });

  it('throws INVALID_SELECTION when pricing an invalid selection', () => {
    expect(() => unitPriceOf(paneerTikka, { variantId: 'full' })).toThrow(/Spice level/);
  });
});

describe('[ORD-007] KOT split per station with combo explosion', () => {
  it('splits by station in order of appearance and explodes combos', () => {
    const kots = splitIntoKots([
      {
        orderItemId: 'o1',
        itemId: 'paneer-tikka',
        name: 'Paneer Tikka',
        quantity: 1,
        stationId: 'tandoor',
        variantName: 'Half',
        modifiers: ['Hot'],
      },
      {
        orderItemId: 'o2',
        itemId: 'noodles',
        name: 'Hakka Noodles',
        quantity: 2,
        stationId: 'chinese',
        instructions: 'less oil',
      },
      {
        orderItemId: 'o3',
        itemId: 'thali-combo',
        name: 'Lunch Combo',
        quantity: 2,
        instructions: 'pack separately',
        comboComponents: [
          { itemId: 'naan', name: 'Butter Naan', quantity: 2, stationId: 'tandoor' },
          {
            itemId: 'lassi',
            name: 'Sweet Lassi',
            quantity: 1,
            stationId: 'bar',
            variantName: 'Large',
          },
        ],
      },
    ]);
    expect(kots.map((kot) => kot.stationId)).toEqual(['tandoor', 'chinese', 'bar']);
    expect(kots[0]?.lines).toEqual([
      {
        orderItemId: 'o1',
        itemId: 'paneer-tikka',
        name: 'Paneer Tikka',
        quantity: 1,
        variantName: 'Half',
        modifiers: ['Hot'],
      },
      {
        orderItemId: 'o3',
        itemId: 'naan',
        name: 'Butter Naan',
        quantity: 4,
        modifiers: [],
        instructions: 'pack separately',
        comboName: 'Lunch Combo',
      },
    ]);
    expect(kots[1]?.lines[0]).toMatchObject({ quantity: 2, instructions: 'less oil' });
    expect(kots[2]?.lines[0]).toMatchObject({
      name: 'Sweet Lassi',
      quantity: 2,
      variantName: 'Large',
      comboName: 'Lunch Combo',
    });
  });

  it('rejects items without a station and bad quantities', () => {
    expect(() =>
      splitIntoKots([{ orderItemId: 'o', itemId: 'i', name: 'Tea', quantity: 1 }]),
    ).toThrow(/station/);
    expect(() =>
      splitIntoKots([
        { orderItemId: 'o', itemId: 'i', name: 'Tea', quantity: 0, stationId: 'bar' },
      ]),
    ).toThrow();
    expect(() =>
      splitIntoKots([
        {
          orderItemId: 'o',
          itemId: 'c',
          name: 'Combo',
          quantity: 1,
          comboComponents: [{ itemId: 'x', name: 'X', quantity: 0, stationId: 'bar' }],
        },
      ]),
    ).toThrow();
    expect(splitIntoKots([])).toEqual([]);
  });
});
