import { describe, expect, it } from 'vitest';
import {
  MENU_IMPORT_COLUMNS,
  type MenuImportContext,
  type MenuImportIssue,
  type MenuImportSheets,
  parseFoodType,
  planMenuImport,
} from '../src/index.js';

const CONTEXT: MenuImportContext = {
  taxGroups: [{ id: 'tax-5', name: 'GST 5 %' }],
  stations: [
    { id: 'st-tandoor', name: 'Tandoor' },
    { id: 'st-bar', name: 'Bar' },
  ],
  categories: [{ id: 'cat-starters', name: 'Starters', parentId: null, displayOrder: 1 }],
  modifierGroups: [{ id: 'grp-spice', name: 'Spice level' }],
  items: [
    { id: 'item-lassi', name: 'Sweet Lassi', shortCode: 'LS', isCombo: false },
    { id: 'item-thali', name: 'Old Thali', shortCode: null, isCombo: true },
  ],
};

const ITEMS_HEADER = MENU_IMPORT_COLUMNS.Items.map((column) => column.name);
const item = (cells: Partial<Record<string, string>>) =>
  ITEMS_HEADER.map((name) => cells[name] ?? '');

const base = {
  Category: 'Starters',
  'Tax group': 'gst 5 %',
  'Food type': 'Veg',
  Station: 'tandoor',
};

function issuesOf(sheets: MenuImportSheets): MenuImportIssue[] {
  const result = planMenuImport(sheets, CONTEXT);
  if (result.ok) throw new Error('Expected issues');
  return [...result.issues];
}

