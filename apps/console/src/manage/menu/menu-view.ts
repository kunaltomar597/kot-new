import {
  type CategoryRequest,
  type CategoryView,
  type ComboRequest,
  type ComboView,
  type ItemRequest,
  type ItemView,
  type MenuDraftResponse,
  type ModifierGroupRequest,
  type ModifierGroupView,
  SalesChannel,
} from '@rp/contracts';
import { formatRupees, parseRupees } from '@rp/domain';

/**
 * The menu editor (P4-02d, MGR-005, MENU-001 to MENU-011): forms that mirror the server's checks,
 * so a manager hears about a mistake before saving, and the list's filters. Prices are typed in
 * rupees and sent as integer paise (BRD §9.4).
 */

export const SALES_CHANNELS = SalesChannel.options;
export const FOOD_TYPES = ['VEG', 'NON_VEG', 'EGG'] as const;
/** Spice levels 0 to 3 by name (MENU-002). */
export const SPICE_LEVELS = ['none', 'mild', 'medium', 'hot'] as const;

let keys = 0;
/** A stable key for a new row in a form (a variant, an option, a combo part). */
export function newKey(): string {
  keys += 1;
  return `new-${String(keys)}`;
}

/** Paise from what was typed, or undefined when it is not an amount. */
export function paiseOf(text: string, allowNegative = false): number | undefined {
  try {
    return parseRupees(text, { allowNegative });
  } catch {
    return undefined;
  }
}

/** Paise as a manager types them: "120.50", no symbol or grouping. */
export function rupeesText(paise: number): string {
  return formatRupees(paise, { symbol: false }).replace(/,/g, '');
}

/** "a, b , c" as a list, without blanks or repeats (case-insensitive). */
export function splitList(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of text.split(',')) {
    const value = part.trim();
    if (value === '' || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    result.push(value);
  }
  return result;
}

// ---------------------------------------------------------------- categories

export interface CategoryRow {
  readonly category: CategoryView;
  /** 0 for a top-level category, 1 for a sub-category (MENU-001). */
  readonly depth: 0 | 1;
}

const byOrder = (a: CategoryView, b: CategoryView) =>
  a.displayOrder - b.displayOrder || a.name.localeCompare(b.name);

/** Categories in menu order, each sub-category under its parent. */
export function categoryRows(
  categories: readonly CategoryView[],
  options: { readonly archived?: boolean } = {},
): CategoryRow[] {
  const shown = categories.filter(
    (category) => options.archived === true || category.archivedAt === null,
  );
  const rows: CategoryRow[] = [];
  for (const parent of shown.filter((category) => category.parentId === null).sort(byOrder)) {
    rows.push({ category: parent, depth: 0 });
    for (const child of shown.filter((category) => category.parentId === parent.id).sort(byOrder)) {
      rows.push({ category: child, depth: 1 });
    }
  }
  // A sub-category whose parent is hidden still shows, at the end.
  const listed = new Set(rows.map((row) => row.category.id));
  for (const orphan of shown.filter((category) => !listed.has(category.id)).sort(byOrder)) {
    rows.push({ category: orphan, depth: 1 });
  }
  return rows;
}

/** "Mains › Curries" for a sub-category, "Mains" for a top-level one. */
export function categoryPath(categories: readonly CategoryView[], id: string): string {
  const category = categories.find((entry) => entry.id === id);
  if (category === undefined) return '';
  const parent =
    category.parentId === null
      ? undefined
      : categories.find((entry) => entry.id === category.parentId);
  return parent === undefined ? category.name : `${parent.name} › ${category.name}`;
}

export interface CategoryForm {
  readonly name: string;
  /** Empty for a top-level category. */
  readonly parentId: string;
  readonly displayOrder: string;
}

export type CategoryProblem = 'nameRequired' | 'orderInvalid' | 'parentIsChild';

export function categoryFormOf(category?: CategoryView, nextOrder = 0): CategoryForm {
  return {
    name: category?.name ?? '',
    parentId: category?.parentId ?? '',
    displayOrder: String(category?.displayOrder ?? nextOrder),
  };
}

/** Parents a category may have: active top-level categories other than itself (one level). */
export function parentChoices(categories: readonly CategoryView[], self?: CategoryView) {
  const hasChildren =
    self !== undefined && categories.some((category) => category.parentId === self.id);
  if (hasChildren) return [];
  return categories
    .filter(
      (category) =>
        category.archivedAt === null && category.parentId === null && category.id !== self?.id,
    )
    .sort(byOrder)
    .map((category) => ({ value: category.id, label: category.name }));
}

