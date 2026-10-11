import type { MenuItem, MenuSnapshot, OrderLineRequest, RejectedLine } from '@rp/contracts';
import {
  calendarDateOf,
  inTimeWindow,
  timeOfDayOf,
  unitPriceOf,
  validateSelection,
} from '@rp/domain';
import type { SalesChannel } from './menu-view.js';

/**
 * The check every order line passes before anything is created (ORD-014, ORD-017, MENU-012): the
 * local server runs it on every submission, and the QR relay runs it on a diner's order against
 * the latest published menu (QR-006), so both refuse the same lines for the same reasons.
 */

/** A line checked and priced from the published menu, never from what the client claimed. */
export interface ResolvedOrderLine {
  readonly request: OrderLineRequest;
  readonly item: MenuItem;
  readonly variantName: string | null;
  readonly modifiers: readonly { optionId: string; name: string; priceDelta: number }[];
  readonly unitPrice: number;
  /** Combo parts with their per-combo quantity (MENU-005). */
  readonly components: readonly { item: MenuItem; quantity: number }[];
}

export interface LineCheckContext {
  /** Where the order comes from; an item must be offered there. */
  readonly channel: SalesChannel;
  /** ORD-015: the restaurant's limit on a line's instructions. */
  readonly instructionMaxLength: number;
  readonly now: Date;
  /** The restaurant's time zone, for combos offered on some days or hours. */
  readonly timeZone: string;
}

export function rejectLine(
  line: Pick<OrderLineRequest, 'clientLineId'>,
  code: RejectedLine['code'],
  message: string,
): RejectedLine {
  return { clientLineId: line.clientLineId, code, message };
}

/** Whether a combo is offered at `now`: its dates and its time of day (MENU-005). */
export function comboOnNow(
  combo: MenuSnapshot['combos'][number],
  now: Date,
  timeZone: string,
): boolean {
  const today = calendarDateOf(now, timeZone);
  if (combo.activeFrom !== undefined && today < combo.activeFrom) return false;
  if (combo.activeUntil !== undefined && today > combo.activeUntil) return false;
  return (
    combo.timeWindow === undefined || inTimeWindow(timeOfDayOf(now, timeZone), combo.timeWindow)
  );
}

/** Whether an item is served at `now` by its own daily hours (MENU-007); always when it has none. */
export function itemHoursOnNow(item: MenuItem, now: Date, timeZone: string): boolean {
  return item.timeWindow === undefined || inTimeWindow(timeOfDayOf(now, timeZone), item.timeWindow);
}

/** An item's or its combo's hours as the menu shows them ("07:00–11:00"), if it has any. */
export function hoursOf(menu: MenuSnapshot, item: MenuItem): string | undefined {
  const window =
    item.timeWindow ?? menu.combos.find((combo) => combo.itemId === item.id)?.timeWindow;
  return window === undefined ? undefined : `${window.start.slice(0, 5)}–${window.end.slice(0, 5)}`;
}

/**
 * The items that cannot be ordered at `now` though they are available: outside their own hours
 * (MENU-007), or combos outside their dates or hours (MENU-005). Suggestions leave them out.
 */
export function itemsOffNow(menu: MenuSnapshot, now: Date, timeZone: string): Set<string> {
  return new Set([
    ...menu.items.filter((item) => !itemHoursOnNow(item, now, timeZone)).map((item) => item.id),
    ...menu.combos
      .filter((combo) => !comboOnNow(combo, now, timeZone))
      .map((combo) => combo.itemId),
  ]);
}

