import type { MenuImportSheets } from './menu-import.js';

/**
 * AI-assisted menu import (P6-04b, ONB-006): the draft a manager checked, turned into the import
 * template's sheets (P1-05), so it is checked and written exactly like an uploaded file.
 */

export interface ReviewedDish {
  readonly name: string;
  readonly description: string | null;
  /** Paise; null when its variants carry the prices. */
  readonly price: number | null;
  readonly variants: readonly { readonly name: string; readonly price: number }[];
  readonly foodType: 'VEG' | 'NON_VEG' | 'EGG';
  readonly spiceLevel: number;
  readonly tags: readonly string[];
  /** Names, as the template takes them. */
  readonly taxGroup: string;
  readonly station: string;
  readonly checked: boolean;
}

export interface ReviewedMenu {
  readonly categories: readonly {
    readonly name: string;
    readonly items: readonly ReviewedDish[];
  }[];
  readonly addOns: readonly {
    readonly group: string;
    readonly minSelections: number;
    readonly maxSelections: number;
    readonly options: readonly { readonly name: string; readonly priceDelta: number }[];
  }[];
}

/** The dishes nobody has checked yet: ONB-006 imports nothing until there are none. */
export function uncheckedDishes(menu: {
  readonly categories: readonly {
    readonly items: readonly { readonly name: string; readonly checked: boolean }[];
  }[];
}): string[] {
  return menu.categories.flatMap((category) =>
    category.items.filter((item) => !item.checked).map((item) => item.name),
  );
}

/** Paise as the template's rupees: 24950 is "249.50", -1000 is "-10.00". */
export function rupeesText(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const value = Math.abs(paise);
  return `${sign}${String(Math.trunc(value / 100))}.${String(value % 100).padStart(2, '0')}`;
}

/** Commas and line breaks would split a cell in the template's lists. */
const cell = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();
const listCell = (values: readonly string[]) =>
  values.map((value) => cell(value).replace(/,/g, ' ')).join(', ');

const FOOD_WORDS = { VEG: 'Veg', NON_VEG: 'Non-veg', EGG: 'Egg' } as const;

/** The reviewed menu as the template's Items, Variants and Modifiers sheets (header first). */
export function reviewedMenuSheets(menu: ReviewedMenu): MenuImportSheets {
  const items: string[][] = [
    [
      'Category',
      'Item',
      'Description',
      'Price',
      'Tax group',
      'Food type',
      'Spice level',
      'Tags',
      'Station',
    ],
  ];
  const variants: string[][] = [['Item', 'Variant', 'Price']];
  for (const category of menu.categories) {
    for (const item of category.items) {
      items.push([
        cell(category.name),
        cell(item.name),
        item.description === null ? '' : cell(item.description),
        item.price === null ? '' : rupeesText(item.price),
        item.taxGroup,
        FOOD_WORDS[item.foodType],
        String(item.spiceLevel),
        listCell(item.tags),
        item.station,
      ]);
      for (const variant of item.variants) {
        variants.push([cell(item.name), cell(variant.name), rupeesText(variant.price)]);
      }
    }
  }
  const modifiers: string[][] = [['Group', 'Min', 'Max', 'Option', 'Price change']];
  for (const addOn of menu.addOns) {
    addOn.options.forEach((option, index) => {
      modifiers.push([
        cell(addOn.group),
        index === 0 ? String(addOn.minSelections) : '',
        index === 0 ? String(addOn.maxSelections) : '',
        cell(option.name),
        rupeesText(option.priceDelta),
      ]);
    });
  }
  return {
    Items: items,
    ...(variants.length > 1 && { Variants: variants }),
    ...(modifiers.length > 1 && { Modifiers: modifiers }),
  };
}
