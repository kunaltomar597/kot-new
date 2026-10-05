import { PHOTO_MAX_BYTES } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import {
  availabilityFormOf,
  availabilityRequestOf,
  categoryChoices,
  categoryFormOf,
  categoryRequestOf,
  categoryTree,
  checkCategory,
  checkCombo,
  checkGroup,
  checkItem,
  comboChanged,
  comboFormOf,
  comboItemChoices,
  comboPartIds,
  comboRequestOf,
  emptyCategoryForm,
  emptyComboPart,
  emptyGroupForm,
  emptyItemForm,
  emptyOption,
  emptySize,
  groupChoices,
  groupFormOf,
  groupRequestOf,
  hasSubcategories,
  type ItemForm,
  itemChanged,
  itemFormOf,
  itemGroups,
  itemRequestOf,
  itemsIn,
  listOf,
  matchesQuery,
  missingChannels,
  parentChoices,
  photoBase64,
  priceRange,
  pricePaise,
  pricesChange,
  signedInputFromPaise,
} from '../src/manage/menu/menu-view.js';
import { category, IDS, item, menuDraft, rotiType, THALI_COMBO } from './menu-fixture.js';

const draft = menuDraft();
const find = (id: string) => {
  const found = draft.items.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No item ${id}`);
  return found;
};
const names = (entries: readonly { name: string }[]) => entries.map((entry) => entry.name);

/** A complete new-item form, as a manager would fill it in. */
const filled = (overrides: Partial<ItemForm> = {}): ItemForm => ({
  ...emptyItemForm({ categoryId: IDS.mains, taxGroupId: IDS.gst5, stationId: IDS.kitchen }),
  name: '  Shahi Paneer ',
  basePrice: '₹2,50.50',
  foodType: 'VEG',
  ...overrides,
});

describe('[MENU-001] categories', () => {
  it('orders top-level categories with their sub-categories, archived ones only on request', () => {
    expect(
      categoryTree(draft.categories, { archived: false }).map((node) => [
        node.category.name,
        names(node.children),
      ]),
    ).toEqual([
      ['Starters', ['Veg starters']],
      ['Mains', []],
      ['Drinks', []],
    ]);
    expect(
      names(categoryTree(draft.categories, { archived: true }).map((n) => n.category)),
    ).toEqual(['Starters', 'Mains', 'Drinks', 'Festive']);
  });

  it('stands a sub-category at the top level when its parent is not shown', () => {
    const categories = [
      category('festive', 'Festive', { archivedAt: '2026-09-28T10:00:00.000Z' }),
      category('drinks', 'Diwali drinks', { parentId: IDS.festive }),
    ];
    expect(names(categoryTree(categories, { archived: false }).map((n) => n.category))).toEqual([
      'Diwali drinks',
    ]);
  });

  it('offers every active category for an item, each sub-category after its parent', () => {
    expect(
      categoryChoices(draft.categories).map(({ category: entry, parent }) => [
        entry.name,
        parent?.name ?? null,
      ]),
    ).toEqual([
      ['Starters', null],
      ['Veg starters', 'Starters'],
      ['Mains', null],
      ['Drinks', null],
    ]);
  });

  it('puts a category under an active top-level one, never under itself or with its own', () => {
    expect(names(parentChoices(draft.categories, undefined))).toEqual([
      'Starters',
      'Mains',
      'Drinks',
    ]);
    expect(names(parentChoices(draft.categories, IDS.mains))).toEqual(['Starters', 'Drinks']);
    // Starters has a sub-category of its own, so it stays at the top level.
    expect(hasSubcategories(draft.categories, IDS.starters)).toBe(true);
    expect(parentChoices(draft.categories, IDS.starters)).toEqual([]);
  });

  it('counts the active items in a category', () => {
    expect(itemsIn(draft.items, IDS.vegStarters)).toBe(2);
    // The soup is archived.
    expect(itemsIn(draft.items, IDS.starters)).toBe(0);
  });

  it('checks a category and places a new one after its neighbours unless told', () => {
    expect(checkCategory(emptyCategoryForm())).toEqual({ name: 'nameProblem' });
    expect(checkCategory({ name: 'x'.repeat(61), parentId: '', displayOrder: '10000' })).toEqual({
      name: 'nameProblem',
      displayOrder: 'displayOrderProblem',
    });
    expect(
      categoryRequestOf(
        { name: ' Desserts ', parentId: '', displayOrder: '' },
        draft.categories,
        undefined,
      ),
    ).toEqual({ name: 'Desserts', parentId: null, displayOrder: 4 });
    expect(
      categoryRequestOf(
        { name: 'Tandoor', parentId: IDS.starters, displayOrder: '' },
        draft.categories,
        undefined,
      ),
    ).toEqual({ name: 'Tandoor', parentId: IDS.starters, displayOrder: 2 });
    expect(
      categoryRequestOf(categoryFormOf(draft.categories[2]!), draft.categories, IDS.mains),
    ).toEqual({ name: 'Mains', parentId: null, displayOrder: 2 });
  });
});

describe('[MGR-005] the item list', () => {
  it('[MENU-011] finds items by name, short code, tag or search word', () => {
    const tikka = find(IDS.paneerTikka);
    for (const query of ['tikka', 'PT', 'bestseller', 'PANIR', '  ']) {
      expect(matchesQuery(tikka, query), query).toBe(true);
    }
    expect(matchesQuery(tikka, 'lassi')).toBe(false);
  });

  it('groups items by category in menu order, empty categories too until a search', () => {
    const groups = itemGroups(draft, { query: '', archived: false });
    expect(
      groups.map((group) => [group.category.name, group.parent?.name ?? null, names(group.items)]),
    ).toEqual([
      ['Starters', null, []],
      ['Veg starters', 'Starters', ['Paneer Tikka', 'Hariyali Kebab']],
      ['Mains', null, ['Dal Makhani', 'Veg Thali']],
      ['Drinks', null, ['Lassi', 'Masala Chaas']],
    ]);
    expect(
      itemGroups(draft, { query: 'chaas', archived: false }).map((group) => names(group.items)),
    ).toEqual([['Masala Chaas']]);
    expect(itemGroups(draft, { query: 'pizza', archived: false })).toEqual([]);
    // Archived items and categories on request.
    const all = itemGroups(draft, { query: '', archived: true });
    expect(names(all[0]?.items ?? [])).toEqual(['Tomato Soup']);
    expect(all.at(-1)?.category.name).toBe('Festive');
  });

  it('[MENU-003] shows the range of the sizes’ prices, or the item’s own price', () => {
    expect(priceRange(find(IDS.paneerTikka))).toEqual({ low: 18_000, high: 32_000 });
    expect(priceRange(find(IDS.dalMakhani))).toEqual({ low: 28_000, high: 28_000 });
  });

  it('[MENU-002] names the channels an item is not sold on', () => {
    expect(missingChannels(find(IDS.chaas))).toEqual(['QR']);
    expect(missingChannels(find(IDS.lassi))).toEqual([]);
  });

  it('[MENU-005] knows which items are part of a combo, fixed or offered in a choice', () => {
    expect([...comboPartIds(draft.combos)].sort()).toEqual(
      [IDS.dalMakhani, IDS.lassi, IDS.chaas].sort(),
    );
  });
});

describe('[MENU-006] availability and stock', () => {
  it('starts from the item and sends a count only while counting', () => {
    const kebab = find(IDS.hariyaliKebab);
    expect(availabilityFormOf(kebab)).toEqual({ available: true, counting: true, left: '6' });
    expect(availabilityRequestOf({ available: true, counting: true, left: ' 12 ' })).toEqual({
      available: true,
      stockCount: 12,
    });
    expect(availabilityRequestOf({ available: false, counting: false, left: 'x' })).toEqual({
      available: false,
      stockCount: null,
    });
  });

  it('refuses a count that is not a whole number from 0 to 100000', () => {
    for (const left of ['', '-1', '2.5', '100001', 'six']) {
      expect(
        availabilityRequestOf({ available: true, counting: true, left }),
        left,
      ).toBeUndefined();
    }
    expect(availabilityRequestOf({ available: true, counting: true, left: '0' })).toEqual({
      available: true,
      stockCount: 0,
    });
  });
});

describe('[MENU-002] [MENU-003] the item form', () => {
  it('asks for everything an item needs, veg or not included, without guessing', () => {
    expect(checkItem(emptyItemForm({}))).toEqual({
      name: 'nameProblem',
      categoryId: 'categoryProblem',
      basePrice: 'priceProblem',
      taxGroupId: 'taxGroupProblem',
      foodType: 'foodTypeProblem',
      stationId: 'stationProblem',
    });
    expect(checkItem(filled())).toEqual({});
  });

  it('checks the short code, sizes, timings, tags, search words and reason like the server', () => {
    const half = { ...emptySize(), name: 'Half', price: '150' };
    const again = { ...emptySize(), name: 'half', price: '1.234' };
    expect(
      checkItem(
        filled({
          shortCode: 'P 12',
          description: 'x'.repeat(501),
          sizes: [half, again],
          prepTime: '241',
          channels: [],
          tags: 'Jain, jain',
          synonyms: Array.from({ length: 21 }, (_, n) => `word${String(n)}`).join(','),
          displayOrder: '-1',
          externalId: 'x'.repeat(129),
          reason: 'no',
        }),
      ),
    ).toEqual({
      shortCode: 'shortCodeProblem',
      description: 'descriptionProblem',
      [`size:${half.key}:name`]: 'sizeNameProblem',
      [`size:${again.key}:name`]: 'sizeNameProblem',
      [`size:${again.key}:price`]: 'priceProblem',
      prepTime: 'prepTimeProblem',
      channels: 'channelsProblem',
      tags: 'tagsProblem',
      synonyms: 'synonymsProblem',
      displayOrder: 'displayOrderProblem',
      externalId: 'externalIdProblem',
      reason: 'reasonProblem',
    });
  });

  it('builds the request: trimmed, in paise, empty fields null, new items last in their category', () => {
    const size = { ...emptySize(), name: ' Large ', price: '300' };
    expect(
      itemRequestOf(
        filled({
          shortCode: ' SP1 ',
          tags: ' Jain ,, Chef’s special ',
          synonyms: 'paneer butter',
          sizes: [size],
          modifierGroupIds: [IDS.roti],
          prepTime: '12',
        }),
        draft.items,
      ),
    ).toEqual({
      categoryId: IDS.mains,
      name: 'Shahi Paneer',
      shortCode: 'SP1',
      description: null,
      photoId: null,
      basePrice: 25_050,
      taxGroupId: IDS.gst5,
      foodType: 'VEG',
      spiceLevel: 0,
      tags: ['Jain', 'Chef’s special'],
      stationId: IDS.kitchen,
      prepTimeMinutes: 12,
      // After Veg Thali (1), the last of Mains.
      displayOrder: 2,
      channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
      variants: [{ name: 'Large', price: 30_000, externalId: null }],
      modifierGroupIds: [IDS.roti],
      synonyms: ['paneer butter'],
      repeatable: false,
      externalId: null,
    });
  });

  it('keeps every attribute of an item it does not change, sizes’ ids and external IDs too', () => {
    const tikka = find(IDS.paneerTikka);
    const request = itemRequestOf(itemFormOf(tikka), draft.items);
    expect(request).toMatchObject({
      categoryId: IDS.vegStarters,
      shortCode: 'PT',
      basePrice: 22_000,
      spiceLevel: 2,
      tags: ['Bestseller'],
      synonyms: ['panir'],
      displayOrder: 0,
      modifierGroupIds: [IDS.addOns],
      variants: [
        { id: IDS.half, name: 'Half', price: 18_000, externalId: 'POS-PT-H' },
        { id: IDS.full, name: 'Full', price: 32_000, externalId: null },
      ],
    });
    expect(request).not.toHaveProperty('reason');
    expect(itemChanged(tikka, request)).toBe(false);
    expect(itemChanged(tikka, { ...request, reason: 'Nothing really' })).toBe(false);
    expect(itemChanged(tikka, { ...request, name: 'Paneer Tikka Masala' })).toBe(true);
  });

  it('[MENU-009] notices a price change, of the item or of a size, and sends its reason', () => {
    const tikka = find(IDS.paneerTikka);
    const form = itemFormOf(tikka);
    expect(pricesChange(tikka, form)).toBe(false);
    expect(pricesChange(tikka, { ...form, basePrice: '230' })).toBe(true);
    const [half, full] = form.sizes;
    expect(pricesChange(tikka, { ...form, sizes: [{ ...half!, price: '190.00' }, full!] })).toBe(
      true,
    );
    // A new size is not a change of price.
    expect(pricesChange(tikka, { ...form, sizes: [...form.sizes, emptySize()] })).toBe(false);
    expect(
      itemRequestOf({ ...form, basePrice: '230', reason: ' Supplier raised paneer prices ' }, []),
    ).toMatchObject({ basePrice: 23_000, reason: 'Supplier raised paneer prices' });
  });

  it('reads rupees as paise, zero allowed, a minus only where asked, up to ₹1,00,000', () => {
    expect(pricePaise('0')).toBe(0);
    expect(pricePaise('1,00,000')).toBe(10_000_000);
    expect(pricePaise('100000.01')).toBeUndefined();
    expect(pricePaise('-10')).toBeUndefined();
    expect(pricePaise('-10', { negative: true })).toBe(-1_000);
    expect(pricePaise('')).toBeUndefined();
    expect(signedInputFromPaise(0)).toBe('0');
    expect(signedInputFromPaise(-1_050)).toBe('-10.50');
    expect(signedInputFromPaise(2_000)).toBe('20.00');
    expect(listOf(' a, ,b ,')).toEqual(['a', 'b']);
  });
});

describe('[MENU-008] photos', () => {
  it('reads a photo as base64, and refuses one above 5 MB without reading it', async () => {
    const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
    expect(await photoBase64(photo)).toEqual({ ok: true, base64: '/9j/4A==' });
    expect(await photoBase64(new Blob([new Uint8Array(PHOTO_MAX_BYTES + 1)]))).toEqual({
      ok: false,
    });
  });
});

describe('[MENU-005] combos', () => {
  it('reads a combo into the form and back into the same request', () => {
    const form = comboFormOf(THALI_COMBO);
    expect(form).toMatchObject({ enabled: true, start: '11:00', end: '16:00', activeFrom: '' });
    expect(comboRequestOf(form)).toEqual({
      components: [
        { kind: 'FIXED', itemId: IDS.dalMakhani, quantity: 1 },
        { kind: 'CHOICE', label: 'Any 1 drink', itemIds: [IDS.lassi, IDS.chaas], quantity: 1 },
      ],
      activeFrom: null,
      activeUntil: null,
      timeWindow: { start: '11:00', end: '16:00' },
    });
    expect(comboChanged(form, THALI_COMBO)).toBe(false);
    expect(comboChanged({ ...form, end: '17:00' }, THALI_COMBO)).toBe(true);
    expect(comboChanged(comboFormOf(undefined), undefined)).toBe(false);
  });

  it('checks every part, the dates and the time window', () => {
    expect(checkCombo(comboFormOf(undefined))).toEqual({});
    const fixed = emptyComboPart();
    const choice = {
      ...emptyComboPart(),
      kind: 'CHOICE' as const,
      itemIds: [IDS.lassi],
      quantity: '0',
    };
    expect(
      checkCombo({
        enabled: true,
        parts: [fixed, choice],
        activeFrom: '2026-11-01',
        activeUntil: '2026-10-01',
        start: '11:00',
        end: '',
      }),
    ).toEqual({
      [`part:${fixed.key}:item`]: 'itemProblem',
      [`part:${choice.key}:label`]: 'labelProblem',
      [`part:${choice.key}:choices`]: 'choicesProblem',
      [`part:${choice.key}:quantity`]: 'quantityProblem',
      dates: 'datesProblem',
      window: 'windowProblem',
    });
    expect(
      checkCombo({ enabled: true, parts: [], activeFrom: '', activeUntil: '', start: '', end: '' }),
    ).toEqual({ parts: 'partsProblem' });
  });

  it('bundles only active items that are not combos themselves, never the combo item', () => {
    expect(names(comboItemChoices(draft, IDS.lassi))).toEqual([
      'Paneer Tikka',
      'Hariyali Kebab',
      'Dal Makhani',
      'Masala Chaas',
    ]);
  });
});

describe('[MENU-004] modifier groups', () => {
  it('starts a new group optional with one option, and checks the counts and options', () => {
    const form = emptyGroupForm();
    expect(form).toMatchObject({ name: '', min: '0', max: '1' });
    expect(checkGroup(form)).toEqual({
      name: 'nameProblem',
      [`option:${form.options[0]!.key}:name`]: 'optionNameProblem',
    });
    const plain = { ...emptyOption(), name: 'Plain' };
    const again = { ...emptyOption(), name: 'plain', priceDelta: '1.234' };
    expect(checkGroup({ name: 'Roti', min: '3', max: '2', options: [plain, again] })).toEqual({
      count: 'countProblem',
      [`option:${plain.key}:name`]: 'optionNameProblem',
      [`option:${again.key}:name`]: 'optionNameProblem',
      [`option:${again.key}:price`]: 'optionPriceProblem',
    });
    expect(checkGroup({ name: 'Roti', min: '0', max: '1', options: [] })).toEqual({
      options: 'optionsProblem',
    });
  });

  it('keeps the ids of kept options and reads price changes either way', () => {
    const form = groupFormOf(rotiType());
    expect(form.options.map((option) => option.priceDelta)).toEqual(['0', '10.00', '20.00']);
    const request = groupRequestOf({
      ...form,
      options: [
        ...form.options.slice(0, 2),
        { ...emptyOption(), name: 'Missi', priceDelta: '-5', available: false },
        { ...emptyOption(), name: 'Rumali', priceDelta: '' },
      ],
    });
    expect(request).toEqual({
      name: 'Roti type',
      minSelections: 1,
      maxSelections: 1,
      options: [
        { id: IDS.plain, name: 'Plain', priceDelta: 0, available: true },
        { id: IDS.butter, name: 'Butter', priceDelta: 1_000, available: true },
        { name: 'Missi', priceDelta: -500, available: false },
        { name: 'Rumali', priceDelta: 0, available: true },
      ],
    });
  });

  it('offers active groups, and an archived one only while an item still names it', () => {
    expect(names(groupChoices(draft.modifierGroups, []))).toEqual(['Roti type', 'Add-ons']);
    expect(names(groupChoices(draft.modifierGroups, [IDS.oldGroup]))).toEqual([
      'Roti type',
      'Add-ons',
      'Old sauces',
    ]);
  });
});

describe('a new item', () => {
  it('starts on every channel, not spicy, with the choices it was given', () => {
    expect(emptyItemForm({ categoryId: IDS.drinks })).toMatchObject({
      categoryId: IDS.drinks,
      taxGroupId: '',
      foodType: '',
      spiceLevel: 0,
      channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
      repeatable: false,
    });
    expect(itemFormOf(item('lassi', 'Lassi', { prepTimeMinutes: 5 }))).toMatchObject({
      prepTime: '5',
      basePrice: '250.00',
    });
  });
});
