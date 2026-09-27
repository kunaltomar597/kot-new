import type { MenuItem, MenuSnapshot } from '@rp/contracts';
import type { ItemSelection, ModifierGroupDef, SelectionIssue } from '@rp/domain';
import type { Translator } from '@rp/i18n';
import { comboOf, comboSlots, needsOptions, selectable } from './menu-view.js';

/** A modifier group's rule in words: "Up to 2", "Choose 1", "Choose 1 to 3". */
export function ruleOf(group: ModifierGroupDef, t: Translator): string {
  if (group.minSelections === 0) return t('pos.item.ruleOptional', { max: group.maxSelections });
  if (group.minSelections === group.maxSelections) {
    return t('pos.item.ruleExactly', { count: group.minSelections });
  }
  return t('pos.item.ruleRange', { min: group.minSelections, max: group.maxSelections });
}

/** What is wrong with a choice, in words (MENU-004). */
export function issueText(
  issue: SelectionIssue,
  groups: readonly ModifierGroupDef[],
  t: Translator,
): string {
  const group = groups.find((candidate) => candidate.id === issue.groupId);
  switch (issue.code) {
    case 'VARIANT_REQUIRED':
      return t('pos.item.issue.VARIANT_REQUIRED');
    case 'TOO_FEW_MODIFIERS':
      return t('pos.item.issue.TOO_FEW_MODIFIERS', { min: group?.minSelections ?? 1 });
    case 'TOO_MANY_MODIFIERS':
      return t('pos.item.issue.TOO_MANY_MODIFIERS', { max: group?.maxSelections ?? 1 });
    default:
      return t('pos.item.issue.other');
  }
}

/** "Full · Cheese, Butter · Dessert: Rasmalai": a line's choices in words. */
export function summaryOf(
  menu: MenuSnapshot,
  item: MenuItem,
  selection: ItemSelection,
  comboChoices: readonly string[] | undefined,
): string {
  const def = selectable(menu, item);
  const parts: string[] = [];
  const variant = def.variants.find((candidate) => candidate.id === selection.variantId);
  if (variant !== undefined) parts.push(variant.name);
  for (const entry of selection.modifiers ?? []) {
    const group = def.modifierGroups.find((candidate) => candidate.id === entry.groupId);
    const names = entry.optionIds.flatMap((id) => {
      const option = group?.options.find((candidate) => candidate.id === id);
      return option === undefined ? [] : [option.name];
    });
    if (names.length > 0) parts.push(names.join(', '));
  }
  const combo = comboOf(menu, item);
  if (combo !== undefined && comboChoices !== undefined) {
    comboSlots(menu, combo).forEach((slot, index) => {
      const chosen = slot.options.find((option) => option.id === comboChoices[index]);
      if (chosen !== undefined) parts.push(`${slot.label}: ${chosen.name}`);
    });
  }
  return parts.join(' · ');
}

/** Why an item cannot be ordered right now (MENU-006, WTR-010), or undefined when it can. */
export function unavailableReason(item: MenuItem): 'SOLD_OUT' | 'NOT_AVAILABLE' | undefined {
  if (item.stockCount === 0) return 'SOLD_OUT';
  if (!item.available) return 'NOT_AVAILABLE';
  return undefined;
}

/**
 * What a menu card says under the name: sold out or not available (the card cannot be chosen),
 * how many are left, or that it is a combo or has options.
 */
export function menuNote(
  menu: MenuSnapshot,
  item: MenuItem,
  t: Translator,
): { note?: string; unavailable?: string } {
  const reason = unavailableReason(item);
  if (reason === 'SOLD_OUT') return { unavailable: t('pos.menu.soldOut') };
  if (reason === 'NOT_AVAILABLE') return { unavailable: t('pos.menu.notAvailable') };
  if (item.stockCount !== null) return { note: t('pos.menu.left', { count: item.stockCount }) };
  if (comboOf(menu, item) !== undefined) return { note: t('pos.menu.combo') };
  if (needsOptions(menu, item)) return { note: t('pos.menu.options') };
  return {};
}
