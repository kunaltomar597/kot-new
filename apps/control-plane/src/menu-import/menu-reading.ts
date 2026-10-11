import { MenuDraft, type MenuDraftItem } from '@rp/contracts/control-plane';

/**
 * How the AI provider is asked to read a printed menu, and how its answer becomes a `MenuDraft`
 * (P6-04a, ONB-006). The model fills one tool call; prices come back as the text printed, and are
 * turned into paise here with integer arithmetic (BRD §9.4), never through floating point. Text is
 * trimmed to the draft's limits, so a long or odd menu still makes a draft for a person to check.
 */

export const RECORD_MENU_TOOL = 'record_menu';

export const READING_SYSTEM_PROMPT = [
  'You read printed restaurant menus from India for a point-of-sale system.',
  'Record exactly what is printed: every section and every dish, in the order printed.',
  'Never invent dishes, prices, descriptions or tags that are not on the menu.',
  'Prices are in Indian rupees. Write a price as printed digits, e.g. "249" or "249.50"; leave',
  'out the rupee sign, "Rs", "/-" and thousands separators.',
  'When a dish has sizes or portions (Half/Full, Regular/Large, 2 pcs/4 pcs) with their own',
  'prices, list them as sizes and leave its price null.',
  'Food type: "veg" for a green mark or "Veg", "non_veg" for a red or brown mark or a meat or',
  'fish dish clearly marked so, "egg" for egg dishes; null when the menu does not say.',
  'Spice level 0 to 3 only when the menu shows chillies or says so; otherwise null.',
  'Priced extras offered with many dishes ("Add cheese 40") go in add_ons, not as dishes.',
  'Where you cannot read something with confidence, still record your best reading and say what',
  'is uncertain in "unsure". Put remarks about the whole menu in notes.',
  'If the files show no restaurant menu, set found_menu to false and leave sections empty.',
].join(' ');

const nullable = (type: string) => ({ type: [type, 'null'] });

/** The tool's input schema (JSON Schema), which the model must fill in. */
export const RECORD_MENU_SCHEMA = {
  type: 'object',
  properties: {
    found_menu: { type: 'boolean' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          dishes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: nullable('string'),
                price: { ...nullable('string'), description: 'Rupees as printed, e.g. "249.50"' },
                sizes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { name: { type: 'string' }, price: { type: 'string' } },
                    required: ['name', 'price'],
                  },
                },
                food_type: { ...nullable('string'), enum: ['veg', 'non_veg', 'egg', null] },
                spice_level: { ...nullable('integer'), minimum: 0, maximum: 3 },
                tags: { type: 'array', items: { type: 'string' } },
                unsure: nullable('string'),
              },
              required: ['name', 'price', 'sizes', 'food_type'],
            },
          },
        },
        required: ['name', 'dishes'],
      },
    },
    add_ons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, price: { type: 'string' } },
              required: ['name', 'price'],
            },
          },
        },
        required: ['group', 'options'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['found_menu', 'sections', 'add_ons', 'notes'],
} as const;

/**
 * Paise from a printed rupee amount: "249", "249.50", "₹ 1,249/-", "Rs. 85.5". Undefined when there
 * is no amount, or more than ₹99,99,999.
 */
export function paiseOf(printed: unknown): number | undefined {
  if (typeof printed !== 'string' && typeof printed !== 'number') return undefined;
  const text = String(printed).replace(/,/g, '');
  const match = /(\d{1,8})(?:\.(\d{1,2}))?/.exec(text);
  if (match === null) return undefined;
  const rupees = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return rupees * 100 + Number(fraction);
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const FOOD_TYPES: Readonly<Record<string, MenuDraftItem['foodType']>> = {
  veg: 'VEG',
  non_veg: 'NON_VEG',
  egg: 'EGG',
};

function itemOf(raw: unknown): MenuDraftItem | undefined {
  const dish = record(raw);
  const name = text(dish.name, 80);
  if (name === null) return undefined;
  const variants = list(dish.sizes).flatMap((size) => {
    const entry = record(size);
    const variantName = text(entry.name, 40);
    const price = paiseOf(entry.price);
    return variantName === null || price === undefined ? [] : [{ name: variantName, price }];
  });
  const spice = dish.spice_level;
  const notes = [text(dish.unsure, 200)];
  const price = paiseOf(dish.price);
  if (price === undefined && variants.length === 0) notes.push('No price found.');
  return {
    name,
    description: text(dish.description, 500),
    price: price ?? null,
    variants: variants.slice(0, 10),
    foodType: typeof dish.food_type === 'string' ? (FOOD_TYPES[dish.food_type] ?? null) : null,
    spiceLevel:
      typeof spice === 'number' && Number.isInteger(spice) && spice >= 0 && spice <= 3
        ? spice
        : null,
    tags: [...new Set(list(dish.tags).flatMap((tag) => text(tag, 30) ?? []))].slice(0, 10),
    note: text(notes.filter((note): note is string => note !== null).join(' '), 200),
  };
}

/** The draft from the model's tool input, or undefined when it found no menu. */
export function draftFromReading(input: unknown): MenuDraft | undefined {
  const reading = record(input);
  const categories = list(reading.sections)
    .flatMap((raw) => {
      const section = record(raw);
      const items = list(section.dishes).flatMap((dish) => itemOf(dish) ?? []);
      return items.length === 0
        ? []
        : [{ name: text(section.name, 60) ?? 'Menu', items: items.slice(0, 500) }];
    })
    .slice(0, 60);
  if (reading.found_menu === false || categories.length === 0) return undefined;
  const addOns = list(reading.add_ons)
    .flatMap((raw) => {
      const addOn = record(raw);
      const group = text(addOn.group, 60);
      const options = list(addOn.options).flatMap((option) => {
        const entry = record(option);
        const name = text(entry.name, 60);
        const price = paiseOf(entry.price);
        return name === null || price === undefined ? [] : [{ name, price }];
      });
      return group === null || options.length === 0
        ? []
        : [{ group, options: options.slice(0, 30) }];
    })
    .slice(0, 30);
  const notes = list(reading.notes)
    .flatMap((note) => text(note, 300) ?? [])
    .slice(0, 20);
  return MenuDraft.parse({ categories, addOns, notes });
}