export function checkCategory(
  form: CategoryForm,
): Partial<Record<'name' | 'displayOrder', CategoryProblem>> {
  const problems: Partial<Record<'name' | 'displayOrder', CategoryProblem>> = {};
  if (form.name.trim() === '' || form.name.trim().length > 60) problems.name = 'nameRequired';
  if (!isOrder(form.displayOrder)) problems.displayOrder = 'orderInvalid';
  return problems;
}

export function categoryRequestOf(form: CategoryForm): CategoryRequest {
  return {
    name: form.name.trim(),
    parentId: form.parentId === '' ? null : form.parentId,
    displayOrder: Number(form.displayOrder),
  };
}

function isOrder(text: string): boolean {
  return /^\d{1,4}$/.test(text.trim());
}

/** The next display order after the largest used, in steps of 10 so others fit between. */
export function nextOrder(orders: readonly number[]): number {
  return Math.min(9_990, orders.reduce((max, order) => Math.max(max, order), -10) + 10);
}

// ---------------------------------------------------------------- items

export interface VariantForm {
  readonly key: string;
  readonly id?: string;
  readonly name: string;
  readonly price: string;
}

export interface ItemForm {
  readonly categoryId: string;
  readonly name: string;
  readonly shortCode: string;
  readonly description: string;
  readonly photoId: string | null;
  readonly basePrice: string;
  readonly taxGroupId: string;
  readonly foodType: (typeof FOOD_TYPES)[number];
  readonly spiceLevel: number;
  readonly tags: string;
  readonly stationId: string;
  readonly prepTime: string;
  readonly displayOrder: string;
  readonly channels: readonly ItemRequest['channels'][number][];
  readonly variants: readonly VariantForm[];
  readonly modifierGroupIds: readonly string[];
  readonly synonyms: string;
  readonly repeatable: boolean;
  readonly externalId: string;
  /** Why the price changed, for the audit (MENU-009); optional. */
  readonly reason: string;
}

export type ItemField =
  | 'name'
  | 'categoryId'
  | 'basePrice'
  | 'taxGroupId'
  | 'stationId'
  | 'shortCode'
  | 'prepTime'
  | 'displayOrder'
  | 'channels'
  | 'tags'
  | 'synonyms'
  | 'variants'
  | 'description';

export type ItemProblem =
  | 'nameRequired'
  | 'categoryRequired'
  | 'priceInvalid'
  | 'taxGroupRequired'
  | 'stationRequired'
  | 'shortCodeInvalid'
  | 'prepTimeInvalid'
  | 'orderInvalid'
  | 'channelsRequired'
  | 'tooMany'
  | 'variantInvalid'
  | 'variantNamesRepeat'
  | 'descriptionTooLong';

export interface ItemDefaults {
  readonly categoryId: string;
  readonly taxGroupId: string;
  readonly stationId: string;
  readonly displayOrder: number;
}

export function itemFormOf(item: ItemView | undefined, defaults: ItemDefaults): ItemForm {
  if (item === undefined) {
    return {
      categoryId: defaults.categoryId,
      name: '',
      shortCode: '',
      description: '',
      photoId: null,
      basePrice: '',
      taxGroupId: defaults.taxGroupId,
      foodType: 'VEG',
      spiceLevel: 0,
      tags: '',
      stationId: defaults.stationId,
      prepTime: '',
      displayOrder: String(defaults.displayOrder),
      channels: [...SALES_CHANNELS],
      variants: [],
      modifierGroupIds: [],
      synonyms: '',
      repeatable: false,
      externalId: '',
      reason: '',
    };
  }
  return {
    categoryId: item.categoryId,
    name: item.name,
    shortCode: item.shortCode ?? '',
    description: item.description ?? '',
    photoId: item.photoId,
    basePrice: rupeesText(item.basePrice),
    taxGroupId: item.taxGroupId,
    foodType: item.foodType,
    spiceLevel: item.spiceLevel,
    tags: item.tags.join(', '),
    stationId: item.stationId,
    prepTime: item.prepTimeMinutes === null ? '' : String(item.prepTimeMinutes),
    displayOrder: String(item.displayOrder),
    channels: item.channels,
    variants: item.variants
      .filter((variant) => variant.archivedAt === null)
      .map((variant) => ({
        key: variant.id,
        id: variant.id,
        name: variant.name,
        price: rupeesText(variant.price),
      })),
    modifierGroupIds: item.modifierGroupIds,
    synonyms: item.synonyms.join(', '),
    repeatable: item.repeatable,
    externalId: item.externalId ?? '',
    reason: '',
  };
}

