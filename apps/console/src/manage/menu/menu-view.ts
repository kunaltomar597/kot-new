import {
  type CategoryRequest,
  type CategoryView,
  type ComboRequest,
  type ComboView,
  ItemAvailabilityRequest,
  ItemRequest,
  type ItemView,
  type MenuDraftResponse,
  type ModifierGroupRequest,
  type ModifierGroupView,
  PHOTO_MAX_BYTES,
} from '@rp/contracts';
import { canonicalJson, parseRupees } from '@rp/domain';
import { inputFromPaise } from '../../billing/money-input.js';

/**
 * The menu editor's logic (P4-02d, MGR-005, MENU-001 to MENU-011), without React: the category
 * tree, the item list and its search, and the forms for items, combos, modifier groups,
 * categories and availability, with the same checks as the contracts so the server rarely has
 * to refuse anything.
 */

export type FoodType = ItemView['foodType'];
export type SalesChannel = ItemView['channels'][number];

export const SALES_CHANNELS: readonly SalesChannel[] = ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'];
export const FOOD_TYPES: readonly FoodType[] = ['VEG', 'NON_VEG', 'EGG'];
export const SPICE_LEVELS = [0, 1, 2, 3] as const;
/** The words for each spice level (MENU-002: 0 to 3). */
export const SPICE_LABELS = [
  'menuEditor.editor.spice.level0',
  'menuEditor.editor.spice.level1',
  'menuEditor.editor.spice.level2',
  'menuEditor.editor.spice.level3',
] as const;

/** The largest price the contracts accept: ₹1,00,000. */
const MAX_PRICE = 10_000_000;
const MAX_ORDER = 9_999;

let lastKey = 0;
/** A key for a row typed in a form (a size, an option, a combo part) until the server names it. */
export function newKey(): string {
  lastKey += 1;
  return `new-${String(lastKey)}`;
}

const isActive = (entry: { readonly archivedAt: string | null }) => entry.archivedAt === null;

/** A whole number typed in a field, within bounds; undefined otherwise. */
function wholeNumber(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : undefined;
}

/** Rupees typed in a field as paise (BRD §9.4), zero allowed; undefined when not an amount. */
export function pricePaise(text: string, options: { negative?: boolean } = {}): number | undefined {
  if (text.trim() === '') return undefined;
  try {
    const paise = parseRupees(text, { allowNegative: options.negative === true });
    return Math.abs(paise) <= MAX_PRICE ? paise : undefined;
  } catch {
    return undefined;
  }
}

/** A price change as typed back: "20.00", "-10.00", "0". */
export function signedInputFromPaise(paise: number): string {
  if (paise === 0) return '0';
  return paise < 0 ? `-${inputFromPaise(-paise)}` : inputFromPaise(paise);
}

/** Words separated by commas, trimmed, empty ones dropped. */
export function listOf(text: string): string[] {
  return text
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word !== '');
}

function repeats(values: readonly string[]): boolean {
  const lower = values.map((value) => value.toLowerCase());
  return new Set(lower).size !== lower.length;
}

// ---------------------------------------------------------------- categories (MENU-001)

export interface CategoryNode {
  readonly category: CategoryView;
  readonly children: readonly CategoryView[];
}

/**
 * Top-level categories in menu order, each with its sub-categories (MENU-001). Archived ones only
 * when asked for. A sub-category whose parent is not shown stands at the top level.
 */
export function categoryTree(
  categories: readonly CategoryView[],
  options: { readonly archived: boolean },
): CategoryNode[] {
  const shown = categories.filter((category) => options.archived || isActive(category));
  const shownIds = new Set(shown.map((category) => category.id));
  const isRoot = (category: CategoryView) =>
    category.parentId === null || !shownIds.has(category.parentId);
  return shown.filter(isRoot).map((category) => ({
    category,
    children: shown.filter((child) => child.parentId === category.id && !isRoot(child)),
  }));
}

