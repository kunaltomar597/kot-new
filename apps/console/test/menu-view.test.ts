import { describe, expect, it } from 'vitest';
import {
  categoryPath,
  categoryRequestOf,
  categoryRows,
  changesPrice,
  checkCategory,
  checkCombo,
  checkGroup,
  checkItem,
  comboCandidates,
  comboFormOf,
  comboRequestOf,
  filterItems,
  groupFormOf,
  groupRequestOf,
  groupRule,
  itemFormOf,
  itemRequestOf,
  newComboPart,
  nextOrder,
  paiseOf,
  parentChoices,
  priceLabel,
  rupeesText,
  splitList,
} from '../src/manage/menu/menu-view.js';
import {
  BREADS,
  category,
  CURRIES,
  draftMenu,
  GST5,
  group,
  KITCHEN,
  MAINS,
  NAAN,
  OLD_CATEGORY,
  OLD_DISH,
  PANEER,
  THALI,
} from './menu-fixture.js';

const defaults = { categoryId: '', taxGroupId: GST5, stationId: KITCHEN, displayOrder: 30 };

describe('[MENU-001] categories', () => {
  it('lists sub-categories under their parent, archived ones only when asked', () => {
    const names = (archived: boolean) =>
      categoryRows(draftMenu().categories, { archived }).map(
        (row) => `${'-'.repeat(row.depth)}${row.category.name}`,
      );
    expect(names(false)).toEqual(['Mains', '-Curries', 'Breads']);
    expect(names(true)).toEqual(['Mains', '-Curries', 'Breads', 'Monsoon specials']);
    expect(categoryPath(draftMenu().categories, CURRIES)).toBe('Mains › Curries');
    expect(categoryPath(draftMenu().categories, BREADS)).toBe('Breads');
  });

  it('allows only one level: a parent is an active top-level category', () => {
    const categories = draftMenu().categories;
    expect(parentChoices(categories).map((choice) => choice.label)).toEqual(['Mains', 'Breads']);
    // Mains has a sub-category, so it cannot go inside another one.
    expect(parentChoices(categories, categories[0])).toEqual([]);
    expect(
      parentChoices(categories, category({ id: OLD_CATEGORY })).map((choice) => choice.value),
    ).toEqual([MAINS, BREADS]);
  });

  it('checks the name and order and builds the request', () => {
    expect(checkCategory({ name: ' ', parentId: '', displayOrder: 'x' })).toEqual({
      name: 'nameRequired',
      displayOrder: 'orderInvalid',
    });
    expect(categoryRequestOf({ name: ' Rolls ', parentId: MAINS, displayOrder: '40' })).toEqual({
      name: 'Rolls',
      parentId: MAINS,
      displayOrder: 40,
    });
    expect(nextOrder([10, 20, 30])).toBe(40);
    expect(nextOrder([])).toBe(0);
  });
});

describe('[MENU-002] [MENU-003] [MENU-009] dishes', () => {
  it('reads rupees as paise and back, refusing what is not an amount', () => {
    expect(paiseOf('120.50')).toBe(12050);
    expect(paiseOf('₹1,250')).toBe(125000);
    expect(paiseOf('12.345')).toBeUndefined();
    expect(paiseOf('-10')).toBeUndefined();
    expect(paiseOf('-10', true)).toBe(-1000);
    expect(rupeesText(125050)).toBe('1250.50');
    expect(splitList(' Jain, jain ,, bestseller ')).toEqual(['Jain', 'bestseller']);
  });

  it('turns a saved dish into a form and back without losing anything', () => {
    const paneer = draftMenu().items[0]!;
    const form = itemFormOf(paneer, defaults);
    expect(form.basePrice).toBe('280.00');
    expect(form.variants.map((variant) => [variant.name, variant.price])).toEqual([
      ['Half', '180.00'],
      ['Full', '280.00'],
    ]);
    expect(checkItem(form)).toEqual({});
    expect(itemRequestOf(form)).toMatchObject({
      name: 'Paneer Tikka Masala',
      basePrice: 28000,
      tags: ['bestseller'],
      synonyms: ['panir'],
      variants: [
        { id: paneer.variants[0]?.id, name: 'Half', price: 18000 },
        { id: paneer.variants[1]?.id, name: 'Full', price: 28000 },
      ],
    });
    expect(itemRequestOf(form)).not.toHaveProperty('reason');
  });

  it('checks every field like the server', () => {
    const blank = itemFormOf(undefined, { ...defaults, taxGroupId: '', stationId: '' });
    expect(checkItem({ ...blank, channels: [] })).toEqual({
      name: 'nameRequired',
      categoryId: 'categoryRequired',
      basePrice: 'priceInvalid',
      taxGroupId: 'taxGroupRequired',
      stationId: 'stationRequired',
      channels: 'channelsRequired',
    });
    const filled = {
      ...blank,
      name: 'Dal',
      categoryId: MAINS,
      basePrice: '150',
      taxGroupId: GST5,
      stationId: KITCHEN,
    };
    expect(checkItem(filled)).toEqual({});
    expect(checkItem({ ...filled, shortCode: 'TOO LONG CODE' }).shortCode).toBe('shortCodeInvalid');
    expect(checkItem({ ...filled, prepTime: '300' }).prepTime).toBe('prepTimeInvalid');
    expect(
      checkItem({
        ...filled,
        variants: [
          { key: 'a', name: 'Half', price: '80' },
          { key: 'b', name: 'half', price: '150' },
        ],
      }).variants,
    ).toBe('variantNamesRepeat');
    expect(
      checkItem({ ...filled, variants: [{ key: 'a', name: 'Half', price: 'eighty' }] }).variants,
    ).toBe('variantInvalid');
  });

  it('[MENU-009] notices a price change, which may carry a reason', () => {
    const naan = draftMenu().items[1]!;
    const form = itemFormOf(naan, defaults);
    expect(changesPrice(naan, form)).toBe(false);
    expect(changesPrice(naan, { ...form, name: 'Naan' })).toBe(false);
    expect(changesPrice(naan, { ...form, basePrice: '65' })).toBe(true);
    expect(changesPrice(undefined, form)).toBe(false);
    expect(itemRequestOf({ ...form, basePrice: '65', reason: 'New flour price' }).reason).toBe(
      'New flour price',
    );
  });

  it('shows the cheapest size as "from" and filters the list', () => {
    const draft = draftMenu();
    expect(priceLabel(draft.items[0]!)).toEqual({ from: true, paise: 18000 });
    expect(priceLabel(draft.items[1]!)).toEqual({ from: false, paise: 6000 });
    const ids = (filter: Parameters<typeof filterItems>[1]) =>
      filterItems(draft, filter).map((entry) => entry.id);
    expect(ids({ categoryId: '', search: '', archived: false })).toEqual([THALI, PANEER, NAAN]);
    // A top-level category shows its sub-categories' dishes too.
    expect(ids({ categoryId: MAINS, search: '', archived: false })).toEqual([THALI, PANEER]);
    expect(ids({ categoryId: '', search: 'panir', archived: false })).toEqual([PANEER]);
    expect(ids({ categoryId: '', search: 'bn', archived: false })).toEqual([NAAN]);
    expect(ids({ categoryId: '', search: '', archived: true })).toEqual([OLD_DISH]);
  });
});