const MAX_PRICE = 10_000_000;

function priceOk(text: string): boolean {
  const paise = paiseOf(text);
  return paise !== undefined && paise <= MAX_PRICE;
}

/** The same checks as the server's `ItemRequest` (MENU-002 to MENU-004). */
export function checkItem(form: ItemForm): Partial<Record<ItemField, ItemProblem>> {
  const problems: Partial<Record<ItemField, ItemProblem>> = {};
  const name = form.name.trim();
  if (name === '' || name.length > 80) problems.name = 'nameRequired';
  if (form.categoryId === '') problems.categoryId = 'categoryRequired';
  if (!priceOk(form.basePrice)) problems.basePrice = 'priceInvalid';
  if (form.taxGroupId === '') problems.taxGroupId = 'taxGroupRequired';
  if (form.stationId === '') problems.stationId = 'stationRequired';
  if (form.shortCode.trim() !== '' && !/^[A-Za-z0-9-]{1,12}$/.test(form.shortCode.trim())) {
    problems.shortCode = 'shortCodeInvalid';
  }
  if (form.description.trim().length > 500) problems.description = 'descriptionTooLong';
  const prep = form.prepTime.trim();
  if (prep !== '' && !(/^\d{1,3}$/.test(prep) && Number(prep) <= 240)) {
    problems.prepTime = 'prepTimeInvalid';
  }
  if (!isOrder(form.displayOrder)) problems.displayOrder = 'orderInvalid';
  if (form.channels.length === 0) problems.channels = 'channelsRequired';
  const tags = splitList(form.tags);
  if (tags.length > 20 || tags.some((tag) => tag.length > 30)) problems.tags = 'tooMany';
  const synonyms = splitList(form.synonyms);
  if (synonyms.length > 20 || synonyms.some((synonym) => synonym.length > 40)) {
    problems.synonyms = 'tooMany';
  }
  if (
    form.variants.length > 10 ||
    form.variants.some(
      (variant) =>
        variant.name.trim() === '' || variant.name.trim().length > 40 || !priceOk(variant.price),
    )
  ) {
    problems.variants = 'variantInvalid';
  } else {
    const names = form.variants.map((variant) => variant.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) problems.variants = 'variantNamesRepeat';
  }
  return problems;
}

/** The request for a checked form. */
export function itemRequestOf(form: ItemForm): ItemRequest {
  const text = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    categoryId: form.categoryId,
    name: form.name.trim(),
    shortCode: text(form.shortCode),
    description: text(form.description),
    photoId: form.photoId,
    basePrice: paiseOf(form.basePrice) ?? 0,
    taxGroupId: form.taxGroupId,
    foodType: form.foodType,
    spiceLevel: form.spiceLevel,
    tags: splitList(form.tags),
    stationId: form.stationId,
    prepTimeMinutes: form.prepTime.trim() === '' ? null : Number(form.prepTime.trim()),
    displayOrder: Number(form.displayOrder),
    channels: [...form.channels],
    variants: form.variants.map((variant) => ({
      ...(variant.id !== undefined && { id: variant.id }),
      name: variant.name.trim(),
      price: paiseOf(variant.price) ?? 0,
    })),
    modifierGroupIds: [...form.modifierGroupIds],
    synonyms: splitList(form.synonyms),
    repeatable: form.repeatable,
    externalId: text(form.externalId),
    ...(form.reason.trim().length >= 3 && { reason: form.reason.trim() }),
  };
}

/** Whether a saved item's prices would change (the reason field is offered then, MENU-009). */
export function changesPrice(item: ItemView | undefined, form: ItemForm): boolean {
  if (item === undefined) return false;
  if (paiseOf(form.basePrice) !== item.basePrice) return true;
  const before = new Map(
    item.variants
      .filter((variant) => variant.archivedAt === null)
      .map((variant) => [variant.id, variant.price]),
  );
  return form.variants.some(
    (variant) => variant.id !== undefined && before.get(variant.id) !== paiseOf(variant.price),
  );
}

/** The item's price in the list: its own, or "from" the cheapest variant. */
export function priceLabel(item: ItemView): { readonly from: boolean; readonly paise: number } {
  const prices = item.variants
    .filter((variant) => variant.archivedAt === null)
    .map((variant) => variant.price);
  return prices.length === 0
    ? { from: false, paise: item.basePrice }
    : { from: true, paise: Math.min(...prices) };
}