/** Where an item can go: every active category, sub-categories after their parent. */
export function categoryChoices(
  categories: readonly CategoryView[],
): { readonly category: CategoryView; readonly parent: CategoryView | null }[] {
  return categoryTree(categories, { archived: false }).flatMap((node) => [
    { category: node.category, parent: null },
    ...node.children.map((child) => ({ category: child, parent: node.category })),
  ]);
}

/**
 * Where a category can go (MENU-001: one level of sub-categories): under an active top-level
 * category other than itself, unless it has sub-categories of its own.
 */
export function parentChoices(
  categories: readonly CategoryView[],
  selfId: string | undefined,
): CategoryView[] {
  if (selfId !== undefined && hasSubcategories(categories, selfId)) return [];
  return categories.filter(
    (category) => isActive(category) && category.parentId === null && category.id !== selfId,
  );
}

export function hasSubcategories(categories: readonly CategoryView[], id: string): boolean {
  return categories.some((category) => category.parentId === id && isActive(category));
}

/** Active items in a category (archiving needs it empty). */
export function itemsIn(items: readonly ItemView[], categoryId: string): number {
  return items.filter((item) => item.categoryId === categoryId && isActive(item)).length;
}

/** After the last of its neighbours, so a new entry goes to the end unless placed. */
function nextOrder(orders: readonly number[]): number {
  return Math.min(MAX_ORDER, orders.length === 0 ? 0 : Math.max(...orders) + 1);
}

export interface CategoryForm {
  readonly name: string;
  /** Empty for a top-level category. */
  readonly parentId: string;
  /** Empty puts it last among its neighbours. */
  readonly displayOrder: string;
}

export type CategoryField = 'name' | 'displayOrder';
export type CategoryProblem = 'nameProblem' | 'displayOrderProblem';

export function emptyCategoryForm(): CategoryForm {
  return { name: '', parentId: '', displayOrder: '' };
}

export function categoryFormOf(category: CategoryView): CategoryForm {
  return {
    name: category.name,
    parentId: category.parentId ?? '',
    displayOrder: String(category.displayOrder),
  };
}

export function checkCategory(form: CategoryForm): Partial<Record<CategoryField, CategoryProblem>> {
  const problems: Partial<Record<CategoryField, CategoryProblem>> = {};
  const name = form.name.trim();
  if (name === '' || name.length > 60) problems.name = 'nameProblem';
  if (
    form.displayOrder.trim() !== '' &&
    wholeNumber(form.displayOrder, 0, MAX_ORDER) === undefined
  ) {
    problems.displayOrder = 'displayOrderProblem';
  }
  return problems;
}

export function categoryRequestOf(
  form: CategoryForm,
  categories: readonly CategoryView[],
  selfId: string | undefined,
): CategoryRequest {
  const parentId = form.parentId === '' ? null : form.parentId;
  const neighbours = categories.filter(
    (category) => isActive(category) && category.parentId === parentId && category.id !== selfId,
  );
  return {
    name: form.name.trim(),
    parentId,
    displayOrder:
      wholeNumber(form.displayOrder, 0, MAX_ORDER) ??
      nextOrder(neighbours.map((category) => category.displayOrder)),
  };
}

// ---------------------------------------------------------------- the item list

/** Archived items and categories only when asked for; a search looks at every item shown. */
export interface ItemFilter {
  readonly query: string;
  readonly archived: boolean;
}

export interface ItemGroup {
  readonly category: CategoryView;
  /** The top-level category of a sub-category. */
  readonly parent: CategoryView | null;
  readonly items: readonly ItemView[];
}

/** An item matches a search by name, short code, tag or search word (MENU-011). */
export function matchesQuery(item: ItemView, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return true;
  return [item.name, item.shortCode ?? '', ...item.tags, ...item.synonyms].some((text) =>
    text.toLowerCase().includes(wanted),
  );
}

/**
 * The items in menu order, grouped by category (top-level, then its sub-categories). Without a
 * search every shown category is listed, empty or not; with one, only those with a match.
 */
