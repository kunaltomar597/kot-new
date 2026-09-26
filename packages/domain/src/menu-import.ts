import { DomainError } from './errors.js';
import { type Paise, parseRupees } from './money.js';

/**
 * Menu import from the vendor template (P1-05, ONB-005, MENU-011): four sheets (Items, Variants,
 * Modifiers, Combos) read as rows of text, checked against the restaurant's existing setup, and
 * turned into a plan the server writes in one transaction. Every problem is reported with its
 * sheet, row and column before anything is written.
 *
 * What the import does: it adds new categories, modifier groups, items with variants, and combos.
 * Existing categories, modifier groups and items can be referred to by name; existing tax groups
 * and kitchen stations must be referred to by name. It never changes or archives anything that
 * exists: an item already on the menu is reported, and is edited in the menu editor instead.
 */

export const MENU_IMPORT_SHEETS = ['Items', 'Variants', 'Modifiers', 'Combos'] as const;
export type MenuImportSheet = (typeof MENU_IMPORT_SHEETS)[number];

interface ColumnSpec {
  readonly name: string;
  readonly required: boolean;
  /** What the template's notes row says about the column. */
  readonly hint: string;
}

const column = (name: string, required: boolean, hint: string): ColumnSpec => ({
  name,
  required,
  hint,
});

/** The template's columns, in order. A sheet may put them in any order; names are matched loosely. */
export const MENU_IMPORT_COLUMNS: Readonly<Record<MenuImportSheet, readonly ColumnSpec[]>> = {
  Items: [
    column('Category', true, 'Top-level category, e.g. Starters'),
    column('Sub-category', false, 'Optional, one level under the category'),
    column('Item', true, 'Item name, unique on the menu'),
    column('Short code', false, 'Quick code for the POS: letters, digits, dash; up to 12'),
    column('Description', false, 'Up to 500 characters'),
    column('Price', true, 'In rupees, e.g. 250 or 249.50; may be blank when the item has variants'),
    column('Tax group', true, 'Name of a tax group set up in the restaurant, e.g. GST 5 %'),
    column('Food type', true, 'Veg, Non-veg or Egg'),
    column('Spice level', false, '0 to 3; blank is 0'),
    column('Tags', false, "Comma separated, e.g. Jain, Bestseller, Chef's special"),
    column('Station', true, 'Kitchen station name, e.g. Tandoor'),
    column('Prep minutes', false, 'Estimated preparation time, 0 to 240'),
    column('Channels', false, 'Comma separated: POS, Waiter app, Tablet, QR; blank is all'),
    column('Synonyms', false, 'Comma separated search words, e.g. panir, cottage cheese'),
    column('Modifier groups', false, 'Comma separated group names from the Modifiers sheet'),
    column('Repeatable', false, 'Yes if it may be recommended again when already ordered'),
    column('External ID', false, 'Your own reference, e.g. from an aggregator'),
  ],
  Variants: [
    column('Item', true, 'Item name from the Items sheet'),
    column('Variant', true, 'e.g. Half, Full, Regular, Large'),
    column('Price', true, 'In rupees'),
    column('External ID', false, 'Your own reference'),
  ],
  Modifiers: [
    column('Group', true, 'Group name, e.g. Roti type; one row per option'),
    column('Min', true, 'Fewest choices, 0 for optional (first row of the group)'),
    column('Max', true, 'Most choices, 1 to 20 (first row of the group)'),
    column('Option', true, 'e.g. Butter, Plain'),
    column('Price change', false, 'In rupees; negative takes off; blank is 0'),
  ],
  Combos: [
    column('Combo', true, 'Combo item name from the Items sheet; its price is the combo price'),
    column('Part', true, 'Item for a fixed part, Choice for "any one of"'),
    column('Items', true, 'One item name, or for a choice two or more separated by |'),
    column('Label', false, 'For a choice, e.g. Any 1 beverage'),
    column('Quantity', false, '1 to 20; blank is 1'),
    column('Active from', false, 'Optional start date, YYYY-MM-DD (first row of the combo)'),
    column('Active until', false, 'Optional end date, YYYY-MM-DD'),
    column('Starts at', false, 'Optional daily start time, HH:MM'),
    column('Ends at', false, 'Optional daily end time, HH:MM; before the start runs past midnight'),
  ],
};

