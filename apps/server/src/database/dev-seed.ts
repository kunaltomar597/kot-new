import type { PrismaClient } from '../generated/prisma/client.js';
import { newId } from '../common/ids.js';
import { buildMenuContent, menuChecksum } from '../menu/menu-content.js';

/**
 * Development and demo data (P0-08): one restaurant, GST 5 % and 18 % tax groups, 2 stations,
 * 10 tables in 2 sections, staff of every role and 30 menu items with variants, modifiers and a
 * combo, published as menu version 1 so every ordering surface has a menu at once. Staff get PINs
 * only when `hashPin` is given. Refuses to run on a database that
 * already has a restaurant, so it can never touch real data.
 */
export interface SeedOptions {
  /** Hashes a PIN with the server's pepper; when given, every person gets the PIN listed below. */
  readonly hashPin?: (pin: string) => Promise<string>;
}

/** Development PINs (never used outside development and tests). */
export const DEV_PINS = {
  'Asha (Owner)': '1111',
  'Vikram (Manager)': '2222',
  'Neha (Cashier)': '3333',
  Ravi: '4444',
  Sunita: '5555',
  'Chef Imran': '6666',
} as const;

export interface SeedSummary {
  readonly restaurantId: string;
  readonly items: number;
  readonly tables: number;
  readonly staff: number;
}

type Food = 'VEG' | 'NON_VEG' | 'EGG';

interface ItemSpec {
  readonly name: string;
  readonly category: string;
  readonly price: number;
  readonly food: Food;
  readonly station: 'kitchen' | 'bar';
  readonly tax?: 'gst5' | 'gst18';
  readonly variants?: readonly (readonly [string, number])[];
  readonly modifiers?: readonly ('spice' | 'addons')[];
  readonly spice?: number;
  readonly synonyms?: readonly string[];
  readonly tags?: readonly string[];
}

const CATEGORIES = ['Starters', 'Main Course', 'Breads', 'Rice', 'Beverages', 'Desserts', 'Combos'];

const R = 100; // paise per rupee, for readable prices below