export function itemGroups(
  draft: Pick<MenuDraftResponse, 'categories' | 'items'>,
  filter: ItemFilter,
): ItemGroup[] {
  const searching = filter.query.trim() !== '';
  const shown = draft.items.filter(
    (item) => (filter.archived || isActive(item)) && matchesQuery(item, filter.query),
  );
  const groupOf = (category: CategoryView, parent: CategoryView | null): ItemGroup => ({
    category,
    parent,
    items: shown.filter((item) => item.categoryId === category.id),
  });
  return categoryTree(draft.categories, { archived: filter.archived })
    .flatMap((node) => [
      groupOf(node.category, null),
      ...node.children.map((child) => groupOf(child, node.category)),
    ])
    .filter((group) => !searching || group.items.length > 0);
}

/** The lowest and highest price on the menu: the sizes' prices, or the item's own. */
export function priceRange(item: ItemView): { readonly low: number; readonly high: number } {
  const prices = item.variants.filter(isActive).map((variant) => variant.price);
  if (prices.length === 0) return { low: item.basePrice, high: item.basePrice };
  return { low: Math.min(...prices), high: Math.max(...prices) };
}

/** Channels the item is not sold on, in the usual order (MENU-002). */
export function missingChannels(item: ItemView): SalesChannel[] {
  return SALES_CHANNELS.filter((channel) => !item.channels.includes(channel));
}

/** Items that are a part (fixed or a choice) of some combo, and so cannot be combos themselves. */
export function comboPartIds(combos: readonly ComboView[]): Set<string> {
  return new Set(
    combos.flatMap((combo) =>
      combo.components.flatMap((component) =>
        component.kind === 'FIXED' && component.itemId !== null
          ? [component.itemId]
          : component.itemIds,
      ),
    ),
  );
}

// ---------------------------------------------------------------- availability (MENU-006)

export interface AvailabilityForm {
  readonly available: boolean;
  /** Count what is left: each order takes from it, and at 0 the item is out of stock. */
  readonly counting: boolean;
  readonly left: string;
}

export function availabilityFormOf(item: ItemView): AvailabilityForm {
  return {
    available: item.available,
    counting: item.stockCount !== null,
    left: item.stockCount === null ? '' : String(item.stockCount),
  };
}