export interface ItemFilter {
  /** Empty for every category; a top-level category also shows its sub-categories' items. */
  readonly categoryId: string;
  readonly search: string;
  readonly archived: boolean;
}

/** The items the list shows, in menu order (category, then display order, then name). */
export function filterItems(draft: MenuDraftResponse, filter: ItemFilter): ItemView[] {
  const rows = categoryRows(draft.categories, { archived: true });
  const rank = new Map(rows.map((row, index) => [row.category.id, index]));
  const inCategory = (item: ItemView) => {
    if (filter.categoryId === '') return true;
    if (item.categoryId === filter.categoryId) return true;
    const category = draft.categories.find((entry) => entry.id === item.categoryId);
    return category?.parentId === filter.categoryId;
  };
  const words = filter.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (item: ItemView) => {
    if (words.length === 0) return true;
    const text = [item.name, item.shortCode ?? '', ...item.tags, ...item.synonyms]
      .join(' ')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  };
  return draft.items
    .filter((item) => (filter.archived ? item.archivedAt !== null : item.archivedAt === null))
    .filter(inCategory)
    .filter(matches)
    .sort(
      (a, b) =>
        (rank.get(a.categoryId) ?? 0) - (rank.get(b.categoryId) ?? 0) ||
        a.displayOrder - b.displayOrder ||
        a.name.localeCompare(b.name),
    );
}

// ---------------------------------------------------------------- modifier groups

export interface OptionForm {
  readonly key: string;
  readonly id?: string;
  readonly name: string;
  readonly priceDelta: string;
  readonly available: boolean;
}

export interface GroupForm {
  readonly name: string;
  readonly minSelections: string;
  readonly maxSelections: string;
  readonly options: readonly OptionForm[];
}

export type GroupField = 'name' | 'minSelections' | 'maxSelections' | 'options';
export type GroupProblem =
  | 'nameRequired'
  | 'countInvalid'
  | 'minAboveMax'
  | 'minAboveOptions'
  | 'optionInvalid'
  | 'optionNamesRepeat'
  | 'optionsRequired';

export function groupFormOf(group?: ModifierGroupView): GroupForm {
  if (group === undefined) {
    return {
      name: '',
      minSelections: '0',
      maxSelections: '1',
      options: [{ key: newKey(), name: '', priceDelta: '0', available: true }],
    };
  }
  return {
    name: group.name,
    minSelections: String(group.minSelections),
    maxSelections: String(group.maxSelections),
    options: group.options
      .filter((option) => option.archivedAt === null)
      .map((option) => ({
        key: option.id,
        id: option.id,
        name: option.name,
        priceDelta: rupeesText(option.priceDelta),
        available: option.available,
      })),
  };
}

const count = (text: string) => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : undefined);

/** The same checks as the server's `ModifierGroupRequest` (MENU-004). */
export function checkGroup(form: GroupForm): Partial<Record<GroupField, GroupProblem>> {
  const problems: Partial<Record<GroupField, GroupProblem>> = {};
  if (form.name.trim() === '' || form.name.trim().length > 60) problems.name = 'nameRequired';
  const min = count(form.minSelections);
  const max = count(form.maxSelections);
  if (min === undefined || min > 20) problems.minSelections = 'countInvalid';
  if (max === undefined || max < 1 || max > 20) problems.maxSelections = 'countInvalid';
  if (form.options.length === 0 || form.options.length > 50) {
    problems.options = 'optionsRequired';
  } else if (
    form.options.some((option) => {
      const delta = paiseOf(option.priceDelta, true);
      return (
        option.name.trim() === '' ||
        option.name.trim().length > 60 ||
        delta === undefined ||
        Math.abs(delta) > MAX_PRICE
      );
    })
  ) {
    problems.options = 'optionInvalid';
  } else {
    const names = form.options.map((option) => option.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) problems.options = 'optionNamesRepeat';
  }
  if (min !== undefined && max !== undefined && problems.minSelections === undefined) {
    if (min > max) problems.minSelections = 'minAboveMax';
    else if (min > form.options.length) problems.minSelections = 'minAboveOptions';
  }
  return problems;
}

export function groupRequestOf(form: GroupForm): ModifierGroupRequest {
  return {
    name: form.name.trim(),
    minSelections: Number(form.minSelections.trim()),
    maxSelections: Number(form.maxSelections.trim()),
    options: form.options.map((option) => ({
      ...(option.id !== undefined && { id: option.id }),
      name: option.name.trim(),
      priceDelta: paiseOf(option.priceDelta, true) ?? 0,
      available: option.available,
    })),
  };
}

