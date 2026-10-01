import type { MenuItem } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import {
  addLine,
  estimateCart,
  filterMenu,
  queryWords,
  searchMenu,
  sortMenu,
} from '../src/index.js';
import { IDS, MENU } from '../src/testing/index.js';

const ID = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function dish(n: number, name: string, overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: ID(n),
    categoryId: IDS.mains,
    name,
    basePrice: 20_000,
    taxGroupId: IDS.tax,
    foodType: 'VEG',
    spiceLevel: 0,
    tags: [],
    stationId: IDS.kitchen,
    available: true,
    stockCount: null,
    displayOrder: n,
    channels: ['TABLE_TABLET'],
    variants: [],
    modifierGroupIds: [],
    synonyms: [],
    repeatable: true,
    archived: false,
    ...overrides,
  };
}

const MENU_ITEMS = [
  dish(1, 'Paneer Tikka', { tags: ['Starter'], spiceLevel: 2, basePrice: 28_000 }),
  dish(2, 'Kadai Paneer', { tags: ['Spicy'], basePrice: 32_000 }),
  dish(3, 'Dal Makhani', { synonyms: ['dal makhni'], basePrice: 24_000 }),
  dish(4, 'Chicken Biryani', { foodType: 'NON_VEG', spiceLevel: 3, basePrice: 36_000 }),
  dish(5, 'Jain Thali', { tags: ['Jain'], basePrice: 30_000 }),
  dish(6, 'Masala Omelette', { foodType: 'EGG', basePrice: 15_000, synonyms: ['anda'] }),
];

const names = (items: readonly MenuItem[]) => items.map((item) => item.name);

describe('[TAB-006] searching the menu', () => {
  it('drops words that say nothing about the dish', () => {
    expect(queryWords('Something spicy')).toEqual(['spicy']);
    expect(queryWords('paneer dishes')).toEqual(['paneer']);
    expect(queryWords('  I want   some DAL please ')).toEqual(['dal']);
  });

  it('finds "paneer dishes" by name, and "something spicy" by tag or spice level', () => {
    expect(names(searchMenu(MENU_ITEMS, 'paneer dishes'))).toEqual([
      'Paneer Tikka',
      'Kadai Paneer',
    ]);
    expect(names(searchMenu(MENU_ITEMS, 'something spicy'))).toEqual([
      'Kadai Paneer',
      'Paneer Tikka',
      'Chicken Biryani',
    ]);
  });

  it('tolerates a typo, matches synonyms and the start of a word, and needs every word', () => {
    expect(names(searchMenu(MENU_ITEMS, 'biriyani'))).toEqual(['Chicken Biryani']);
    expect(names(searchMenu(MENU_ITEMS, 'makhni'))).toEqual(['Dal Makhani']);
    expect(names(searchMenu(MENU_ITEMS, 'anda'))).toEqual(['Masala Omelette']);
    expect(names(searchMenu(MENU_ITEMS, 'bir'))).toEqual(['Chicken Biryani']);
    expect(names(searchMenu(MENU_ITEMS, 'paneer tikka'))).toEqual(['Paneer Tikka']);
    expect(searchMenu(MENU_ITEMS, 'pizza')).toEqual([]);
    expect(searchMenu(MENU_ITEMS, '   ')).toHaveLength(MENU_ITEMS.length);
  });
});

describe('[TAB-005] filters and sorting', () => {
  it('filters veg, Jain, spicy and bestsellers, all at once if chosen', () => {
    const none = new Set<string>();
    expect(names(filterMenu(MENU_ITEMS, new Set(['veg']), none))).not.toContain('Chicken Biryani');
    expect(names(filterMenu(MENU_ITEMS, new Set(['veg']), none))).not.toContain('Masala Omelette');
    expect(names(filterMenu(MENU_ITEMS, new Set(['jain']), none))).toEqual(['Jain Thali']);
    expect(names(filterMenu(MENU_ITEMS, new Set(['spicy']), none))).toEqual([
      'Paneer Tikka',
      'Kadai Paneer',
      'Chicken Biryani',
    ]);
    expect(
      names(filterMenu(MENU_ITEMS, new Set(['veg', 'spicy', 'bestseller']), new Set([ID(2)]))),
    ).toEqual(['Kadai Paneer']);
  });

  it('sorts by price either way, menu order on a tie', () => {
    expect(names(sortMenu(MENU_ITEMS, 'priceLow'))[0]).toBe('Masala Omelette');
    expect(names(sortMenu(MENU_ITEMS, 'priceHigh'))[0]).toBe('Chicken Biryani');
    expect(names(sortMenu(MENU_ITEMS, 'menu'))).toEqual(names(MENU_ITEMS));
  });
});

describe('[TAB-008] the cart’s estimated taxes', () => {
  const lines = addLine(
    [],
    {
      itemId: IDS.dal,
      name: 'Dal Makhani',
      summary: '',
      quantity: 2,
      selection: {},
      instructions: '',
      unitPrice: 24_000,
    },
    () => ID(99),
  );

  it('adds GST on top when prices exclude it', () => {
    expect(estimateCart(lines, MENU, 'TAX_EXCLUSIVE')).toEqual({
      subtotal: 48_000,
      tax: 1_200,
      total: 49_200,
    });
  });

  it('shows the GST inside the prices when they include it', () => {
    const estimate = estimateCart(lines, MENU, 'TAX_INCLUSIVE');
    expect(estimate.subtotal).toBe(48_000);
    expect(estimate.total).toBe(48_000);
    expect(estimate.tax).toBeGreaterThan(0);
  });

  it('is nothing for an empty cart', () => {
    expect(estimateCart([], MENU, 'TAX_EXCLUSIVE')).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });
});
