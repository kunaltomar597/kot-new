import { DomainError } from './errors.js';
import { assertPaise, type Paise } from './money.js';

/**
 * Variant and modifier selection rules shared by every ordering surface: POS, waiter app,
 * table tablet and QR menu (MENU-003, MENU-004, MENU-012). The server re-runs the same checks
 * and pricing on submission (ORD-014).
 */

export interface VariantDef {
  readonly id: string;
  readonly name: string;
  readonly price: Paise;
}

export interface ModifierOptionDef {
  readonly id: string;
  readonly name: string;
  /** Price change per unit; may be negative (MENU-004). */
  readonly priceDelta: Paise;
}

export interface ModifierGroupDef {
  readonly id: string;
  readonly name: string;
  /** 0 = optional; ≥ 1 = required. */
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly options: readonly ModifierOptionDef[];
}

export interface SelectableItemDef {
  readonly id: string;
  readonly basePrice: Paise;
  /** When present, one variant must be chosen and its price replaces the base price. */
  readonly variants?: readonly VariantDef[];
  readonly modifierGroups?: readonly ModifierGroupDef[];
}

export interface ItemSelection {
  readonly variantId?: string;
  readonly modifiers?: readonly {
    readonly groupId: string;
    readonly optionIds: readonly string[];
  }[];
}

export type SelectionIssueCode =
  | 'VARIANT_REQUIRED'
  | 'UNKNOWN_VARIANT'
  | 'VARIANT_NOT_APPLICABLE'
  | 'UNKNOWN_MODIFIER_GROUP'
  | 'UNKNOWN_MODIFIER_OPTION'
  | 'DUPLICATE_MODIFIER_OPTION'
  | 'DUPLICATE_MODIFIER_GROUP'
  | 'TOO_FEW_MODIFIERS'
  | 'TOO_MANY_MODIFIERS'
  | 'NEGATIVE_PRICE';

export interface SelectionIssue {
  readonly code: SelectionIssueCode;
  readonly groupId?: string;
  readonly optionId?: string;
  readonly message: string;
}

function basePriceFor(
  item: SelectableItemDef,
  selection: ItemSelection,
  issues: SelectionIssue[],
): Paise {
  const variants = item.variants ?? [];
  if (variants.length === 0) {
    if (selection.variantId !== undefined) {
      issues.push({ code: 'VARIANT_NOT_APPLICABLE', message: 'This item has no variants' });
    }
    return item.basePrice;
  }
  if (selection.variantId === undefined) {
    issues.push({ code: 'VARIANT_REQUIRED', message: 'Choose a variant' });
    return item.basePrice;
  }
  const variant = variants.find((candidate) => candidate.id === selection.variantId);
  if (!variant) {
    issues.push({ code: 'UNKNOWN_VARIANT', message: 'That variant is not available' });
    return item.basePrice;
  }
  return variant.price;
}

function evaluate(
  item: SelectableItemDef,
  selection: ItemSelection,
): { issues: SelectionIssue[]; unitPrice: Paise } {
  const issues: SelectionIssue[] = [];
  let unitPrice = basePriceFor(item, selection, issues);
  const groups = item.modifierGroups ?? [];
  const chosen = selection.modifiers ?? [];

  const chosenByGroup = new Map<string, readonly string[]>();
  for (const entry of chosen) {
    if (chosenByGroup.has(entry.groupId)) {
      issues.push({
        code: 'DUPLICATE_MODIFIER_GROUP',
        groupId: entry.groupId,
        message: 'A modifier group was sent twice',
      });
      continue;
    }
    if (!groups.some((group) => group.id === entry.groupId)) {
      issues.push({
        code: 'UNKNOWN_MODIFIER_GROUP',
        groupId: entry.groupId,
        message: 'Unknown modifier group',
      });
      continue;
    }
    chosenByGroup.set(entry.groupId, entry.optionIds);
  }

  for (const group of groups) {
    const optionIds = chosenByGroup.get(group.id) ?? [];
    const unique = new Set<string>();
    for (const optionId of optionIds) {
      if (unique.has(optionId)) {
        issues.push({
          code: 'DUPLICATE_MODIFIER_OPTION',
          groupId: group.id,
          optionId,
          message: `"${group.name}" has the same option twice`,
        });
        continue;
      }
      unique.add(optionId);
      const option = group.options.find((candidate) => candidate.id === optionId);
      if (!option) {
        issues.push({
          code: 'UNKNOWN_MODIFIER_OPTION',
          groupId: group.id,
          optionId,
          message: `Unknown option in "${group.name}"`,
        });
        continue;
      }
      unitPrice += option.priceDelta;
    }
    if (unique.size < group.minSelections) {
      issues.push({
        code: 'TOO_FEW_MODIFIERS',
        groupId: group.id,
        message: `Choose at least ${group.minSelections} in "${group.name}"`,
      });
    }
    if (unique.size > group.maxSelections) {
      issues.push({
        code: 'TOO_MANY_MODIFIERS',
        groupId: group.id,
        message: `Choose at most ${group.maxSelections} in "${group.name}"`,
      });
    }
  }

  if (unitPrice < 0)
    issues.push({ code: 'NEGATIVE_PRICE', message: 'Modifiers make the price negative' });
  return { issues, unitPrice };
}

/** All problems with a selection (empty when it can be ordered). */
export function validateSelection(
  item: SelectableItemDef,
  selection: ItemSelection,
): SelectionIssue[] {
  return evaluate(item, selection).issues;
}

/** Unit price of a valid selection: variant (or base) price plus modifier deltas. */
export function unitPriceOf(item: SelectableItemDef, selection: ItemSelection): Paise {
  const { issues, unitPrice } = evaluate(item, selection);
  if (issues.length > 0) {
    throw new DomainError('INVALID_SELECTION', issues.map((issue) => issue.message).join('; '), {
      itemId: item.id,
      issues,
    });
  }
  assertPaise(unitPrice, 'unit price');
  return unitPrice;
}