/** "Choose 1", "Optional, up to 3", "Choose 1 to 2" for a group's rule. */
export type GroupRule =
  | { readonly kind: 'EXACTLY'; readonly count: number }
  | { readonly kind: 'UP_TO'; readonly count: number }
  | { readonly kind: 'BETWEEN'; readonly min: number; readonly max: number };

export function groupRule(group: Pick<ModifierGroupView, 'minSelections' | 'maxSelections'>) {
  if (group.minSelections === group.maxSelections) {
    return { kind: 'EXACTLY', count: group.minSelections } as const;
  }
  if (group.minSelections === 0) return { kind: 'UP_TO', count: group.maxSelections } as const;
  return { kind: 'BETWEEN', min: group.minSelections, max: group.maxSelections } as const;
}

// ---------------------------------------------------------------- combos

export interface ComboPartForm {
  readonly key: string;
  readonly kind: 'FIXED' | 'CHOICE';
  /** For a fixed part. */
  readonly itemId: string;
  /** For a choice: "Any 1 drink" and the items to choose from. */
  readonly label: string;
  readonly itemIds: readonly string[];
  readonly quantity: string;
}

export interface ComboForm {
  readonly parts: readonly ComboPartForm[];
  readonly activeFrom: string;
  readonly activeUntil: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

export type ComboField = 'parts' | 'dates' | 'window';
export type ComboProblem = 'partsRequired' | 'partInvalid' | 'datesBackwards' | 'windowIncomplete';

export function newComboPart(kind: ComboPartForm['kind']): ComboPartForm {
  return { key: newKey(), kind, itemId: '', label: '', itemIds: [], quantity: '1' };
}

export function comboFormOf(combo?: ComboView): ComboForm {
  if (combo === undefined) {
    return {
      parts: [newComboPart('FIXED')],
      activeFrom: '',
      activeUntil: '',
      windowStart: '',
      windowEnd: '',
    };
  }
  return {
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
    windowStart: combo.timeWindow?.start ?? '',
    windowEnd: combo.timeWindow?.end ?? '',
  };
}

/** Items a combo can hold: active items that are not combos and not the combo itself. */
export function comboCandidates(draft: MenuDraftResponse, comboItemId?: string): ItemView[] {
  const combos = new Set(draft.combos.map((combo) => combo.itemId));
  return draft.items
    .filter((item) => item.archivedAt === null && !combos.has(item.id) && item.id !== comboItemId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The same checks as the server's `ComboRequest` (MENU-005). */
export function checkCombo(form: ComboForm): Partial<Record<ComboField, ComboProblem>> {
  const problems: Partial<Record<ComboField, ComboProblem>> = {};
  const quantityOk = (text: string) =>
    /^\d{1,2}$/.test(text) && Number(text) >= 1 && Number(text) <= 20;
  if (form.parts.length === 0 || form.parts.length > 10) {
    problems.parts = 'partsRequired';
  } else if (
    form.parts.some((part) =>
      part.kind === 'FIXED'
        ? part.itemId === '' || !quantityOk(part.quantity.trim())
        : part.label.trim() === '' ||
          part.itemIds.length < 2 ||
          part.itemIds.length > 30 ||
          !quantityOk(part.quantity.trim()),
    )
  ) {
    problems.parts = 'partInvalid';
  }
  if (form.activeFrom !== '' && form.activeUntil !== '' && form.activeFrom > form.activeUntil) {
    problems.dates = 'datesBackwards';
  }
  if ((form.windowStart === '') !== (form.windowEnd === '')) problems.window = 'windowIncomplete';
  return problems;
}

export function comboRequestOf(form: ComboForm): ComboRequest {
  return {
    components: form.parts.map((part) =>
      part.kind === 'FIXED'
        ? { kind: 'FIXED', itemId: part.itemId, quantity: Number(part.quantity.trim()) }
        : {
            kind: 'CHOICE',
            label: part.label.trim(),
            itemIds: [...part.itemIds],
            quantity: Number(part.quantity.trim()),
          },
    ),
    activeFrom: form.activeFrom === '' ? null : form.activeFrom,
    activeUntil: form.activeUntil === '' ? null : form.activeUntil,
    timeWindow: form.windowStart === '' ? null : { start: form.windowStart, end: form.windowEnd },
  };
}
