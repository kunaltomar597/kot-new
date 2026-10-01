import type { QrMenuDocument } from '@rp/contracts/relay';
import { IDS, MENU } from '@rp/ordering/testing';

export { IDS };

/** "Sweet finish": a restaurant rule suggesting Rasmalai with Dal Makhani (REC-002). */
export const RULE_ID = '0199a0e0-0000-7000-8000-000000000301';

/** The shared test menu as a restaurant publishes it for its QR page. */
export function menuDocument(): QrMenuDocument {
  const onQr = new Set<string>([IDS.tikka, IDS.dal, IDS.thali, IDS.jamun, IDS.rasmalai]);
  return {
    restaurantName: 'Spice Route',
    accentColor: '#B4232A',
    timeZone: 'Asia/Kolkata',
    instructionMaxLength: 140,
    priceMode: 'TAX_EXCLUSIVE',
    serviceRequests: false,
    menu: {
      ...MENU,
      items: MENU.items.map((item) => ({
        ...item,
        channels: onQr.has(item.id)
          ? [...new Set([...item.channels, 'QR' as const])]
          : item.channels,
        ...(item.id === IDS.dal && {
          description: 'Black lentils slow-cooked overnight with butter.',
        }),
      })),
    },
    photos: [],
    recommendations: {
      rules: [
        {
          id: RULE_ID,
          priority: 50,
          when: { kind: 'ITEM', itemId: IDS.dal },
          suggest: { kind: 'ITEM', itemId: IDS.rasmalai },
          timeWindow: null,
          activeFrom: null,
          activeUntil: null,
          label: 'Sweet finish',
        },
      ],
      bestSellers: {
        ALL_DAY: [IDS.dal],
        BREAKFAST: [IDS.dal],
        LUNCH: [IDS.dal],
        EVENING: [IDS.dal],
        DINNER: [IDS.dal],
      },
      dayparts: {
        BREAKFAST: { start: '07:00', end: '11:00' },
        LUNCH: { start: '11:00', end: '16:00' },
        EVENING: { start: '16:00', end: '19:00' },
        DINNER: { start: '19:00', end: '07:00' },
      },
      businessDayCutoff: '04:00',
      courseSequence: ['Starters', 'Main Course'],
      preferences: {},
      learned: [],
    },
  };
}

/** A large menu (300 dishes with descriptions, sizes and extras) for the speed budget (QR-012). */
export function bigMenuDocument(): QrMenuDocument {
  const base = menuDocument();
  const hex = (n: number) => n.toString(16).padStart(12, '0');
  const categories = Array.from({ length: 12 }, (_, index) => ({
    id: `0199a0e0-0000-7000-8000-${hex(0x10000 + index)}`,
    name: `Section ${String(index + 1)}`,
    parentId: null,
    displayOrder: index,
  }));
  const template = base.menu.items.find((item) => item.id === IDS.dal);
  if (template === undefined) throw new Error('no template dish');
  const items = Array.from({ length: 300 }, (_, index) => ({
    ...template,
    id: `0199a0e0-0000-7000-8000-${hex(0x20000 + index)}`,
    categoryId: categories[index % categories.length]?.id ?? template.categoryId,
    name: `House dish number ${String(index + 1)}`,
    description:
      'Slow-cooked with whole spices, finished with cream and fresh coriander; served with rice.',
    basePrice: 15_000 + (index % 20) * 1_000,
    displayOrder: index,
    tags: ['chef special', 'mild'],
    synonyms: [`dish ${String(index + 1)}`],
    variants: [],
    modifierGroupIds: index % 3 === 0 ? [IDS.extras] : [],
  }));
  return {
    ...base,
    restaurantName: 'Grand Thali House',
    menu: { ...base.menu, categories, items, combos: [] },
    recommendations:
      base.recommendations === undefined ? undefined : { ...base.recommendations, rules: [] },
  };
}
