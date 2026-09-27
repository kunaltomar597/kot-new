import type { MenuItem, MenuSnapshot, OrderView } from '@rp/contracts';

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const IDS = {
  starters: uuid(1),
  mains: uuid(2),
  tax: uuid(3),
  kitchen: uuid(4),
  tikka: uuid(10),
  dal: uuid(11),
  thali: uuid(12),
  jamun: uuid(13),
  rasmalai: uuid(14),
  half: uuid(20),
  full: uuid(21),
  extras: uuid(30),
  cheese: uuid(31),
  butter: uuid(32),
  combo: uuid(40),
  session: uuid(50),
  order: uuid(60),
  orderItem: uuid(61),
} as const;

function item(id: string, name: string, overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id,
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
    displayOrder: 1,
    channels: ['POS', 'WAITER_APP'],
    variants: [],
    modifierGroupIds: [],
    synonyms: [],
    repeatable: true,
    archived: false,
    ...overrides,
  };
}

export const MENU: MenuSnapshot = {
  version: 1,
  publishedAt: '2026-09-26T08:00:00.000Z',
  categories: [
    { id: IDS.starters, name: 'Starters', parentId: null, displayOrder: 1 },
    { id: IDS.mains, name: 'Main Course', parentId: null, displayOrder: 2 },
  ],
  items: [
    item(IDS.tikka, 'Paneer Tikka', {
      categoryId: IDS.starters,
      basePrice: 28_000,
      variants: [
        { id: IDS.half, name: 'Half', price: 18_000 },
        { id: IDS.full, name: 'Full', price: 28_000 },
      ],
      modifierGroupIds: [IDS.extras],
      synonyms: ['tikka'],
    }),
    item(IDS.dal, 'Dal Makhani', { basePrice: 24_000, displayOrder: 2, shortCode: 'DM' }),
    item(IDS.thali, 'Veg Thali Combo', { basePrice: 34_900, displayOrder: 3 }),
    item(IDS.jamun, 'Gulab Jamun', { basePrice: 9_000, displayOrder: 4, stockCount: 0 }),
    item(IDS.rasmalai, 'Rasmalai', { basePrice: 11_000, displayOrder: 5, channels: ['QR'] }),
  ],
  modifierGroups: [
    {
      id: IDS.extras,
      name: 'Extras',
      minSelections: 0,
      maxSelections: 2,
      options: [
        { id: IDS.cheese, name: 'Cheese', priceDelta: 4_000 },
        { id: IDS.butter, name: 'Butter', priceDelta: 2_000 },
      ],
    },
  ],
  combos: [
    {
      id: IDS.combo,
      itemId: IDS.thali,
      components: [
        { kind: 'FIXED', itemId: IDS.dal, quantity: 1 },
        { kind: 'CHOICE', label: 'Dessert', itemIds: [IDS.jamun, IDS.rasmalai], quantity: 1 },
      ],
    },
  ],
  taxGroups: [{ id: IDS.tax, name: 'GST 5 %', components: [{ code: 'CGST', rateBp: 250 }] }],
  stations: [{ id: IDS.kitchen, name: 'Kitchen', mode: 'SCREEN' }],
};

export function sentOrder(
  state: OrderView['items'][number]['state'],
  overrides: Partial<OrderView> = {},
): OrderView {
  return {
    id: IDS.order,
    orderNumber: 7,
    orderType: 'DINE_IN',
    source: 'POS',
    status: 'OPEN',
    tableSessionId: IDS.session,
    tableId: null,
    takeawayToken: null,
    customerName: null,
    businessDate: '2026-09-26',
    createdAt: '2026-09-26T08:30:00.000Z',
    note: null,
    items: [
      {
        id: IDS.orderItem,
        itemId: IDS.dal,
        parentOrderItemId: null,
        name: 'Dal Makhani',
        variantName: null,
        modifiers: [],
        quantity: 1,
        unitPrice: 24_000,
        lineTotal: 24_000,
        stationId: IDS.kitchen,
        state,
        instructions: null,
      },
    ],
    kots: [],
    ...overrides,
  };
}
