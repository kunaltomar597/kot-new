import type {
  CategoryView,
  ItemView,
  MenuDraftResponse,
  ModifierGroupView,
  StationView,
  TaxGroupView,
} from '@rp/contracts';

/** A small draft menu for the menu editor's tests (P4-02d). */

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-09-20T10:00:00.000Z';

export const MAINS = uuid(1001);
export const CURRIES = uuid(1002);
export const BREADS = uuid(1003);
export const OLD_CATEGORY = uuid(1004);

export const GST5 = uuid(1011);
export const KITCHEN = uuid(1021);
export const TANDOOR = uuid(1022);

export const ROTI_TYPE = uuid(1031);
export const ADD_ONS = uuid(1032);

export const PANEER = uuid(1041);
export const NAAN = uuid(1042);
export const THALI = uuid(1043);
export const OLD_DISH = uuid(1044);
export const HALF = uuid(1051);
export const FULL = uuid(1052);

export function category(overrides: Partial<CategoryView> = {}): CategoryView {
  return {
    id: MAINS,
    name: 'Mains',
    parentId: null,
    displayOrder: 10,
    archivedAt: null,
    ...overrides,
  };
}

export function item(overrides: Partial<ItemView> = {}): ItemView {
  return {
    id: NAAN,
    categoryId: BREADS,
    name: 'Butter Naan',
    shortCode: 'BN',
    description: null,
    photoId: null,
    basePrice: 6000,
    taxGroupId: GST5,
    foodType: 'VEG',
    spiceLevel: 0,
    tags: [],
    stationId: TANDOOR,
    prepTimeMinutes: null,
    timeWindow: null,
    displayOrder: 10,
    channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
    variants: [],
    modifierGroupIds: [],
    synonyms: [],
    repeatable: true,
    externalId: null,
    available: true,
    trackStock: false,
    stockCount: null,
    archivedAt: null,
    updatedAt: AT,
    ...overrides,
  };
}

export function group(overrides: Partial<ModifierGroupView> = {}): ModifierGroupView {
  return {
    id: ROTI_TYPE,
    name: 'Roti type',
    minSelections: 1,
    maxSelections: 1,
    options: [
      {
        id: uuid(1061),
        name: 'Plain',
        priceDelta: 0,
        available: true,
        displayOrder: 0,
        archivedAt: null,
      },
      {
        id: uuid(1062),
        name: 'Butter',
        priceDelta: 1000,
        available: true,
        displayOrder: 1,
        archivedAt: null,
      },
    ],
    itemCount: 1,
    archivedAt: null,
    ...overrides,
  };
}

export function draftMenu(): MenuDraftResponse {
  return {
    categories: [
      category(),
      category({ id: CURRIES, name: 'Curries', parentId: MAINS, displayOrder: 10 }),
      category({ id: BREADS, name: 'Breads', displayOrder: 20 }),
      category({ id: OLD_CATEGORY, name: 'Monsoon specials', displayOrder: 30, archivedAt: AT }),
    ],
    modifierGroups: [
      group(),
      group({
        id: ADD_ONS,
        name: 'Add-ons',
        minSelections: 0,
        maxSelections: 3,
        itemCount: 0,
        archivedAt: AT,
      }),
    ],
    items: [
      item({
        id: PANEER,
        categoryId: CURRIES,
        name: 'Paneer Tikka Masala',
        shortCode: 'PTM',
        basePrice: 28000,
        stationId: KITCHEN,
        spiceLevel: 2,
        tags: ['bestseller'],
        synonyms: ['panir'],
        variants: [
          {
            id: HALF,
            name: 'Half',
            price: 18000,
            displayOrder: 0,
            externalId: null,
            archivedAt: null,
          },
          {
            id: FULL,
            name: 'Full',
            price: 28000,
            displayOrder: 1,
            externalId: null,
            archivedAt: null,
          },
        ],
        modifierGroupIds: [],
        available: true,
        trackStock: true,
        stockCount: 4,
      }),
      item({ modifierGroupIds: [ROTI_TYPE] }),
      item({
        id: THALI,
        categoryId: MAINS,
        name: 'Veg Thali',
        shortCode: null,
        basePrice: 35000,
        stationId: KITCHEN,
        available: false,
      }),
      item({ id: OLD_DISH, name: 'Mango Lassi', categoryId: BREADS, archivedAt: AT }),
    ],
    combos: [
      {
        itemId: THALI,
        components: [
          { kind: 'FIXED', itemId: PANEER, label: null, itemIds: [], quantity: 1 },
          { kind: 'FIXED', itemId: NAAN, label: null, itemIds: [], quantity: 2 },
        ],
        activeFrom: null,
        activeUntil: null,
        timeWindow: null,
      },
    ],
  };
}

export function taxGroups(): { taxGroups: TaxGroupView[] } {
  return {
    taxGroups: [
      {
        id: GST5,
        name: 'GST 5%',
        sacCode: '996331',
        components: [
          { code: 'CGST', rateBp: 250 },
          { code: 'SGST', rateBp: 250 },
        ],
        totalRateBp: 500,
        itemCount: 3,
        archivedAt: null,
        updatedAt: AT,
      },
    ],
  };
}

export function stations(): { stations: StationView[] } {
  return {
    stations: [
      { id: KITCHEN, name: 'Kitchen', mode: 'SCREEN', printerId: null, archivedAt: null },
      { id: TANDOOR, name: 'Tandoor', mode: 'SCREEN', printerId: null, archivedAt: null },
    ],
  };
}