describe('[ONB-005] [MENU-011] planning a menu import', () => {
  it('plans categories, groups, items with variants and synonyms, and combos', () => {
    const result = planMenuImport(
      {
        Items: [
          ITEMS_HEADER,
          // The template's notes row is skipped.
          MENU_IMPORT_COLUMNS.Items.map((column) => (column.required ? 'Required' : 'Optional')),
          item({
            ...base,
            'Sub-category': 'Tandoor',
            Item: 'Paneer Tikka',
            'Short code': 'PT',
            Price: '',
            Tags: 'Bestseller, Jain',
            Synonyms: 'panir, cottage cheese',
            'Modifier groups': 'Dip, Spice level',
            'Spice level': '2',
            'Prep minutes': '15',
            Channels: 'POS, Waiter app',
          }),
          item({ ...base, Category: 'Drinks', Item: 'Masala Chai', Price: '40', Station: 'Bar' }),
          item({ ...base, Category: 'Drinks', Item: 'Cold Coffee', Price: '90', Station: 'Bar' }),
          item({
            ...base,
            Category: 'Combos',
            Item: 'Tikka Meal',
            Price: '399',
            'Food type': 'non veg',
            Repeatable: 'yes',
          }),
          ['', '', ''],
        ],
        Variants: [
          ['Item', 'Variant', 'Price', 'External ID'],
          ['Paneer Tikka', 'Half', '180', ''],
          ['Paneer Tikka', 'Full', '320.50', 'ZOM-1'],
        ],
        Modifiers: [
          ['Group', 'Min', 'Max', 'Option', 'Price change'],
          ['Dip', '0', '2', 'Mint', ''],
          ['Dip', '', '', 'Garlic', '15'],
          ['Dip', '0', '2', 'No onion', '-5'],
        ],
        Combos: [
          [
            'Combo',
            'Part',
            'Items',
            'Label',
            'Quantity',
            'Active from',
            'Active until',
            'Starts at',
            'Ends at',
          ],
          [
            'Tikka Meal',
            'Item',
            'Paneer Tikka',
            '',
            '',
            '20-10-2026',
            '2026-11-05',
            '7:00',
            '11:30',
          ],
          ['Tikka Meal', 'Choice', 'Masala Chai | Cold Coffee | Sweet Lassi', 'Any 1 drink', '2'],
        ],
      },
      CONTEXT,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.summary).toEqual({
      categories: 3,
      modifierGroups: 1,
      items: 4,
      variants: 2,
      combos: 1,
    });
    const { categories, items, modifierGroups, combos } = result.plan;
    expect(categories).toEqual([
      {
        key: 'category:starters/tandoor',
        name: 'Tandoor',
        parent: { existingId: 'cat-starters' },
        displayOrder: 2,
      },
      { key: 'category:drinks', name: 'Drinks', parent: null, displayOrder: 3 },
      { key: 'category:combos', name: 'Combos', parent: null, displayOrder: 4 },
    ]);
    expect(modifierGroups).toEqual([
      {
        key: 'group:dip',
        name: 'Dip',
        minSelections: 0,
        maxSelections: 2,
        options: [
          { name: 'Mint', priceDelta: 0 },
          { name: 'Garlic', priceDelta: 1_500 },
          { name: 'No onion', priceDelta: -500 },
        ],
      },
    ]);
    expect(items[0]).toMatchObject({
      name: 'Paneer Tikka',
      category: { newKey: 'category:starters/tandoor' },
      // No price: the lowest variant's.
      basePrice: 18_000,
      taxGroupId: 'tax-5',
      stationId: 'st-tandoor',
      foodType: 'VEG',
      spiceLevel: 2,
      prepTimeMinutes: 15,
      channels: ['POS', 'WAITER_APP'],
      tags: ['Bestseller', 'Jain'],
      synonyms: ['panir', 'cottage cheese'],
      modifierGroups: [{ newKey: 'group:dip' }, { existingId: 'grp-spice' }],
      variants: [
        { name: 'Half', price: 18_000, externalId: null },
        { name: 'Full', price: 32_050, externalId: 'ZOM-1' },
      ],
      repeatable: false,
      displayOrder: 1,
    });
    expect(items[1]).toMatchObject({
      name: 'Masala Chai',
      channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
      prepTimeMinutes: null,
      displayOrder: 1,
    });
    expect(items[2]).toMatchObject({ name: 'Cold Coffee', displayOrder: 2 });
    expect(items[3]).toMatchObject({ foodType: 'NON_VEG', repeatable: true });
    expect(combos).toEqual([
      {
        itemKey: 'item:tikka meal',
        components: [
          { kind: 'FIXED', item: { newKey: 'item:paneer tikka' }, quantity: 1 },
          {
            kind: 'CHOICE',
            label: 'Any 1 drink',
            items: [
              { newKey: 'item:masala chai' },
              { newKey: 'item:cold coffee' },
              { existingId: 'item-lassi' },
            ],
            quantity: 2,
          },
        ],
        activeFrom: '2026-10-20',
        activeUntil: '2026-11-05',
        timeWindow: { start: '07:00', end: '11:30' },
      },
    ]);
  });

  it('lists every problem with its sheet, row and column, and plans nothing', () => {
    const issues = issuesOf({
      Items: [
        [...ITEMS_HEADER, 'Colour'],
        item({ ...base, Item: 'Sweet Lassi', Price: '60' }),
        item({
          ...base,
          Item: 'Aloo Tikki',
          Price: '12,0.5.0',
          'Tax group': 'GST 18',
          'Short code': 'ls',
        }),
        item({ ...base, Item: 'Aloo Tikki', Price: '80' }),
        item({
          Item: 'Bad Row',
          Price: '10',
          'Food type': 'Vegan',
          'Spice level': '5',
          Channels: 'Fax',
        }),
        item({
          ...base,
          Item: 'Kulcha',
          Price: '50',
          'Modifier groups': 'Nope',
          Repeatable: 'maybe',
        }),
      ],
      Variants: [
        ['Item', 'Variant', 'Price'],
        ['Sweet Lassi', 'Large', '80'],
        ['Unknown', 'Large', '80'],
      ],
      Modifiers: [
        ['Group', 'Min', 'Max', 'Option'],
        ['Spice level', '1', '1', 'Hot'],
        ['Toppings', '3', '2', 'Cheese'],
        ['Toppings', '3', '1', 'Cheese'],
      ],
      Combos: [
        ['Combo', 'Part', 'Items'],
        ['Kulcha', 'Choice', 'Old Thali'],
        ['Kulcha', 'Bundle', 'Aloo Tikki'],
      ],
    });
    const found = issues.map(
      ({ sheet, row, column }) => `${sheet}:${String(row)}:${String(column)}`,
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'Items:1:Colour',
        'Items:2:Item',
        'Items:3:Price',
        'Items:3:Tax group',
        'Items:3:Short code',
        'Items:4:Item',
        'Items:5:Category',
        'Items:5:Tax group',
        'Items:5:Station',
        'Items:5:Food type',
        'Items:5:Spice level',
        'Items:5:Channels',
        'Items:6:Modifier groups',
        'Items:6:Repeatable',
        'Variants:2:Item',
        'Variants:3:Item',
        'Modifiers:2:Group',
        'Modifiers:3:Min',
        'Modifiers:4:Max',
        'Modifiers:4:Option',
        'Combos:2:Label',
        'Combos:2:Items',
        'Combos:3:Part',
      ]),
    );
    expect(issues.find((entry) => entry.row === 2 && entry.sheet === 'Items')?.message).toBe(
      '"Sweet Lassi" is already on the menu; change it in the menu editor',
    );
    // Sorted by sheet, then row.
    expect(issues[0]?.sheet).toBe('Items');
    expect(issues.at(-1)?.sheet).toBe('Combos');
  });

  it('reports a missing Items sheet, missing columns and an empty import', () => {
    expect(issuesOf({})).toEqual([
      { sheet: 'Items', row: null, column: null, message: 'The Items sheet is missing' },
    ]);
    expect(issuesOf({ Items: [['Item', 'Price']] }).map((entry) => entry.column)).toEqual([
      'Category',
      'Tax group',
      'Food type',
      'Station',
    ]);
    expect(issuesOf({ Items: [ITEMS_HEADER] })).toEqual([
      { sheet: 'Items', row: null, column: null, message: 'No items to import' },
    ]);
  });

  it('checks combo dates, times and parts', () => {
    const sheets = (rows: string[][]): MenuImportSheets => ({
      Items: [
        ITEMS_HEADER,
        item({ ...base, Item: 'Meal', Price: '100' }),
        item({ ...base, Item: 'Roti', Price: '10' }),
      ],
      Combos: [
        [
          'Combo',
          'Part',
          'Items',
          'Label',
          'Quantity',
          'Active from',
          'Active until',
          'Starts at',
          'Ends at',
        ],
        ...rows,
      ],
    });
    const columns = (rows: string[][]) =>
      issuesOf(sheets(rows)).map((entry) => `${String(entry.column)}: ${entry.message}`);
    expect(
      columns([['Meal', 'Item', 'Roti', '', '', '31-02-2026', '2026-13-01', '25:00', '9']]),
    ).toEqual([
      'Active from: A date, YYYY-MM-DD',
      'Active until: A date, YYYY-MM-DD',
      'Starts at: A time, HH:MM',
      'Ends at: A time, HH:MM',
    ]);
    expect(
      columns([['Meal', 'Item', 'Roti', '', '', '2026-11-05', '2026-10-01', '10:00', '']]),
    ).toEqual([
      'Active until: The combo must start before it ends',
      'Ends at: Give both times or neither',
    ]);
    expect(columns([['Meal', 'Item', 'Roti | Meal', '', '0']])).toEqual([
      'Items: A fixed part names one item; use Choice for several',
      'Quantity: A whole number from 1 to 20',
    ]);
    expect(columns([['Meal', 'Choice', 'Meal | Roti', 'Any']])).toEqual([
      'Items: "Meal" is a combo; a combo cannot hold another',
    ]);
    expect(
      columns([
        ['Nope', 'Item', 'Roti'],
        ['Meal', 'Item', ''],
      ]),
    ).toEqual(['Combo: "Nope" is not in the Items sheet', 'Items: Required']);
  });

  it('checks lists, lengths, variant limits and short codes', () => {
    const tags = Array.from({ length: 21 }, (_, index) => `t${String(index)}`).join(',');
    const issues = issuesOf({
      Items: [
        ITEMS_HEADER,
        item({ ...base, Item: 'A'.repeat(81), Price: '1' }),
        item({ ...base, Item: 'Tagged', Price: '1', Tags: tags, Synonyms: 'x, X' }),
        item({
          ...base,
          Item: 'Long words',
          Price: '1',
          Tags: 'y'.repeat(31),
          'Short code': 'bad code',
        }),
        item({ ...base, Item: 'Dear', Price: '100001' }),
        item({
          ...base,
          Item: 'Grouped',
          Price: '1',
          'Modifier groups': 'Spice level, spice level',
        }),
        item({ ...base, Item: 'Coded', Price: '1', 'Short code': 'CD' }),
        item({ ...base, Item: 'Coded again', Price: '1', 'Short code': 'cd' }),
      ],
      Variants: [
        ['Item', 'Variant', 'Price'],
        ...Array.from({ length: 11 }, (_, index) => ['Coded', `V${String(index)}`, '10']),
        ['Coded', 'v1', '10'],
      ],
    });
    expect(
      issues.map((entry) => `${String(entry.row)} ${String(entry.column)}: ${entry.message}`),
    ).toEqual([
      '2 Item: At most 80 characters',
      '3 Tags: At most 20 entries',
      '3 Synonyms: An entry is listed twice',
      '4 Short code: Letters, digits and dashes, up to 12',
      '4 Tags: Each entry at most 30 characters',
      '5 Price: At most ₹1,00,000',
      '6 Modifier groups: A group is listed twice',
      '8 Short code: "Coded" already has this short code',
      '12 Variant: An item has at most 10 variants',
      '13 Variant: "v1" is listed twice for this item',
    ]);
  });

  it('reads food types loosely', () => {
    expect(['Veg', 'Non-Veg', 'non veg', 'EGG', 'Vegan'].map(parseFoodType)).toEqual([
      'VEG',
      'NON_VEG',
      'NON_VEG',
      'EGG',
      null,
    ]);
  });
});
