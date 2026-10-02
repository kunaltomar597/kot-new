import { describe, expect, it } from 'vitest';
import {
  type MenuImportContext,
  planMenuImport,
  type ReviewedMenu,
  reviewedMenuSheets,
  rupeesText,
  uncheckedDishes,
} from '../src/index.js';

const CONTEXT: MenuImportContext = {
  taxGroups: [{ id: 'tax-5', name: 'GST 5 %' }],
  stations: [
    { id: 'st-tandoor', name: 'Tandoor' },
    { id: 'st-bar', name: 'Bar' },
  ],
  categories: [],
  modifierGroups: [],
  items: [],
};

const dish = (overrides: Partial<ReviewedMenu['categories'][number]['items'][number]> = {}) => ({
  name: 'Paneer Tikka',
  description: 'Char-grilled, with mint chutney',
  price: 28_000,
  variants: [],
  foodType: 'VEG' as const,
  spiceLevel: 2,
  tags: ['Chef special'],
  taxGroup: 'GST 5 %',
  station: 'Tandoor',
  checked: true,
  ...overrides,
});

const MENU: ReviewedMenu = {
  categories: [
    {
      name: 'Starters',
      items: [
        dish(),
        dish({
          name: 'Chicken Biryani',
          description: null,
          price: null,
          variants: [
            { name: 'Half', price: 22_000 },
            { name: 'Full', price: 39_950 },
          ],
          foodType: 'NON_VEG',
          spiceLevel: 0,
          tags: ['Bestseller, house special'],
        }),
      ],
    },
    {
      name: 'Drinks',
      items: [dish({ name: 'Sweet Lassi', price: 9_000, station: 'Bar', tags: [] })],
    },
  ],
  addOns: [
    {
      group: 'Extras',
      minSelections: 0,
      maxSelections: 2,
      options: [
        { name: 'Extra cheese', priceDelta: 4_000 },
        { name: 'No onion', priceDelta: 0 },
      ],
    },
  ],
};

describe('[ONB-006] [ONB-005] importing a checked AI draft through the template', () => {
  it('writes rupees as the template takes them', () => {
    expect(rupeesText(24_950)).toBe('249.50');
    expect(rupeesText(9_000)).toBe('90.00');
    expect(rupeesText(5)).toBe('0.05');
    expect(rupeesText(-1_000)).toBe('-10.00');
  });

  it('makes sheets the template import accepts, with every dish, size and extra', () => {
    const sheets = reviewedMenuSheets(MENU);
    expect(sheets.Items?.[1]).toEqual([
      'Starters',
      'Paneer Tikka',
      'Char-grilled, with mint chutney',
      '280.00',
      'GST 5 %',
      'Veg',
      '2',
      'Chef special',
      'Tandoor',
    ]);
    // A comma inside a tag would split it into two.
    expect(sheets.Items?.[2]?.[7]).toBe('Bestseller  house special');
    expect(sheets.Variants).toEqual([
      ['Item', 'Variant', 'Price'],
      ['Chicken Biryani', 'Half', '220.00'],
      ['Chicken Biryani', 'Full', '399.50'],
    ]);
    const result = planMenuImport(sheets, CONTEXT);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.summary).toEqual({
      categories: 2,
      modifierGroups: 1,
      items: 3,
      variants: 2,
      combos: 0,
    });
    const biryani = result.plan.items.find((item) => item.name === 'Chicken Biryani');
    expect(biryani).toMatchObject({ foodType: 'NON_VEG', basePrice: 22_000 });
    expect(result.plan.items.find((item) => item.name === 'Sweet Lassi')?.stationId).toBe('st-bar');
  });

  it('lists the dishes nobody has checked', () => {
    expect(uncheckedDishes(MENU)).toEqual([]);
    const partly: ReviewedMenu = {
      ...MENU,
      categories: [{ name: 'Starters', items: [dish(), dish({ name: 'Dal', checked: false })] }],
    };
    expect(uncheckedDishes(partly)).toEqual(['Dal']);
  });

  it('leaves problems to the template check, row by row', () => {
    const noPrice: ReviewedMenu = {
      categories: [{ name: 'Starters', items: [dish({ price: null })] }],
      addOns: [],
    };
    const result = planMenuImport(reviewedMenuSheets(noPrice), CONTEXT);
    expect(result.ok).toBe(false);
  });
});