const ITEMS: readonly ItemSpec[] = [
  {
    name: 'Paneer Tikka',
    category: 'Starters',
    price: 290 * R,
    food: 'VEG',
    station: 'kitchen',
    spice: 2,
    modifiers: ['spice'],
    tags: ['bestseller'],
  },
  {
    name: 'Hara Bhara Kabab',
    category: 'Starters',
    price: 240 * R,
    food: 'VEG',
    station: 'kitchen',
    spice: 1,
  },
  {
    name: 'Veg Spring Roll',
    category: 'Starters',
    price: 220 * R,
    food: 'VEG',
    station: 'kitchen',
  },
  {
    name: 'Chicken Tikka',
    category: 'Starters',
    price: 340 * R,
    food: 'NON_VEG',
    station: 'kitchen',
    spice: 2,
    modifiers: ['spice'],
    variants: [
      ['Half', 220 * R],
      ['Full', 340 * R],
    ],
  },
  {
    name: 'Chicken 65',
    category: 'Starters',
    price: 320 * R,
    food: 'NON_VEG',
    station: 'kitchen',
    spice: 3,
  },
  {
    name: 'Egg Bhurji',
    category: 'Starters',
    price: 160 * R,
    food: 'EGG',
    station: 'kitchen',
    spice: 1,
  },
  {
    name: 'Paneer Butter Masala',
    category: 'Main Course',
    price: 320 * R,
    food: 'VEG',
    station: 'kitchen',
    spice: 1,
    modifiers: ['spice', 'addons'],
    synonyms: ['PBM'],
    tags: ['bestseller'],
  },
  {
    name: 'Dal Makhani',
    category: 'Main Course',
    price: 260 * R,
    food: 'VEG',
    station: 'kitchen',
    variants: [
      ['Half', 160 * R],
      ['Full', 260 * R],
    ],
    synonyms: ['DM'],
  },
  {
    name: 'Kadai Paneer',
    category: 'Main Course',
    price: 310 * R,
    food: 'VEG',
    station: 'kitchen',
    spice: 2,
    modifiers: ['spice'],
  },
  { name: 'Mix Veg', category: 'Main Course', price: 240 * R, food: 'VEG', station: 'kitchen' },
  {
    name: 'Butter Chicken',
    category: 'Main Course',
    price: 380 * R,
    food: 'NON_VEG',
    station: 'kitchen',
    spice: 1,
    variants: [
      ['Half', 240 * R],
      ['Full', 380 * R],
    ],
    synonyms: ['BC'],
    tags: ['bestseller'],
  },
  {
    name: 'Chicken Curry',
    category: 'Main Course',
    price: 340 * R,
    food: 'NON_VEG',
    station: 'kitchen',
    spice: 2,
    modifiers: ['spice'],
  },
  {
    name: 'Mutton Rogan Josh',
    category: 'Main Course',
    price: 450 * R,
    food: 'NON_VEG',
    station: 'kitchen',
    spice: 2,
  },
  {
    name: 'Egg Curry',
    category: 'Main Course',
    price: 220 * R,
    food: 'EGG',
    station: 'kitchen',
    spice: 2,
  },
  {
    name: 'Tandoori Roti',
    category: 'Breads',
    price: 30 * R,
    food: 'VEG',
    station: 'kitchen',
    modifiers: ['addons'],
  },
  { name: 'Butter Naan', category: 'Breads', price: 60 * R, food: 'VEG', station: 'kitchen' },
  { name: 'Garlic Naan', category: 'Breads', price: 80 * R, food: 'VEG', station: 'kitchen' },
  { name: 'Lachha Paratha', category: 'Breads', price: 70 * R, food: 'VEG', station: 'kitchen' },
  { name: 'Jeera Rice', category: 'Rice', price: 180 * R, food: 'VEG', station: 'kitchen' },
  {
    name: 'Veg Biryani',
    category: 'Rice',
    price: 260 * R,
    food: 'VEG',
    station: 'kitchen',
    spice: 2,
  },
  {
    name: 'Chicken Biryani',
    category: 'Rice',
    price: 340 * R,
    food: 'NON_VEG',
    station: 'kitchen',
    spice: 2,
    variants: [
      ['Half', 220 * R],
      ['Full', 340 * R],
    ],
  },
  { name: 'Steamed Rice', category: 'Rice', price: 140 * R, food: 'VEG', station: 'kitchen' },
  { name: 'Masala Chaas', category: 'Beverages', price: 70 * R, food: 'VEG', station: 'bar' },
  { name: 'Sweet Lassi', category: 'Beverages', price: 90 * R, food: 'VEG', station: 'bar' },
  {
    name: 'Fresh Lime Soda',
    category: 'Beverages',
    price: 90 * R,
    food: 'VEG',
    station: 'bar',
    variants: [
      ['Sweet', 90 * R],
      ['Salted', 90 * R],
    ],
  },
  { name: 'Masala Chai', category: 'Beverages', price: 40 * R, food: 'VEG', station: 'bar' },
  {
    name: 'Packaged Water',
    category: 'Beverages',
    price: 20 * R,
    food: 'VEG',
    station: 'bar',
    tax: 'gst18',
  },
  { name: 'Gulab Jamun', category: 'Desserts', price: 90 * R, food: 'VEG', station: 'kitchen' },
  { name: 'Rasmalai', category: 'Desserts', price: 120 * R, food: 'VEG', station: 'kitchen' },
  { name: 'Veg Thali Combo', category: 'Combos', price: 349 * R, food: 'VEG', station: 'kitchen' },
];