/** The request, or undefined while the count is not a whole number from 0 to 100000. */
export function availabilityRequestOf(form: AvailabilityForm): ItemAvailabilityRequest | undefined {
  const request = {
    available: form.available,
    stockCount: form.counting ? (wholeNumber(form.left, 0, 100_000) ?? -1) : null,
  };
  const parsed = ItemAvailabilityRequest.safeParse(request);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------- items (MENU-002, MENU-003)

/** A size (variant, MENU-003) as typed; a kept one carries its id, since orders refer to it. */
export interface SizeForm {
  readonly key: string;
  readonly id: string | undefined;
  readonly name: string;
  readonly price: string;
  /** Kept as it is: the editor does not show a size's external ID. */
  readonly externalId: string | null;
}

export interface ItemForm {
  readonly name: string;
  readonly categoryId: string;
  readonly shortCode: string;
  readonly description: string;
  readonly photoId: string | null;
  readonly basePrice: string;
  readonly taxGroupId: string;
  /** Empty until chosen: veg or not is never guessed. */
  readonly foodType: FoodType | '';
  readonly spiceLevel: number;
  readonly sizes: readonly SizeForm[];
  readonly modifierGroupIds: readonly string[];
  readonly stationId: string;
  readonly prepTime: string;
  readonly channels: readonly SalesChannel[];
  /** Separated by commas. */
  readonly tags: string;
  /** Separated by commas. */
  readonly synonyms: string;
  /** Empty puts a new item last in its category. */
  readonly displayOrder: string;
  readonly repeatable: boolean;
  readonly externalId: string;
  /** Why a price changed (MENU-009), only asked when one did. */
  readonly reason: string;
}

/** A new item: every channel, not spicy; a category, tax group and station when there is one. */
export function emptyItemForm(choices: {
  readonly categoryId?: string;
  readonly taxGroupId?: string;
  readonly stationId?: string;
}): ItemForm {
  return {
    name: '',
    categoryId: choices.categoryId ?? '',
    shortCode: '',
    description: '',
    photoId: null,
    basePrice: '',
    taxGroupId: choices.taxGroupId ?? '',
    foodType: '',
    spiceLevel: 0,
    sizes: [],
    modifierGroupIds: [],
    stationId: choices.stationId ?? '',
    prepTime: '',
    channels: SALES_CHANNELS,
    tags: '',
    synonyms: '',
    displayOrder: '',
    repeatable: false,
    externalId: '',
    reason: '',
  };
}

export function itemFormOf(item: ItemView): ItemForm {
  return {
    name: item.name,
    categoryId: item.categoryId,
    shortCode: item.shortCode ?? '',
    description: item.description ?? '',
    photoId: item.photoId,
    basePrice: inputFromPaise(item.basePrice),
    taxGroupId: item.taxGroupId,
    foodType: item.foodType,
    spiceLevel: item.spiceLevel,
    sizes: item.variants.filter(isActive).map((variant) => ({
      key: variant.id,
      id: variant.id,
      name: variant.name,
      price: inputFromPaise(variant.price),
      externalId: variant.externalId,
    })),
    modifierGroupIds: item.modifierGroupIds,
    stationId: item.stationId,
    prepTime: item.prepTimeMinutes === null ? '' : String(item.prepTimeMinutes),
    channels: SALES_CHANNELS.filter((channel) => item.channels.includes(channel)),
    tags: item.tags.join(', '),
    synonyms: item.synonyms.join(', '),
    displayOrder: String(item.displayOrder),
    repeatable: item.repeatable,
    externalId: item.externalId ?? '',
    reason: '',
  };
}

export function emptySize(): SizeForm {
  return { key: newKey(), id: undefined, name: '', price: '', externalId: null };
}

export type ItemProblem =
  | 'nameProblem'
  | 'categoryProblem'
  | 'shortCodeProblem'
  | 'descriptionProblem'
  | 'priceProblem'
  | 'taxGroupProblem'
  | 'foodTypeProblem'
  | 'sizeNameProblem'
  | 'stationProblem'
  | 'prepTimeProblem'
  | 'channelsProblem'
  | 'tagsProblem'
  | 'synonymsProblem'
  | 'displayOrderProblem'
  | 'externalIdProblem'
  | 'reasonProblem';

/** Problems by field: `name`, `basePrice`, …, and `size:<key>:name` / `size:<key>:price`. */
export type ItemProblems = Readonly<Partial<Record<string, ItemProblem>>>;

export function checkItem(form: ItemForm): ItemProblems {
  const problems: Partial<Record<string, ItemProblem>> = {};
  const name = form.name.trim();
  if (name === '' || name.length > 80) problems.name = 'nameProblem';
  if (form.categoryId === '') problems.categoryId = 'categoryProblem';
  const shortCode = form.shortCode.trim();
  if (shortCode !== '' && !ItemRequest.shape.shortCode.safeParse(shortCode).success) {
    problems.shortCode = 'shortCodeProblem';
  }
  if (form.description.trim().length > 500) problems.description = 'descriptionProblem';
  if (pricePaise(form.basePrice) === undefined) problems.basePrice = 'priceProblem';
  if (form.taxGroupId === '') problems.taxGroupId = 'taxGroupProblem';
  if (form.foodType === '') problems.foodType = 'foodTypeProblem';
  const sizeNames = form.sizes.map((size) => size.name.trim());
  const sizeNamesRepeat = repeats(sizeNames);
  for (const size of form.sizes) {
    const sizeName = size.name.trim();
    if (sizeName === '' || sizeName.length > 40 || sizeNamesRepeat) {
      problems[`size:${size.key}:name`] = 'sizeNameProblem';
    }
    if (pricePaise(size.price) === undefined) problems[`size:${size.key}:price`] = 'priceProblem';
  }
  if (form.stationId === '') problems.stationId = 'stationProblem';
  if (form.prepTime.trim() !== '' && wholeNumber(form.prepTime, 0, 240) === undefined) {
    problems.prepTime = 'prepTimeProblem';
  }
  if (form.channels.length === 0) problems.channels = 'channelsProblem';
  const tags = listOf(form.tags);
  if (tags.length > 20 || tags.some((tag) => tag.length > 30) || repeats(tags)) {
    problems.tags = 'tagsProblem';
  }
  const synonyms = listOf(form.synonyms);
  if (synonyms.length > 20 || synonyms.some((word) => word.length > 40) || repeats(synonyms)) {
    problems.synonyms = 'synonymsProblem';
  }
  if (
    form.displayOrder.trim() !== '' &&
    wholeNumber(form.displayOrder, 0, MAX_ORDER) === undefined
  ) {
    problems.displayOrder = 'displayOrderProblem';
  }
  if (form.externalId.trim().length > 128) problems.externalId = 'externalIdProblem';
  const reason = form.reason.trim();
  if (reason !== '' && (reason.length < 3 || reason.length > 200))
    problems.reason = 'reasonProblem';
  return problems;
}

/** The request for a checked form; a new item without a place goes last in its category. */
export function itemRequestOf(form: ItemForm, items: readonly ItemView[]): ItemRequest {
  const neighbours = items.filter((item) => item.categoryId === form.categoryId && isActive(item));
  const reason = form.reason.trim();
  const optional = (text: string) => (text.trim() === '' ? null : text.trim());
  return {
    categoryId: form.categoryId,
    name: form.name.trim(),
    shortCode: optional(form.shortCode),
    description: optional(form.description),
    photoId: form.photoId,
    basePrice: pricePaise(form.basePrice) ?? 0,
    taxGroupId: form.taxGroupId,
    foodType: form.foodType === '' ? 'VEG' : form.foodType,
    spiceLevel: form.spiceLevel,
    tags: listOf(form.tags),
    stationId: form.stationId,
    prepTimeMinutes: wholeNumber(form.prepTime, 0, 240) ?? null,
    displayOrder:
      wholeNumber(form.displayOrder, 0, MAX_ORDER) ??
      nextOrder(neighbours.map((item) => item.displayOrder)),
    channels: [...form.channels],
    variants: form.sizes.map((size) => ({
      ...(size.id !== undefined && { id: size.id }),
      name: size.name.trim(),
      price: pricePaise(size.price) ?? 0,
      externalId: size.externalId,
    })),
    modifierGroupIds: [...form.modifierGroupIds],
    synonyms: listOf(form.synonyms),
    repeatable: form.repeatable,
    externalId: optional(form.externalId),
    ...(reason !== '' && { reason }),
  };
}

/** Whether saving would change the item at all (the reason alone changes nothing). */
export function itemChanged(item: ItemView, request: ItemRequest): boolean {
  const { reason: _reason, ...wanted } = request;
  const { reason: _was, ...current } = itemRequestOf(itemFormOf(item), []);
  return canonicalJson(wanted) !== canonicalJson(current);
}

/** Whether the item's price or a size's price would change (MENU-009 asks why). */
export function pricesChange(item: ItemView, form: ItemForm): boolean {
  if (pricePaise(form.basePrice) !== item.basePrice) return true;
  const before = new Map(
    item.variants.filter(isActive).map((variant) => [variant.id, variant.price]),
  );
  return form.sizes.some(
    (size) => size.id !== undefined && pricePaise(size.price) !== before.get(size.id),
  );
}

// ---------------------------------------------------------------- photos (MENU-008)

/** A photo read for `uploadPhoto`: its base64, or too large (the server checks again). */
export type PhotoContent = { readonly ok: true; readonly base64: string } | { readonly ok: false };

/** The photo as base64 for `uploadPhoto`; above 5 MB it is not read at all (MENU-008). */
export async function photoBase64(file: Blob): Promise<PhotoContent> {
  if (file.size > PHOTO_MAX_BYTES) return { ok: false };
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('The photo could not be read'));
    };
    reader.readAsDataURL(file);
  });
  return { ok: true, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

// ---------------------------------------------------------------- combos (MENU-005)

export interface ComboPartForm {
  readonly key: string;
  readonly kind: 'FIXED' | 'CHOICE';
  /** The fixed item; empty until chosen. */
  readonly itemId: string;
  /** A choice's name, such as "Any 1 drink". */
  readonly label: string;
  /** A choice's items. */
  readonly itemIds: readonly string[];
  readonly quantity: string;
}

export interface ComboForm {
  /** Once an item is a combo it stays one (there is no way back): archive it to stop selling it. */
  readonly enabled: boolean;
  readonly parts: readonly ComboPartForm[];
  readonly activeFrom: string;
  readonly activeUntil: string;
  readonly start: string;
  readonly end: string;
}

export function emptyComboPart(): ComboPartForm {
  return { key: newKey(), kind: 'FIXED', itemId: '', label: '', itemIds: [], quantity: '1' };
}

export function comboFormOf(combo: ComboView | undefined): ComboForm {
  if (combo === undefined) {
    return { enabled: false, parts: [], activeFrom: '', activeUntil: '', start: '', end: '' };
  }
  return {
    enabled: true,
    parts: combo.components.map((component) => ({
      key: newKey(),
      kind: component.kind,
      itemId: component.itemId ?? '',
      label: component.label ?? '',
      itemIds: component.itemIds,
      quantity: String(component.quantity),
    })),
    activeFrom: combo.activeFrom ?? '',
    activeUntil: combo.activeUntil ?? '',
    start: combo.timeWindow?.start ?? '',
    end: combo.timeWindow?.end ?? '',
  };
}

export type ComboProblem =
  | 'partsProblem'
  | 'itemProblem'
  | 'labelProblem'
  | 'choicesProblem'
  | 'quantityProblem'
  | 'datesProblem'
  | 'windowProblem';

/** Problems by field: `parts`, `dates`, `window`, and `part:<key>:item|label|choices|quantity`. */
export type ComboProblems = Readonly<Partial<Record<string, ComboProblem>>>;

export function checkCombo(form: ComboForm): ComboProblems {
  const problems: Partial<Record<string, ComboProblem>> = {};
  if (!form.enabled) return problems;
  if (form.parts.length < 1 || form.parts.length > 10) problems.parts = 'partsProblem';
  for (const part of form.parts) {
    if (part.kind === 'FIXED') {
      if (part.itemId === '') problems[`part:${part.key}:item`] = 'itemProblem';
    } else {
      const label = part.label.trim();
      if (label === '' || label.length > 60) problems[`part:${part.key}:label`] = 'labelProblem';
      if (part.itemIds.length < 2 || part.itemIds.length > 30) {
        problems[`part:${part.key}:choices`] = 'choicesProblem';
      }
    }
    if (wholeNumber(part.quantity, 1, 20) === undefined) {
      problems[`part:${part.key}:quantity`] = 'quantityProblem';
    }
  }
  if (form.activeFrom !== '' && form.activeUntil !== '' && form.activeFrom > form.activeUntil) {
    problems.dates = 'datesProblem';
  }
  if ((form.start === '') !== (form.end === '')) problems.window = 'windowProblem';
  return problems;
}

export function comboRequestOf(form: ComboForm): ComboRequest {
  return {
    components: form.parts.map((part) => {
      const quantity = wholeNumber(part.quantity, 1, 20) ?? 1;
      return part.kind === 'FIXED'
        ? { kind: 'FIXED' as const, itemId: part.itemId, quantity }
        : {
            kind: 'CHOICE' as const,
            label: part.label.trim(),
            itemIds: [...part.itemIds],
            quantity,
          };
    }),
    activeFrom: form.activeFrom === '' ? null : form.activeFrom,
    activeUntil: form.activeUntil === '' ? null : form.activeUntil,
    timeWindow: form.start === '' || form.end === '' ? null : { start: form.start, end: form.end },
  };
}

/** Whether saving would set the combo: a new one, or one that differs from what it is. */
export function comboChanged(form: ComboForm, combo: ComboView | undefined): boolean {
  if (!form.enabled) return false;
  if (combo === undefined) return true;
  return canonicalJson(comboRequestOf(form)) !== canonicalJson(comboRequestOf(comboFormOf(combo)));
}

/** Items a combo can bundle: active, not combos themselves, not the combo item. */
export function comboItemChoices(
  draft: Pick<MenuDraftResponse, 'items' | 'combos'>,
  selfId: string | undefined,
): ItemView[] {
  const combos = new Set(draft.combos.map((combo) => combo.itemId));
  return draft.items.filter((item) => isActive(item) && !combos.has(item.id) && item.id !== selfId);
}

// ---------------------------------------------------------------- modifier groups (MENU-004)

export interface OptionForm {
  readonly key: string;
  readonly id: string | undefined;
  readonly name: string;
  /** Rupees added to the item's price; a minus takes them off. Empty is no change. */
  readonly priceDelta: string;
  readonly available: boolean;
}

export interface GroupForm {
  readonly name: string;
  readonly min: string;
  readonly max: string;
  readonly options: readonly OptionForm[];
}

export function emptyOption(): OptionForm {
  return { key: newKey(), id: undefined, name: '', priceDelta: '', available: true };
}

/** A new group: optional, at most one, with one option to fill in. */
export function emptyGroupForm(): GroupForm {
  return { name: '', min: '0', max: '1', options: [emptyOption()] };
}

export function groupFormOf(group: ModifierGroupView): GroupForm {
  return {
    name: group.name,
    min: String(group.minSelections),
    max: String(group.maxSelections),
    options: group.options.filter(isActive).map((option) => ({
      key: option.id,
      id: option.id,
      name: option.name,
      priceDelta: signedInputFromPaise(option.priceDelta),
      available: option.available,
    })),
  };
}

export type GroupProblem =
  'nameProblem' | 'countProblem' | 'optionsProblem' | 'optionNameProblem' | 'optionPriceProblem';

/** Problems by field: `name`, `count`, `options`, and `option:<key>:name|price`. */
export type GroupProblems = Readonly<Partial<Record<string, GroupProblem>>>;

export function checkGroup(form: GroupForm): GroupProblems {
  const problems: Partial<Record<string, GroupProblem>> = {};
  const name = form.name.trim();
  if (name === '' || name.length > 60) problems.name = 'nameProblem';
  const min = wholeNumber(form.min, 0, 20);
  const max = wholeNumber(form.max, 1, 20);
  if (min === undefined || max === undefined || min > max || min > form.options.length) {
    problems.count = 'countProblem';
  }
  if (form.options.length < 1 || form.options.length > 50) problems.options = 'optionsProblem';
  const names = form.options.map((option) => option.name.trim());
  const namesRepeat = repeats(names);
  for (const option of form.options) {
    const optionName = option.name.trim();
    if (optionName === '' || optionName.length > 60 || namesRepeat) {
      problems[`option:${option.key}:name`] = 'optionNameProblem';
    }
    if (
      option.priceDelta.trim() !== '' &&
      pricePaise(option.priceDelta, { negative: true }) === undefined
    ) {
      problems[`option:${option.key}:price`] = 'optionPriceProblem';
    }
  }
  return problems;
}

export function groupRequestOf(form: GroupForm): ModifierGroupRequest {
  return {
    name: form.name.trim(),
    minSelections: wholeNumber(form.min, 0, 20) ?? 0,
    maxSelections: wholeNumber(form.max, 1, 20) ?? 1,
    options: form.options.map((option) => ({
      ...(option.id !== undefined && { id: option.id }),
      name: option.name.trim(),
      priceDelta:
        option.priceDelta.trim() === ''
          ? 0
          : (pricePaise(option.priceDelta, { negative: true }) ?? 0),
      available: option.available,
    })),
  };
}

/** Active groups an item can offer, then any archived one it still names (shown as such). */
export function groupChoices(
  groups: readonly ModifierGroupView[],
  chosen: readonly string[],
): ModifierGroupView[] {
  return groups.filter((group) => isActive(group) || chosen.includes(group.id));
}