/** Row limits keep an import bounded (ONB-009 plans for 150 items). */
export const MENU_IMPORT_MAX_ROWS = 2_000;

export type ImportFoodType = 'VEG' | 'NON_VEG' | 'EGG';
export type ImportChannel = 'POS' | 'WAITER_APP' | 'TABLE_TABLET' | 'QR';
const ALL_CHANNELS: readonly ImportChannel[] = ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'];

/** The restaurant as it is, for resolving names (active records only). */
export interface MenuImportContext {
  readonly taxGroups: readonly { id: string; name: string }[];
  readonly stations: readonly { id: string; name: string }[];
  readonly categories: readonly {
    id: string;
    name: string;
    parentId: string | null;
    displayOrder: number;
  }[];
  readonly modifierGroups: readonly { id: string; name: string }[];
  readonly items: readonly {
    id: string;
    name: string;
    shortCode: string | null;
    isCombo: boolean;
  }[];
}

export interface MenuImportIssue {
  readonly sheet: MenuImportSheet;
  /** The spreadsheet row number (the header is row 1); null for the whole sheet. */
  readonly row: number | null;
  readonly column: string | null;
  readonly message: string;
}

/** A category, group or item: one that exists, or one the plan creates (by its key). */
export type ImportRef = { readonly existingId: string } | { readonly newKey: string };

export interface PlannedCategory {
  readonly key: string;
  readonly name: string;
  readonly parent: ImportRef | null;
  readonly displayOrder: number;
}

export interface PlannedModifierGroup {
  readonly key: string;
  readonly name: string;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly options: readonly { name: string; priceDelta: Paise }[];
}

export interface PlannedItem {
  readonly key: string;
  readonly row: number;
  readonly category: ImportRef;
  readonly name: string;
  readonly shortCode: string | null;
  readonly description: string | null;
  readonly basePrice: Paise;
  readonly taxGroupId: string;
  readonly foodType: ImportFoodType;
  readonly spiceLevel: number;
  readonly tags: readonly string[];
  readonly stationId: string;
  readonly prepTimeMinutes: number | null;
  readonly displayOrder: number;
  readonly channels: readonly ImportChannel[];
  readonly variants: readonly { name: string; price: Paise; externalId: string | null }[];
  readonly modifierGroups: readonly ImportRef[];
  readonly synonyms: readonly string[];
  readonly repeatable: boolean;
  readonly externalId: string | null;
}

export type PlannedComboComponent =
  | { readonly kind: 'FIXED'; readonly item: ImportRef; readonly quantity: number }
  | {
      readonly kind: 'CHOICE';
      readonly label: string;
      readonly items: readonly ImportRef[];
      readonly quantity: number;
    };

export interface PlannedCombo {
  /** The combo item, always one of the plan's new items. */
  readonly itemKey: string;
  readonly components: readonly PlannedComboComponent[];
  readonly activeFrom: string | null;
  readonly activeUntil: string | null;
  readonly timeWindow: { readonly start: string; readonly end: string } | null;
}

export interface MenuImportPlan {
  readonly categories: readonly PlannedCategory[];
  readonly modifierGroups: readonly PlannedModifierGroup[];
  readonly items: readonly PlannedItem[];
  readonly combos: readonly PlannedCombo[];
}

export interface MenuImportSummary {
  readonly categories: number;
  readonly modifierGroups: number;
  readonly items: number;
  readonly variants: number;
  readonly combos: number;
}

export type MenuImportResult =
  | { readonly ok: true; readonly plan: MenuImportPlan; readonly summary: MenuImportSummary }
  | { readonly ok: false; readonly issues: readonly MenuImportIssue[] };

/** Raw sheets: rows of cell text, the header first. Only Items is required. */
export type MenuImportSheets = Partial<Record<MenuImportSheet, readonly (readonly string[])[]>>;

