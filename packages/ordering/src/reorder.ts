import type { MenuSnapshot, OrderView } from '@rp/contracts';
import { type ItemSelection, unitPriceOf, validateSelection } from '@rp/domain';
import type { Translator } from '@rp/i18n';
import type { CartLine, NewCartLine } from './cart.js';
import { summaryOf, unavailableReason } from './item-choice.js';
import { comboOf, comboSlots, type SalesChannel, selectable } from './menu-view.js';

type SentLine = OrderView['items'][number];

/**
 * A sent line ordered again with the same variant, options, combo choices and note, one of it
 * (NFR-U03: "the same again" in one tap). Undefined when the menu no longer offers it that way:
 * the item is gone from this channel, or a variant, option or combo choice has changed; the
 * person then chooses again.
 */
export function againLine(
  menu: MenuSnapshot,
  order: OrderView,
  line: SentLine,
  channel: SalesChannel,
): NewCartLine | undefined {
  const item = menu.items.find((candidate) => candidate.id === line.itemId);
  if (item === undefined || item.archived || !item.channels.includes(channel)) return undefined;
  const def = selectable(menu, item);
  if (line.variantId !== null && !def.variants.some((variant) => variant.id === line.variantId)) {
    return undefined;
  }
  const byGroup = new Map<string, string[]>();
  for (const { optionId } of line.modifiers) {
    const group = def.modifierGroups.find((candidate) =>
      candidate.options.some((option) => option.id === optionId),
    );
    if (group === undefined) return undefined;
    byGroup.set(group.id, [...(byGroup.get(group.id) ?? []), optionId]);
  }
  const selection: ItemSelection = {
    ...(line.variantId !== null && { variantId: line.variantId }),
    ...(byGroup.size > 0 && {
      modifiers: [...byGroup].map(([groupId, optionIds]) => ({ groupId, optionIds })),
    }),
  };
  if (validateSelection(def, selection).length > 0) return undefined;

  let comboChoices: string[] | undefined;
  const combo = comboOf(menu, item);
  const slots = combo === undefined ? [] : comboSlots(menu, combo);
  if (slots.length > 0) {
    // The combo's parts were ordered in component order; each choice slot takes the first
    // part not yet used that is one of its options.
    const parts = order.items.filter((part) => part.parentOrderItemId === line.id);
    const used = new Set<string>();
    comboChoices = [];
    for (const slot of slots) {
      const part = parts.find(
        (candidate) =>
          !used.has(candidate.id) && slot.options.some((option) => option.id === candidate.itemId),
      );
      if (part === undefined) return undefined;
      used.add(part.id);
      comboChoices.push(part.itemId);
    }
  }

  return {
    itemId: item.id,
    name: item.name,
    summary: summaryOf(menu, item, selection, comboChoices),
    quantity: 1,
    selection,
    ...(comboChoices !== undefined && { comboChoices }),
    instructions: line.instructions ?? '',
    unitPrice: unitPriceOf(def, selection),
  };
}

/** Why the kitchen cannot make a line now, from the live menu (WTR-010). */
export type LineProblem =
  | { readonly kind: 'SOLD_OUT' }
  | { readonly kind: 'NOT_AVAILABLE' }
  | { readonly kind: 'OFF_MENU' }
  | { readonly kind: 'TOO_FEW_LEFT'; readonly left: number };

/**
 * The cart lines that cannot be sent as they are, by client line id: sold out or switched off
 * since they were added, no longer sold on this channel, or more than the stock left (counting
 * every line of the item). The server checks again when the order is sent.
 */
export function lineProblems(
  menu: MenuSnapshot,
  lines: readonly CartLine[],
  channel: SalesChannel,
): Map<string, LineProblem> {
  const problems = new Map<string, LineProblem>();
  const wanted = new Map<string, number>();
  for (const line of lines) {
    wanted.set(line.itemId, (wanted.get(line.itemId) ?? 0) + line.quantity);
  }
  for (const line of lines) {
    const item = menu.items.find((candidate) => candidate.id === line.itemId);
    if (item === undefined || item.archived || !item.channels.includes(channel)) {
      problems.set(line.clientLineId, { kind: 'OFF_MENU' });
      continue;
    }
    const reason = unavailableReason(item);
    if (reason !== undefined) {
      problems.set(line.clientLineId, { kind: reason });
    } else if (item.stockCount !== null && (wanted.get(item.id) ?? 0) > item.stockCount) {
      problems.set(line.clientLineId, { kind: 'TOO_FEW_LEFT', left: item.stockCount });
    }
  }
  return problems;
}

export function lineProblemText(problem: LineProblem, t: Translator): string {
  switch (problem.kind) {
    case 'SOLD_OUT':
      return t('pos.menu.soldOut');
    case 'NOT_AVAILABLE':
      return t('pos.menu.notAvailable');
    case 'OFF_MENU':
      return t('pos.cart.offMenu');
    case 'TOO_FEW_LEFT':
      return t('pos.cart.onlyLeft', { count: problem.left });
  }
}