/** Checks and prices one line against `menu`; a rejection says why, in words for the person. */
export function resolveOrderLine(
  menu: MenuSnapshot,
  line: OrderLineRequest,
  context: LineCheckContext,
): ResolvedOrderLine | RejectedLine {
  const items = new Map(menu.items.map((item) => [item.id, item]));
  const item = items.get(line.itemId);
  if (item === undefined || item.archived) {
    return rejectLine(line, 'ARCHIVED', 'This item is no longer on the menu.');
  }
  if (!item.available) {
    return item.stockCount === 0
      ? rejectLine(line, 'OUT_OF_STOCK', `${item.name} is out of stock.`)
      : rejectLine(line, 'NOT_AVAILABLE_NOW', `${item.name} is not available right now.`);
  }
  if (!item.channels.includes(context.channel)) {
    return rejectLine(line, 'NOT_ON_CHANNEL', `${item.name} cannot be ordered here.`);
  }
  if (!itemHoursOnNow(item, context.now, context.timeZone)) {
    return rejectLine(
      line,
      'NOT_AVAILABLE_NOW',
      `${item.name} is served ${hoursOf(menu, item) ?? ''} only.`,
    );
  }
  if ((line.instructions?.length ?? 0) > context.instructionMaxLength) {
    return rejectLine(
      line,
      'INVALID_SELECTION',
      `Instructions are limited to ${String(context.instructionMaxLength)} characters.`,
    );
  }

  const groups = new Map(menu.modifierGroups.map((group) => [group.id, group]));
  const definition = {
    id: item.id,
    basePrice: item.basePrice,
    variants: item.variants,
    modifierGroups: item.modifierGroupIds.flatMap((id) => {
      const group = groups.get(id);
      return group === undefined ? [] : [group];
    }),
  };
  const selection = {
    ...(line.variantId !== undefined && { variantId: line.variantId }),
    modifiers: line.modifiers,
  };
  const issues = validateSelection(definition, selection);
  if (issues.length > 0) {
    return rejectLine(line, 'INVALID_SELECTION', issues.map((issue) => issue.message).join('; '));
  }

  const components: { item: MenuItem; quantity: number }[] = [];
  const combo = menu.combos.find((entry) => entry.itemId === item.id);
  if (combo !== undefined) {
    if (!comboOnNow(combo, context.now, context.timeZone)) {
      return rejectLine(line, 'NOT_AVAILABLE_NOW', `${item.name} is not offered at this time.`);
    }
    const choices = [...(line.comboChoices ?? [])];
    const slots = combo.components.filter((component) => component.kind === 'CHOICE');
    if (choices.length !== slots.length) {
      return rejectLine(
        line,
        'INVALID_SELECTION',
        `Choose one item for each part of ${item.name}.`,
      );
    }
    for (const component of combo.components) {
      const chosen = component.kind === 'FIXED' ? component.itemId : choices.shift();
      if (
        component.kind === 'CHOICE' &&
        (chosen === undefined || !component.itemIds.includes(chosen))
      ) {
        return rejectLine(
          line,
          'INVALID_SELECTION',
          `That is not one of the choices for ${component.label}.`,
        );
      }
      const part = items.get(chosen ?? '');
      if (part?.available !== true) {
        return rejectLine(line, 'OUT_OF_STOCK', `Part of ${item.name} is out of stock.`);
      }
      if (!itemHoursOnNow(part, context.now, context.timeZone)) {
        return rejectLine(
          line,
          'NOT_AVAILABLE_NOW',
          `${part.name} in ${item.name} is served ${hoursOf(menu, part) ?? ''} only.`,
        );
      }
      components.push({ item: part, quantity: component.quantity });
    }
  } else if ((line.comboChoices ?? []).length > 0) {
    return rejectLine(line, 'INVALID_SELECTION', `${item.name} is not a combo.`);
  }

  const chosen = new Set(line.modifiers.flatMap((modifier) => modifier.optionIds));
  const modifiers = definition.modifierGroups.flatMap((group) =>
    group.options
      .filter((option) => chosen.has(option.id))
      .map((option) => ({ optionId: option.id, name: option.name, priceDelta: option.priceDelta })),
  );
  return {
    request: line,
    item,
    variantName: item.variants.find((variant) => variant.id === line.variantId)?.name ?? null,
    modifiers,
    unitPrice: unitPriceOf(definition, selection),
    components,
  };
}

/** Whether `resolveOrderLine` refused the line. */
export function isRejectedLine(line: ResolvedOrderLine | RejectedLine): line is RejectedLine {
  return 'code' in line;
}