const fold = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const headerKey = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '');
const splitList = (text: string, separator: string | RegExp) =>
  text
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part !== '');

interface SheetRow {
  readonly row: number;
  get(column: string): string;
}

/** Plans an import, or lists every problem found. */
export function planMenuImport(
  sheets: MenuImportSheets,
  context: MenuImportContext,
): MenuImportResult {
  const issues: MenuImportIssue[] = [];
  const issue = (
    sheet: MenuImportSheet,
    row: number | null,
    columnName: string | null,
    message: string,
  ) => {
    issues.push({ sheet, row, column: columnName, message });
  };

  const rowsOf = (sheet: MenuImportSheet): SheetRow[] => {
    const raw = sheets[sheet];
    if (raw === undefined) {
      if (sheet === 'Items') issue(sheet, null, null, 'The Items sheet is missing');
      return [];
    }
    const [header = [], ...body] = raw;
    const known = new Map(MENU_IMPORT_COLUMNS[sheet].map((spec) => [headerKey(spec.name), spec]));
    const positions = new Map<string, number>();
    header.forEach((cell, index) => {
      const spec = known.get(headerKey(cell));
      if (spec !== undefined && !positions.has(spec.name)) positions.set(spec.name, index);
      else if (cell.trim() !== '' && spec === undefined) {
        issue(sheet, 1, cell.trim(), 'Unknown column; use the template’s column names');
      }
    });
    for (const spec of MENU_IMPORT_COLUMNS[sheet]) {
      if (spec.required && !positions.has(spec.name)) {
        issue(sheet, 1, spec.name, 'This column is missing');
      }
    }
    const rows: SheetRow[] = [];
    body.forEach((cells, index) => {
      if (cells.every((cell) => cell.trim() === '')) return;
      // The template's second row explains each column; it is skipped.
      if (index === 0 && cells.some((cell) => cell.trim().startsWith('Required'))) return;
      rows.push({
        row: index + 2,
        get: (name) => {
          const position = positions.get(name);
          return position === undefined ? '' : (cells[position] ?? '').trim();
        },
      });
    });
    if (rows.length > MENU_IMPORT_MAX_ROWS) {
      issue(sheet, null, null, `More than ${String(MENU_IMPORT_MAX_ROWS)} rows`);
      return [];
    }
    return rows;
  };

  const text = (
    sheet: MenuImportSheet,
    row: SheetRow,
    name: string,
    options: { required: boolean; max: number },
  ): string | null => {
    const value = row.get(name);
    if (value === '') {
      if (options.required) issue(sheet, row.row, name, 'Required');
      return null;
    }
    if (value.length > options.max) {
      issue(sheet, row.row, name, `At most ${String(options.max)} characters`);
      return null;
    }
    return value;
  };

  const rupees = (
    sheet: MenuImportSheet,
    row: SheetRow,
    name: string,
    options: { required: boolean; allowNegative?: boolean },
  ): Paise | null => {
    const value = row.get(name);
    if (value === '') {
      if (options.required) issue(sheet, row.row, name, 'Required');
      return null;
    }
    try {
      const paise = parseRupees(value, { allowNegative: options.allowNegative ?? false });
      if (Math.abs(paise) > 10_000_000) {
        issue(sheet, row.row, name, 'At most ₹1,00,000');
        return null;
      }
      return paise;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issue(sheet, row.row, name, `"${value}" is not an amount in rupees, e.g. 250 or 249.50`);
      return null;
    }
  };

  const whole = (
    sheet: MenuImportSheet,
    row: SheetRow,
    name: string,
    range: { min: number; max: number; blank: number | null },
  ): number | null => {
    const value = row.get(name);
    if (value === '') {
      if (range.blank === null) issue(sheet, row.row, name, 'Required');
      return range.blank;
    }
    const number = Number(value);
    if (!/^\d+$/.test(value) || number < range.min || number > range.max) {
      issue(
        sheet,
        row.row,
        name,
        `A whole number from ${String(range.min)} to ${String(range.max)}`,
      );
      return null;
    }
    return number;
  };

  const byName = <T extends { name: string }>(entries: readonly T[]) =>
    new Map(entries.map((entry) => [fold(entry.name), entry]));
  const taxGroups = byName(context.taxGroups);
  const stations = byName(context.stations);
  const existingGroups = byName(context.modifierGroups);
  const existingItems = byName(context.items);

  // ------------------------------------------------------------ modifier groups
  const groups = new Map<string, { key: string; row: number; group: PlannedModifierGroup }>();
  const modifierRows = rowsOf('Modifiers');
  const groupRows = new Map<string, SheetRow[]>();
  for (const row of modifierRows) {
    const name = text('Modifiers', row, 'Group', { required: true, max: 60 });
    if (name === null) continue;
    const key = fold(name);
    groupRows.set(key, [...(groupRows.get(key) ?? []), row]);
  }
  for (const [key, rows] of groupRows) {
    const first = rows[0];
    if (first === undefined) continue;
    const name = first.get('Group');
    if (existingGroups.has(key)) {
      issue('Modifiers', first.row, 'Group', `"${name}" already exists; use another name`);
      continue;
    }
    const min = whole('Modifiers', first, 'Min', { min: 0, max: 20, blank: null });
    const max = whole('Modifiers', first, 'Max', { min: 1, max: 20, blank: null });
    for (const row of rows.slice(1)) {
      for (const [columnName, value] of [
        ['Min', min],
        ['Max', max],
      ] as const) {
        const cell = row.get(columnName);
        if (cell !== '' && value !== null && cell !== String(value)) {
          issue('Modifiers', row.row, columnName, 'Differs from the group’s first row');
        }
      }
    }
    const options: { name: string; priceDelta: Paise }[] = [];
    const seen = new Set<string>();
    let valid = min !== null && max !== null;
    for (const row of rows) {
      const option = text('Modifiers', row, 'Option', { required: true, max: 60 });
      const delta = rupees('Modifiers', row, 'Price change', {
        required: false,
        allowNegative: true,
      });
      if (option === null) {
        valid = false;
        continue;
      }
      if (seen.has(fold(option))) {
        issue('Modifiers', row.row, 'Option', `"${option}" is listed twice in this group`);
        valid = false;
        continue;
      }
      seen.add(fold(option));
      if (row.get('Price change') !== '' && delta === null) valid = false;
      options.push({ name: option, priceDelta: delta ?? 0 });
    }
    if (options.length > 50) {
      issue('Modifiers', first.row, 'Option', 'A group has at most 50 options');
      valid = false;
    }
    if (min !== null && max !== null && min > max) {
      issue('Modifiers', first.row, 'Min', 'The minimum is above the maximum');
      valid = false;
    }
    if (min !== null && min > options.length) {
      issue('Modifiers', first.row, 'Min', 'The minimum is more than the options there are');
      valid = false;
    }
    if (valid && min !== null && max !== null) {
      const groupKey = `group:${key}`;
      groups.set(key, {
        key: groupKey,
        row: first.row,
        group: { key: groupKey, name, minSelections: min, maxSelections: max, options },
      });
    }
  }

  // ------------------------------------------------------------ categories and items
  const categories = new Map<string, PlannedCategory>();
  const existingTop = new Map(
    context.categories
      .filter((category) => category.parentId === null)
      .map((category) => [fold(category.name), category]),
  );
  const existingSub = new Map(
    context.categories
      .filter((category) => category.parentId !== null)
      .map((category) => [`${category.parentId ?? ''}/${fold(category.name)}`, category]),
  );
  let nextOrder = Math.max(0, ...context.categories.map((category) => category.displayOrder));
  const categoryRef = (top: string, sub: string | null): ImportRef => {
    const topKey = fold(top);
    const existing = existingTop.get(topKey);
    let parent: ImportRef;
    if (existing !== undefined) {
      parent = { existingId: existing.id };
    } else {
      const key = `category:${topKey}`;
      if (!categories.has(key)) {
        nextOrder += 1;
        categories.set(key, { key, name: top, parent: null, displayOrder: nextOrder });
      }
      parent = { newKey: key };
    }
    if (sub === null) return parent;
    if ('existingId' in parent) {
      const existingChild = existingSub.get(`${parent.existingId}/${fold(sub)}`);
      if (existingChild !== undefined) return { existingId: existingChild.id };
    }
    const key = `category:${topKey}/${fold(sub)}`;
    if (!categories.has(key)) {
      nextOrder += 1;
      categories.set(key, { key, name: sub, parent, displayOrder: nextOrder });
    }
    return { newKey: key };
  };

  interface ItemDraft extends Omit<PlannedItem, 'variants' | 'basePrice'> {
    basePrice: Paise | null;
    /** The price cell had something in it (a bad value is already reported). */
    priceGiven: boolean;
    variants: { name: string; price: Paise; externalId: string | null }[];
  }
  const items = new Map<string, ItemDraft>();
  const shortCodes = new Map(
    context.items
      .filter((item) => item.shortCode !== null)
      .map((item) => [fold(item.shortCode ?? ''), item.name]),
  );
  const orderInCategory = new Map<string, number>();
  /** Every item name in the sheet, valid or not, so other sheets do not repeat its errors. */
  const listedItems = new Set<string>();
  for (const row of rowsOf('Items')) {
    const name = text('Items', row, 'Item', { required: true, max: 80 });
    const top = text('Items', row, 'Category', { required: true, max: 60 });
    const sub = text('Items', row, 'Sub-category', { required: false, max: 60 });
    const shortCode = row.get('Short code');
    const description = text('Items', row, 'Description', { required: false, max: 500 });
    const price = rupees('Items', row, 'Price', { required: false });
    const taxName = row.get('Tax group');
    const tax = taxGroups.get(fold(taxName));
    if (taxName === '') issue('Items', row.row, 'Tax group', 'Required');
    else if (tax === undefined) {
      issue('Items', row.row, 'Tax group', `No tax group is called "${taxName}"`);
    }
    const stationName = row.get('Station');
    const station = stations.get(fold(stationName));
    if (stationName === '') issue('Items', row.row, 'Station', 'Required');
    else if (station === undefined) {
      issue('Items', row.row, 'Station', `No kitchen station is called "${stationName}"`);
    }
    const foodType = parseFoodType(row.get('Food type'));
    if (foodType === null) issue('Items', row.row, 'Food type', 'Veg, Non-veg or Egg');
    const spice = whole('Items', row, 'Spice level', { min: 0, max: 3, blank: 0 });
    const prep = whole('Items', row, 'Prep minutes', { min: 0, max: 240, blank: -1 });
    const channels = parseChannels(row.get('Channels'));
    if (channels === null) {
      issue('Items', row.row, 'Channels', 'Use POS, Waiter app, Tablet and QR, comma separated');
    }
    const repeatable = parseYesNo(row.get('Repeatable'));
    if (repeatable === null) issue('Items', row.row, 'Repeatable', 'Yes or No');
    const externalId = text('Items', row, 'External ID', { required: false, max: 128 });
    const tags = listOf('Items', row, 'Tags', { max: 30, count: 20 });
    const synonyms = listOf('Items', row, 'Synonyms', { max: 40, count: 20 });
    const groupRefs: ImportRef[] = [];
    for (const groupName of splitList(row.get('Modifier groups'), ',')) {
      const planned = groups.get(fold(groupName));
      const existing = existingGroups.get(fold(groupName));
      if (planned !== undefined) groupRefs.push({ newKey: planned.key });
      else if (existing !== undefined) groupRefs.push({ existingId: existing.id });
      else if (!groupRows.has(fold(groupName))) {
        issue('Items', row.row, 'Modifier groups', `No modifier group is called "${groupName}"`);
      }
    }
    if (groupRefs.length > 10) {
      issue('Items', row.row, 'Modifier groups', 'At most 10 groups per item');
    }
    if (new Set(groupRefs.map((ref) => JSON.stringify(ref))).size !== groupRefs.length) {
      issue('Items', row.row, 'Modifier groups', 'A group is listed twice');
    }
    if (shortCode !== '' && !/^[A-Za-z0-9-]{1,12}$/.test(shortCode)) {
      issue('Items', row.row, 'Short code', 'Letters, digits and dashes, up to 12');
    } else if (shortCode !== '') {
      const clash = shortCodes.get(fold(shortCode));
      if (clash !== undefined) {
        issue('Items', row.row, 'Short code', `"${clash}" already has this short code`);
      }
      shortCodes.set(fold(shortCode), name ?? shortCode);
    }
    if (name === null) continue;
    const key = fold(name);
    if (existingItems.has(key)) {
      issue(
        'Items',
        row.row,
        'Item',
        `"${name}" is already on the menu; change it in the menu editor`,
      );
      continue;
    }
    if (listedItems.has(key)) {
      issue('Items', row.row, 'Item', `"${name}" is listed twice`);
      continue;
    }
    listedItems.add(key);
    if (
      top === null ||
      tax === undefined ||
      station === undefined ||
      foodType === null ||
      spice === null ||
      prep === null ||
      channels === null ||
      repeatable === null ||
      tags === null ||
      synonyms === null
    ) {
      continue;
    }
    const category = categoryRef(top, sub);
    const categoryKey = JSON.stringify(category);
    const displayOrder = (orderInCategory.get(categoryKey) ?? 0) + 1;
    orderInCategory.set(categoryKey, displayOrder);
    items.set(key, {
      key: `item:${key}`,
      row: row.row,
      category,
      name,
      shortCode: shortCode === '' ? null : shortCode,
      description,
      basePrice: price,
      priceGiven: row.get('Price') !== '',
      taxGroupId: tax.id,
      foodType,
      spiceLevel: spice,
      tags,
      stationId: station.id,
      prepTimeMinutes: prep === -1 ? null : prep,
      displayOrder,
      channels,
      variants: [],
      modifierGroups: groupRefs,
      synonyms,
      repeatable,
      externalId,
    });
  }

  // ------------------------------------------------------------ variants
  for (const row of rowsOf('Variants')) {
    const itemName = text('Variants', row, 'Item', { required: true, max: 80 });
    const name = text('Variants', row, 'Variant', { required: true, max: 40 });
    const price = rupees('Variants', row, 'Price', { required: true });
    const externalId = text('Variants', row, 'External ID', { required: false, max: 128 });
    if (itemName === null) continue;
    const item = items.get(fold(itemName));
    if (item === undefined && listedItems.has(fold(itemName))) continue;
    if (item === undefined) {
      issue(
        'Variants',
        row.row,
        'Item',
        existingItems.has(fold(itemName))
          ? `"${itemName}" is already on the menu; add its variants in the menu editor`
          : `"${itemName}" is not in the Items sheet`,
      );
      continue;
    }
    if (name === null || price === null) continue;
    if (item.variants.some((variant) => fold(variant.name) === fold(name))) {
      issue('Variants', row.row, 'Variant', `"${name}" is listed twice for this item`);
      continue;
    }
    if (item.variants.length === 10) {
      issue('Variants', row.row, 'Variant', 'An item has at most 10 variants');
      continue;
    }
    item.variants.push({ name, price, externalId });
  }
  for (const item of items.values()) {
    if (item.basePrice === null) {
      if (item.priceGiven) continue;
      if (item.variants.length === 0) issue('Items', item.row, 'Price', 'Required');
      else item.basePrice = Math.min(...item.variants.map((variant) => variant.price));
    }
  }

  // ------------------------------------------------------------ combos
  const comboRows = new Map<string, SheetRow[]>();
  for (const row of rowsOf('Combos')) {
    const name = text('Combos', row, 'Combo', { required: true, max: 80 });
    if (name === null) continue;
    comboRows.set(fold(name), [...(comboRows.get(fold(name)) ?? []), row]);
  }
  const combos: PlannedCombo[] = [];
  const comboKeys = new Set(comboRows.keys());
  const componentRef = (row: SheetRow, itemName: string): ImportRef | null => {
    const key = fold(itemName);
    if (comboKeys.has(key)) {
      issue('Combos', row.row, 'Items', `"${itemName}" is a combo; a combo cannot hold another`);
      return null;
    }
    const planned = items.get(key);
    if (planned !== undefined) return { newKey: planned.key };
    if (listedItems.has(key)) return null;
    const existing = existingItems.get(key);
    if (existing !== undefined && !existing.isCombo) return { existingId: existing.id };
    issue(
      'Combos',
      row.row,
      'Items',
      existing === undefined ? `No item is called "${itemName}"` : `"${itemName}" is a combo`,
    );
    return null;
  };
  for (const [key, rows] of comboRows) {
    const first = rows[0];
    const item = items.get(key);
    if (first === undefined) continue;
    if (item === undefined && !listedItems.has(key)) {
      issue('Combos', first.row, 'Combo', `"${first.get('Combo')}" is not in the Items sheet`);
      continue;
    }
    if (rows.length > 10) issue('Combos', first.row, 'Combo', 'A combo has at most 10 parts');
    const components: PlannedComboComponent[] = [];
    // An item row with its own errors: its parts are still checked, but it is not planned.
    let valid = rows.length <= 10 && item !== undefined;
    for (const row of rows) {
      const part = fold(row.get('Part'));
      const quantity = whole('Combos', row, 'Quantity', { min: 1, max: 20, blank: 1 });
      const names = splitList(row.get('Items'), '|');
      if (names.length === 0) {
        issue('Combos', row.row, 'Items', 'Required');
        valid = false;
        continue;
      }
      if (part === 'item') {
        if (names.length !== 1) {
          issue('Combos', row.row, 'Items', 'A fixed part names one item; use Choice for several');
          valid = false;
          continue;
        }
        const ref = componentRef(row, names[0] ?? '');
        if (ref === null || quantity === null) valid = false;
        else components.push({ kind: 'FIXED', item: ref, quantity });
      } else if (part === 'choice') {
        const label = text('Combos', row, 'Label', { required: true, max: 60 });
        if (names.length < 2 || names.length > 30) {
          issue('Combos', row.row, 'Items', 'A choice lists 2 to 30 items separated by |');
          valid = false;
          continue;
        }
        const refs = names.map((name) => componentRef(row, name));
        if (label === null || quantity === null || refs.some((ref) => ref === null)) valid = false;
        else {
          components.push({
            kind: 'CHOICE',
            label,
            items: refs.filter((ref): ref is ImportRef => ref !== null),
            quantity,
          });
        }
      } else {
        issue('Combos', row.row, 'Part', 'Item or Choice');
        valid = false;
      }
    }
    const activeFrom = dateOf(first.get('Active from'));
    const activeUntil = dateOf(first.get('Active until'));
    const start = timeOf(first.get('Starts at'));
    const end = timeOf(first.get('Ends at'));
    for (const [columnName, value] of [
      ['Active from', activeFrom],
      ['Active until', activeUntil],
      ['Starts at', start],
      ['Ends at', end],
    ] as const) {
      if (value === undefined) {
        issue(
          'Combos',
          first.row,
          columnName,
          columnName.startsWith('Active') ? 'A date, YYYY-MM-DD' : 'A time, HH:MM',
        );
        valid = false;
      }
    }
    if (
      typeof activeFrom === 'string' &&
      typeof activeUntil === 'string' &&
      activeFrom > activeUntil
    ) {
      issue('Combos', first.row, 'Active until', 'The combo must start before it ends');
      valid = false;
    }
    if ((start === null) !== (end === null) && start !== undefined && end !== undefined) {
      issue(
        'Combos',
        first.row,
        start === null ? 'Starts at' : 'Ends at',
        'Give both times or neither',
      );
      valid = false;
    }
    if (valid && item !== undefined && activeFrom !== undefined && activeUntil !== undefined) {
      combos.push({
        itemKey: item.key,
        components,
        activeFrom,
        activeUntil,
        timeWindow: typeof start === 'string' && typeof end === 'string' ? { start, end } : null,
      });
    }
  }

  if (issues.length > 0) {
    issues.sort(
      (a, b) =>
        MENU_IMPORT_SHEETS.indexOf(a.sheet) - MENU_IMPORT_SHEETS.indexOf(b.sheet) ||
        (a.row ?? 0) - (b.row ?? 0) ||
        columnIndex(a) - columnIndex(b),
    );
    return { ok: false, issues };
  }
  if (items.size === 0) {
    return {
      ok: false,
      issues: [{ sheet: 'Items', row: null, column: null, message: 'No items to import' }],
    };
  }
  const plannedItems: PlannedItem[] = [...items.values()].map(
    ({ priceGiven: _priceGiven, ...item }) => ({ ...item, basePrice: item.basePrice ?? 0 }),
  );
  const plan: MenuImportPlan = {
    categories: [...categories.values()],
    modifierGroups: [...groups.values()].map((entry) => entry.group),
    items: plannedItems,
    combos,
  };
  return {
    ok: true,
    plan,
    summary: {
      categories: plan.categories.length,
      modifierGroups: plan.modifierGroups.length,
      items: plan.items.length,
      variants: plan.items.reduce((total, item) => total + item.variants.length, 0),
      combos: plan.combos.length,
    },
  };

  function listOf(
    sheet: MenuImportSheet,
    row: SheetRow,
    name: string,
    limits: { max: number; count: number },
  ): string[] | null {
    const values = splitList(row.get(name), ',');
    if (values.length > limits.count) {
      issue(sheet, row.row, name, `At most ${String(limits.count)} entries`);
      return null;
    }
    if (values.some((value) => value.length > limits.max)) {
      issue(sheet, row.row, name, `Each entry at most ${String(limits.max)} characters`);
      return null;
    }
    const unique = new Set(values.map(fold));
    if (unique.size !== values.length) {
      issue(sheet, row.row, name, 'An entry is listed twice');
      return null;
    }
    return values;
  }
}

