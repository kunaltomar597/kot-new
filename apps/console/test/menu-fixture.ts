import type {
  CategoryView,
  ComboView,
  ItemView,
  MenuDraftResponse,
  ModifierGroupView,
  StationView,
  TaxGroupView,
} from '@rp/contracts';
import { RESTAURANT_ID } from './fakes.js';

/** A small menu for the menu editor tests. */

const AT = '2026-09-28T10:00:00.000Z';
const id = (n: number) => `0199a0e0-0000-7000-8000-000000000${String(300 + n)}`;

export const IDS = {
  starters: id(1),
  vegStarters: id(2),
  mains: id(3),
  drinks: id(4),
  festive: id(5),
  paneerTikka: id(11),
  hariyaliKebab: id(12),
  dalMakhani: id(13),
  lassi: id(14),
  chaas: id(15),
  thali: id(16),
  oldSoup: id(17),
  roti: id(21),
  addOns: id(22),
  oldGroup: id(23),
  plain: id(31),
  butter: id(32),
  garlic: id(33),
  cheese: id(34),
  half: id(41),
  full: id(42),
  gst5: id(51),
  oldTax: id(52),
  kitchen: id(61),
  bar: id(62),
  photo: id(71),
} as const;

export function category(
  key: keyof typeof IDS,
  name: string,
  overrides: Partial<CategoryView> = {},
): CategoryView {
  return { id: IDS[key], name, parentId: null, displayOrder: 0, archivedAt: null, ...overrides };
}

export function item(
  key: keyof typeof IDS,
  name: string,
  overrides: Partial<ItemView> = {},
): ItemView {
  return {
    id: IDS[key],
    categoryId: IDS.mains,
    name,
    shortCode: null,
    description: null,
    photoId: null,
    basePrice: 25_000,
    taxGroupId: IDS.gst5,
    foodType: 'VEG',
    spiceLevel: 0,
    tags: [],
    stationId: IDS.kitchen,
    prepTimeMinutes: null,
    displayOrder: 0,
    channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
    variants: [],
    modifierGroupIds: [],
    synonyms: [],
    repeatable: false,
    externalId: null,
    available: true,
    trackStock: false,
    stockCount: null,
    archivedAt: null,
    updatedAt: AT,
    ...overrides,
  };
}

export function rotiType(overrides: Partial<ModifierGroupView> = {}): ModifierGroupView {
  return {
    id: IDS.roti,
    name: 'Roti type',
    minSelections: 1,
    maxSelections: 1,
    options: [
      {
        id: IDS.plain,
        name: 'Plain',
        priceDelta: 0,
        available: true,
        displayOrder: 1,
        archivedAt: null,
      },
      {
        id: IDS.butter,
        name: 'Butter',
        priceDelta: 1_000,
        available: true,
        displayOrder: 2,
        archivedAt: null,
      },
      {
        id: IDS.garlic,
        name: 'Garlic',
        priceDelta: 2_000,
        available: false,
        displayOrder: 3,
        archivedAt: null,
      },
    ],
    itemCount: 1,
    archivedAt: null,
    ...overrides,
  };
}

export const THALI_COMBO: ComboView = {
  itemId: IDS.thali,
  components: [
    { kind: 'FIXED', itemId: IDS.dalMakhani, label: null, itemIds: [], quantity: 1 },
    {
      kind: 'CHOICE',
      itemId: null,
      label: 'Any 1 drink',
      itemIds: [IDS.lassi, IDS.chaas],
      quantity: 1,
    },
  ],
  activeFrom: null,
  activeUntil: null,
  timeWindow: { start: '11:00', end: '16:00' },
};

/**
 * Starters (with the Veg starters sub-category), Mains, Drinks and an archived Festive category;
 * a paneer tikka in two sizes, a counted kebab, dal, two drinks (one out of stock, one not on the
 * QR menu), a thali combo, and an archived soup.
 */
