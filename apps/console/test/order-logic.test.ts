import { describe, expect, it } from 'vitest';
import {
  addLine,
  type CartLine,
  cartTotal,
  markRejected,
  removeLine,
  requestLines,
  updateLine,
} from '../src/pos/cart.js';
import {
  comboOf,
  comboSlots,
  displayPrice,
  needsOptions,
  posCategories,
  posItems,
  selectable,
  visibleItems,
} from '../src/pos/menu-view.js';
import { IDS, MENU } from './menu-fixture.js';

let next = 0;
const newId = () => `line-${String(++next)}`;
const dal = {
  itemId: IDS.dal,
  name: 'Dal Makhani',
  summary: '',
  quantity: 1,
  selection: {},
  instructions: '',
  unitPrice: 24_000,
};

describe('[ORD-001] [ORD-014] the cart', () => {
  it('merges identical lines and keeps different choices apart', () => {
    let lines: CartLine[] = addLine([], dal, newId);
    lines = addLine(lines, { ...dal, quantity: 2 }, newId);
    lines = addLine(lines, { ...dal, instructions: 'less oil' }, newId);
    expect(lines.map((line) => [line.quantity, line.instructions])).toEqual([
      [3, ''],
      [1, 'less oil'],
    ]);
    expect(addLine(lines, { ...dal, quantity: 99 }, newId)[0]?.quantity).toBe(99);
    expect(cartTotal(lines)).toBe(96_000);
  });

  it('changes, removes and marks lines the server refused', () => {
    const [first] = addLine([], dal, newId);
    if (first === undefined) throw new Error('no line');
    const rejected = markRejected([first], [{ clientLineId: first.clientLineId, message: 'Out' }]);
    expect(rejected[0]?.error).toBe('Out');
    const changed = updateLine(rejected, first.clientLineId, { quantity: 2 });
    expect(changed[0]).toMatchObject({ quantity: 2, error: undefined });
    expect(removeLine(changed, first.clientLineId)).toEqual([]);
  });

  it('sends choices and notes but never a price (ORD-014)', () => {
    const [line] = addLine(
      [],
      {
        ...dal,
        itemId: IDS.thali,
        selection: {
          variantId: IDS.full,
          modifiers: [{ groupId: IDS.extras, optionIds: [IDS.cheese] }],
        },
        comboChoices: [IDS.jamun],
        instructions: '  no onion  ',
      },
      newId,
    );
    const [request] = requestLines(line === undefined ? [] : [line]);
    expect(request).toEqual({
      clientLineId: line?.clientLineId,
      itemId: IDS.thali,
      quantity: 1,
      variantId: IDS.full,
      modifiers: [{ groupId: IDS.extras, optionIds: [IDS.cheese] }],
      comboChoices: [IDS.jamun],
      instructions: 'no onion',
    });
    expect(JSON.stringify(request)).not.toMatch(/price/i);
  });
});

describe('[MENU-012] the POS menu', () => {
  it('shows POS items in category order and searches names, codes and synonyms', () => {
    const items = posItems(MENU);
    expect(items.map((item) => item.name)).toEqual([
      'Paneer Tikka',
      'Dal Makhani',
      'Veg Thali Combo',
      'Gulab Jamun',
    ]);
    expect(posCategories(MENU, items).map((category) => category.name)).toEqual([
      'Starters',
      'Main Course',
    ]);
    expect(visibleItems(items, '', IDS.starters).map((item) => item.name)).toEqual([
      'Paneer Tikka',
    ]);
    expect(visibleItems(items, '', undefined)).toHaveLength(4);
    expect(visibleItems(items, ' TIKKA ', IDS.mains).map((item) => item.name)).toEqual([
      'Paneer Tikka',
    ]);
    expect(visibleItems(items, 'dm', undefined).map((item) => item.name)).toEqual(['Dal Makhani']);
    expect(visibleItems(items, 'veg combo', undefined).map((item) => item.name)).toEqual([
      'Veg Thali Combo',
    ]);
  });

  it('knows which items need choices, their groups, combo slots and card price', () => {
    const [tikka, dal, thali] = posItems(MENU);
    if (tikka === undefined || dal === undefined || thali === undefined) throw new Error('menu');
    expect(needsOptions(MENU, tikka)).toBe(true);
    expect(needsOptions(MENU, dal)).toBe(false);
    expect(needsOptions(MENU, thali)).toBe(true);
    expect(selectable(MENU, tikka).modifierGroups.map((group) => group.name)).toEqual(['Extras']);
    const combo = comboOf(MENU, thali);
    expect(combo === undefined ? [] : comboSlots(MENU, combo)).toEqual([
      {
        label: 'Dessert',
        options: [
          { id: IDS.jamun, name: 'Gulab Jamun' },
          { id: IDS.rasmalai, name: 'Rasmalai' },
        ],
      },
    ]);
    expect(displayPrice(tikka)).toBe(18_000);
    expect(displayPrice(dal)).toBe(24_000);
  });
});