/** Issues in one row are listed in the template's column order. */
function columnIndex(issue: MenuImportIssue): number {
  return MENU_IMPORT_COLUMNS[issue.sheet].findIndex((spec) => spec.name === issue.column);
}

export function parseFoodType(text: string): ImportFoodType | null {
  const key = text.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'veg' || key === 'vegetarian') return 'VEG';
  if (key === 'nonveg' || key === 'nonvegetarian') return 'NON_VEG';
  if (key === 'egg' || key === 'eggetarian') return 'EGG';
  return null;
}

function parseChannels(text: string): ImportChannel[] | null {
  const parts = splitList(text, ',');
  if (parts.length === 0) return [...ALL_CHANNELS];
  const channels = new Set<ImportChannel>();
  for (const part of parts) {
    const key = part.toLowerCase().replace(/[^a-z]/g, '');
    if (key === 'pos') channels.add('POS');
    else if (key === 'waiterapp' || key === 'waiter') channels.add('WAITER_APP');
    else if (key === 'tablet' || key === 'tabletablet') channels.add('TABLE_TABLET');
    else if (key === 'qr' || key === 'qrmenu') channels.add('QR');
    else return null;
  }
  return [...channels];
}

function parseYesNo(text: string): boolean | null {
  const key = text.trim().toLowerCase();
  if (key === '' || key === 'no' || key === 'n' || key === 'false') return false;
  if (key === 'yes' || key === 'y' || key === 'true') return true;
  return null;
}

/** "2026-10-20", "20-10-2026" or "20/10/2026" as an ISO date; null when blank; undefined when bad. */
function dateOf(text: string): string | null | undefined {
  if (text === '') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const indian = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  const [year, month, day] = iso
    ? [iso[1], iso[2], iso[3]]
    : indian
      ? [indian[3], indian[2]?.padStart(2, '0'), indian[1]?.padStart(2, '0')]
      : [];
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
  ) {
    return undefined;
  }
  return `${year}-${month}-${day}`;
}

/** "7:00" or "07:00" as "07:00"; null when blank; undefined when bad. */
function timeOf(text: string): string | null | undefined {
  if (text === '') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