export function menuDraft(overrides: Partial<MenuDraftResponse> = {}): MenuDraftResponse {
  return {
    categories: [
      category('starters', 'Starters', { displayOrder: 1 }),
      category('vegStarters', 'Veg starters', { parentId: IDS.starters, displayOrder: 1 }),
      category('mains', 'Mains', { displayOrder: 2 }),
      category('drinks', 'Drinks', { displayOrder: 3 }),
      category('festive', 'Festive', { displayOrder: 4, archivedAt: AT }),
    ],
    modifierGroups: [
      rotiType(),
      {
        id: IDS.addOns,
        name: 'Add-ons',
        minSelections: 0,
        maxSelections: 2,
        options: [
          {
            id: IDS.cheese,
            name: 'Extra cheese',
            priceDelta: 3_000,
            available: true,
            displayOrder: 1,
            archivedAt: null,
          },
        ],
        itemCount: 0,
        archivedAt: null,
      },
      {
        id: IDS.oldGroup,
        name: 'Old sauces',
        minSelections: 0,
        maxSelections: 1,
        options: [],
        itemCount: 0,
        archivedAt: AT,
      },
    ],
    items: [
      item('paneerTikka', 'Paneer Tikka', {
        categoryId: IDS.vegStarters,
        shortCode: 'PT',
        basePrice: 22_000,
        spiceLevel: 2,
        tags: ['Bestseller'],
        synonyms: ['panir'],
        variants: [
          {
            id: IDS.half,
            name: 'Half',
            price: 18_000,
            displayOrder: 1,
            externalId: 'POS-PT-H',
            archivedAt: null,
          },
          {
            id: IDS.full,
            name: 'Full',
            price: 32_000,
            displayOrder: 2,
            externalId: null,
            archivedAt: null,
          },
        ],
        modifierGroupIds: [IDS.addOns],
      }),
      item('hariyaliKebab', 'Hariyali Kebab', {
        categoryId: IDS.vegStarters,
        trackStock: true,
        stockCount: 6,
        photoId: IDS.photo,
      }),
      item('dalMakhani', 'Dal Makhani', {
        basePrice: 28_000,
        modifierGroupIds: [IDS.roti],
        prepTimeMinutes: 15,
      }),
      item('thali', 'Veg Thali', { basePrice: 34_900, displayOrder: 1 }),
      item('lassi', 'Lassi', {
        categoryId: IDS.drinks,
        basePrice: 9_000,
        stationId: IDS.bar,
        available: false,
        repeatable: true,
      }),
      item('chaas', 'Masala Chaas', {
        categoryId: IDS.drinks,
        basePrice: 6_000,
        stationId: IDS.bar,
        channels: ['POS', 'WAITER_APP', 'TABLE_TABLET'],
      }),
      item('oldSoup', 'Tomato Soup', { categoryId: IDS.starters, archivedAt: AT }),
    ],
    combos: [THALI_COMBO],
    published: { version: 3, publishedAt: '2026-09-28T08:30:00.000Z' },
    unpublished: true,
    ...overrides,
  };
}

export function taxGroups(): TaxGroupView[] {
  return [
    {
      id: IDS.gst5,
      name: 'GST 5 %',
      sacCode: '996331',
      components: [
        { code: 'CGST', rateBp: 250 },
        { code: 'SGST', rateBp: 250 },
      ],
      totalRateBp: 500,
      itemCount: 6,
      archivedAt: null,
      updatedAt: AT,
    },
    {
      id: IDS.oldTax,
      name: 'Old VAT',
      sacCode: null,
      components: [{ code: 'VAT', rateBp: 1_400 }],
      totalRateBp: 1_400,
      itemCount: 0,
      archivedAt: AT,
      updatedAt: AT,
    },
  ];
}

export function stations(): StationView[] {
  return [
    { id: IDS.kitchen, name: 'Kitchen', mode: 'SCREEN', printerId: null, archivedAt: null },
    { id: IDS.bar, name: 'Bar', mode: 'SCREEN', printerId: null, archivedAt: null },
  ];
}

/** A menu event as the live connection delivers it. */
export function menuEvent(
  sequence: number,
  type: 'MenuDraftChanged' | 'MenuPublished',
  payload: Record<string, unknown>,
) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000008${String(sequence).padStart(2, '0')}`,
      type,
      version: 1,
      occurredAt: AT,
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-28',
      payload,
    },
  };
}
