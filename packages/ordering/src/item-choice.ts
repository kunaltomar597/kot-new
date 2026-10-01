import type { MenuItem, MenuSnapshot } from '@rp/contracts';
import {
  DEFAULT_TIME_ZONE,
  type ItemSelection,
  type ModifierGroupDef,
  type SelectionIssue,
} from '@rp/domain';
import type { Translator } from '@rp/i18n';
import { comboOnNow } from './line-check.js';
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

export type UnavailableReason = 'SOLD_OUT' | 'NOT_AVAILABLE' | 'NOT_NOW';

/**
 * Why an item cannot be ordered right now, or undefined when it can: sold out or switched off
 * (MENU-006, WTR-010), or, given the menu and the time, a combo outside its dates or hours
 * (MENU-005, NOT_NOW). Every surface asks this, and the server checks the same (`comboOnNow`).
 */
export function unavailableReason(
  item: MenuItem,
  at?: { readonly menu: MenuSnapshot; readonly now: Date | number },
): UnavailableReason | undefined {
  if (item.stockCount === 0) return 'SOLD_OUT';
  if (!item.available) return 'NOT_AVAILABLE';
  if (at !== undefined) {
    const combo = comboOf(at.menu, item);
    const now = new Date(at.now);
    if (combo !== undefined && !comboOnNow(combo, now, at.menu.timeZone ?? DEFAULT_TIME_ZONE)) {
      return 'NOT_NOW';
    }
  }
  return undefined;
}

/** A combo's hours as the menu shows them ("12:00–15:00"), or undefined when it has none. */
export function comboHours(menu: MenuSnapshot, item: MenuItem): string | undefined {
  const window = comboOf(menu, item)?.timeWindow;
  return window === undefined ? undefined : `${window.start.slice(0, 5)}–${window.end.slice(0, 5)}`;
}

/** What to say about an item that cannot be ordered now. */
export function unavailableText(
  reason: UnavailableReason,
  menu: MenuSnapshot,
  item: MenuItem,
  t: Translator,
): string {
  if (reason === 'SOLD_OUT') return t('pos.menu.soldOut');
  const hours = reason === 'NOT_NOW' ? comboHours(menu, item) : undefined;
  return hours === undefined ? t('pos.menu.notAvailable') : t('pos.menu.onlyAt', { hours });
}

/**
 * What a menu card says under the name: sold out, not available or only at its hours (the card
 * cannot be chosen), how many are left, or that it is a combo or has options. Pass `now` so a
 * combo outside its hours shows as such.
 */
export function menuNote(
  menu: MenuSnapshot,
  item: MenuItem,
  t: Translator,
  now?: Date | number,
): { note?: string; unavailable?: string } {
  const reason = unavailableReason(item, now === undefined ? undefined : { menu, now });
  if (reason !== undefined) return { unavailable: unavailableText(reason, menu, item, t) };
  if (item.stockCount !== null) return { note: t('pos.menu.left', { count: item.stockCount }) };
  if (comboOf(menu, item) !== undefined) return { note: t('pos.menu.combo') };
  if (needsOptions(menu, item)) return { note: t('pos.menu.options') };
  return {};
}