describe('[MENU-004] option groups', () => {
  it('checks the rule against its options and builds the request', () => {
    const form = groupFormOf(group());
    expect(checkGroup(form)).toEqual({});
    expect(groupRequestOf(form).options[1]).toMatchObject({ name: 'Butter', priceDelta: 1000 });
    expect(checkGroup({ ...form, minSelections: '2', maxSelections: '1' }).minSelections).toBe(
      'minAboveMax',
    );
    expect(checkGroup({ ...form, minSelections: '3', maxSelections: '3' }).minSelections).toBe(
      'minAboveOptions',
    );
    expect(checkGroup({ ...form, maxSelections: '0' }).maxSelections).toBe('countInvalid');
    expect(
      checkGroup({
        ...form,
        options: [...form.options, { key: 'x', name: 'plain', priceDelta: '0', available: true }],
      }).options,
    ).toBe('optionNamesRepeat');
    expect(
      groupRequestOf({
        ...form,
        options: [{ key: 'x', name: 'No onion', priceDelta: '-5', available: true }],
      }).options[0]?.priceDelta,
    ).toBe(-500);
    expect(checkGroup(groupFormOf())).toEqual({ name: 'nameRequired', options: 'optionInvalid' });
  });

  it('says the rule in the way the POS does', () => {
    expect(groupRule({ minSelections: 1, maxSelections: 1 })).toEqual({
      kind: 'EXACTLY',
      count: 1,
    });
    expect(groupRule({ minSelections: 0, maxSelections: 3 })).toEqual({ kind: 'UP_TO', count: 3 });
    expect(groupRule({ minSelections: 1, maxSelections: 2 })).toEqual({
      kind: 'BETWEEN',
      min: 1,
      max: 2,
    });
  });
});

describe('[MENU-005] combos', () => {
  it('offers active dishes that are not combos, and not the combo itself', () => {
    expect(comboCandidates(draftMenu()).map((entry) => entry.id)).toEqual([NAAN, PANEER]);
    expect(comboCandidates(draftMenu(), PANEER).map((entry) => entry.id)).toEqual([NAAN]);
  });

  it('reads a saved combo and checks parts, dates and hours', () => {
    const saved = draftMenu().combos[0]!;
    const form = comboFormOf(saved);
    expect(checkCombo(form)).toEqual({});
    expect(comboRequestOf(form)).toEqual({
      components: [
        { kind: 'FIXED', itemId: PANEER, quantity: 1 },
        { kind: 'FIXED', itemId: NAAN, quantity: 2 },
      ],
      activeFrom: null,
      activeUntil: null,
      timeWindow: null,
    });
    const choice = { ...newComboPart('CHOICE'), label: 'Any 1 bread', itemIds: [NAAN] };
    expect(checkCombo({ ...form, parts: [choice] }).parts).toBe('partInvalid');
    expect(checkCombo({ ...form, parts: [{ ...choice, itemIds: [NAAN, PANEER] }] })).toEqual({});
    expect(checkCombo({ ...form, activeFrom: '2026-10-31', activeUntil: '2026-10-01' }).dates).toBe(
      'datesBackwards',
    );
    expect(checkCombo({ ...form, windowStart: '11:00' }).window).toBe('windowIncomplete');
    expect(
      comboRequestOf({ ...form, windowStart: '22:00', windowEnd: '02:00' }).timeWindow,
    ).toEqual({ start: '22:00', end: '02:00' });
  });
});