export async function seedDevelopmentData(
  prisma: PrismaClient,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  if ((await prisma.restaurant.count()) > 0) {
    throw new Error(
      'The database already has a restaurant; the development seed only runs on an empty database.',
    );
  }
  return prisma.$transaction(
    async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          legalName: 'Demo Foods Private Limited',
          displayName: 'Demo Dhaba',
          stateCode: '27',
          address: { line1: '1 Demo Road', city: 'Pune', pincode: '411001' },
        },
      });
      const restaurantId = restaurant.id;
      const base = { restaurantId };

      // Tax groups: rates are data (BILL-004).
      const gst5 = await tx.taxGroup.create({
        data: {
          ...base,
          name: 'GST 5 %',
          sacCode: '996331',
          components: {
            create: [
              { ...base, code: 'CGST', rateBp: 250, displayOrder: 1 },
              { ...base, code: 'SGST', rateBp: 250, displayOrder: 2 },
            ],
          },
        },
      });
      const gst18 = await tx.taxGroup.create({
        data: {
          ...base,
          name: 'GST 18 %',
          sacCode: '996331',
          components: {
            create: [
              { ...base, code: 'CGST', rateBp: 900, displayOrder: 1 },
              { ...base, code: 'SGST', rateBp: 900, displayOrder: 2 },
            ],
          },
        },
      });

      await tx.invoiceSeries.createMany({
        data: [
          { ...base, name: 'Dine-in', prefix: 'INV', isDefault: true },
          { ...base, name: 'Takeaway', prefix: 'TA' },
        ],
      });

      const printer = await tx.printer.create({
        data: {
          ...base,
          name: 'Kitchen printer',
          connection: 'NETWORK',
          host: '192.168.1.50',
          port: 9100,
        },
      });
      const kitchen = await tx.station.create({
        data: { ...base, name: 'Kitchen', mode: 'BOTH', printerId: printer.id },
      });
      const bar = await tx.station.create({ data: { ...base, name: 'Bar', mode: 'SCREEN' } });

      // Floor: 6 tables in the hall, 4 on the terrace.
      const hall = await tx.section.create({
        data: { ...base, name: 'Main Hall', displayOrder: 1 },
      });
      const terrace = await tx.section.create({
        data: { ...base, name: 'Terrace', displayOrder: 2 },
      });
      await tx.diningTable.createMany({
        data: Array.from({ length: 10 }, (_, index) => ({
          ...base,
          sectionId: index < 6 ? hall.id : terrace.id,
          label: String(index + 1),
          capacity: index % 3 === 0 ? 6 : 4,
          displayOrder: index + 1,
        })),
      });

      // Built-in roles and one person per role (two waiters).
      const roleIds = new Map<string, string>();
      for (const [key, name] of [
        ['OWNER', 'Owner'],
        ['MANAGER', 'Manager'],
        ['CASHIER', 'Cashier'],
        ['WAITER', 'Waiter'],
        ['KITCHEN', 'Kitchen'],
      ] as const) {
        const role = await tx.role.create({ data: { ...base, key, name, baseRole: key } });
        roleIds.set(key, role.id);
      }
      const people = [
        ['OWNER', 'Asha (Owner)'],
        ['MANAGER', 'Vikram (Manager)'],
        ['CASHIER', 'Neha (Cashier)'],
        ['WAITER', 'Ravi'],
        ['WAITER', 'Sunita'],
        ['KITCHEN', 'Chef Imran'],
      ] as const;
      let ownerId: string | undefined;
      for (const [role, displayName] of people) {
        const staff = await tx.staff.create({
          data: { ...base, roleId: roleIds.get(role) ?? '', displayName },
        });
        if (role === 'OWNER') ownerId = staff.id;
        if (options.hashPin !== undefined) {
          await tx.credential.create({
            data: {
              ...base,
              staffId: staff.id,
              kind: 'PIN',
              secretHash: await options.hashPin(DEV_PINS[displayName]),
            },
          });
        }
      }

      // Menu.
      const categoryIds = new Map<string, string>();
      for (const [index, name] of CATEGORIES.entries()) {
        const category = await tx.category.create({
          data: { ...base, name, displayOrder: index + 1 },
        });
        categoryIds.set(name, category.id);
      }
      const spice = await tx.modifierGroup.create({
        data: {
          ...base,
          name: 'Spice level',
          minSelections: 0,
          maxSelections: 1,
          options: {
            create: [
              { ...base, name: 'Mild', displayOrder: 1 },
              { ...base, name: 'Medium', displayOrder: 2 },
              { ...base, name: 'Hot', displayOrder: 3 },
            ],
          },
        },
      });
      const addons = await tx.modifierGroup.create({
        data: {
          ...base,
          name: 'Add-ons',
          minSelections: 0,
          maxSelections: 3,
          options: {
            create: [
              { ...base, name: 'Extra butter', priceDelta: 20 * R, displayOrder: 1 },
              { ...base, name: 'Extra cheese', priceDelta: 40 * R, displayOrder: 2 },
              { ...base, name: 'No onion', priceDelta: 0, displayOrder: 3 },
            ],
          },
        },
      });
      const groups = { spice: spice.id, addons: addons.id };
      const tagIds = new Map<string, string>();

      const itemIds = new Map<string, string>();
      for (const [index, spec] of ITEMS.entries()) {
        const id = newId();
        itemIds.set(spec.name, id);
        await tx.item.create({
          data: {
            ...base,
            id,
            categoryId: categoryIds.get(spec.category) ?? '',
            name: spec.name,
            basePrice: spec.price,
            taxGroupId: spec.tax === 'gst18' ? gst18.id : gst5.id,
            foodType: spec.food,
            spiceLevel: spec.spice ?? 0,
            stationId: spec.station === 'bar' ? bar.id : kitchen.id,
            displayOrder: index + 1,
            trackStock: spec.name === 'Gulab Jamun',
            variants: {
              create: (spec.variants ?? []).map(([name, price], order) => ({
                ...base,
                name,
                price,
                displayOrder: order + 1,
              })),
            },
            modifierGroups: {
              create: (spec.modifiers ?? []).map((group, order) => ({
                ...base,
                groupId: groups[group],
                displayOrder: order + 1,
              })),
            },
            synonyms: { create: (spec.synonyms ?? []).map((text) => ({ ...base, text })) },
          },
        });
        for (const tag of spec.tags ?? []) {
          let tagId = tagIds.get(tag);
          if (tagId === undefined) {
            tagId = (await tx.tag.create({ data: { ...base, name: tag } })).id;
            tagIds.set(tag, tagId);
          }
          await tx.itemTag.create({ data: { ...base, itemId: id, tagId } });
        }
      }
      await tx.stockLevel.create({
        data: { ...base, itemId: itemIds.get('Gulab Jamun') ?? '', quantity: 40 },
      });

      // Combo: Veg Thali = Dal Makhani + 2 Tandoori Roti + Jeera Rice + a choice of dessert, sold
      // all day (a time window would make demos and tests depend on the clock).
      const item = (name: string) => itemIds.get(name) ?? '';
      await tx.combo.create({
        data: {
          ...base,
          itemId: item('Veg Thali Combo'),
          components: {
            create: [
              { ...base, kind: 'FIXED', itemId: item('Dal Makhani'), quantity: 1, displayOrder: 1 },
              {
                ...base,
                kind: 'FIXED',
                itemId: item('Tandoori Roti'),
                quantity: 2,
                displayOrder: 2,
              },
              { ...base, kind: 'FIXED', itemId: item('Jeera Rice'), quantity: 1, displayOrder: 3 },
              {
                ...base,
                kind: 'CHOICE',
                label: 'Dessert',
                quantity: 1,
                displayOrder: 4,
                choices: {
                  create: [
                    { ...base, itemId: item('Gulab Jamun') },
                    { ...base, itemId: item('Rasmalai') },
                  ],
                },
              },
            ],
          },
        },
      });

      // Publish the demo menu as version 1 (MENU-013), as the Owner would.
      const content = await buildMenuContent(tx, restaurantId);
      const publishedAt = new Date();
      await tx.menuVersion.create({
        data: {
          id: newId(),
          restaurantId,
          version: 1,
          publishedAt,
          publishedById: ownerId ?? null,
          snapshot: { version: 1, publishedAt: publishedAt.toISOString(), ...content },
          checksum: menuChecksum(content),
        },
      });

      return { restaurantId, items: ITEMS.length, tables: 10, staff: people.length };
    },
    { timeout: 60_000 },
  );
}
