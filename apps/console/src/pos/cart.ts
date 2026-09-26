import type { OrderLineRequest } from '@rp/contracts';
import { multiply, sum, type ItemSelection } from '@rp/domain';

/** One line waiting to be sent (ORD-001). Prices are estimates; the server prices the order. */
export interface CartLine {
  readonly clientLineId: string;
  readonly itemId: string;
  readonly name: string;
  /** Variant, modifiers and combo choices in words, e.g. "Full · Cheese". */
  readonly summary: string;
  readonly quantity: number;
  readonly selection: ItemSelection;
  readonly comboChoices?: readonly string[];
  readonly instructions: string;
  /** Estimated unit price from `@rp/domain` `unitPriceOf`. */
  readonly unitPrice: number;
  /** Why the server refused this line last time (ORD-017), until it is changed. */
  readonly error?: string;
}

export type NewCartLine = Omit<CartLine, 'clientLineId' | 'error'>;

const MAX_QUANTITY = 99;

function sameChoice(a: NewCartLine, b: CartLine): boolean {
  return (
    a.itemId === b.itemId &&
    a.instructions === b.instructions &&
    JSON.stringify(a.selection) === JSON.stringify(b.selection) &&
    JSON.stringify(a.comboChoices ?? []) === JSON.stringify(b.comboChoices ?? [])
  );
}

/** Adds a line, or raises the quantity of an identical one (same item, options and note). */
export function addLine(
  lines: readonly CartLine[],
  line: NewCartLine,
  newId: () => string,
): CartLine[] {
  const same = lines.find((existing) => sameChoice(line, existing));
  if (same === undefined) return [...lines, { ...line, clientLineId: newId() }];
  return lines.map((existing) =>
    existing === same
      ? {
          ...existing,
          quantity: Math.min(MAX_QUANTITY, existing.quantity + line.quantity),
          error: undefined,
        }
      : existing,
  );
}

export function updateLine(
  lines: readonly CartLine[],
  clientLineId: string,
  change: Partial<Pick<CartLine, 'quantity' | 'instructions'>>,
): CartLine[] {
  return lines.map((line) =>
    line.clientLineId === clientLineId ? { ...line, ...change, error: undefined } : line,
  );
}

export function removeLine(lines: readonly CartLine[], clientLineId: string): CartLine[] {
  return lines.filter((line) => line.clientLineId !== clientLineId);
}

/** Marks the lines the server refused with its reason (ORD-017). */
export function markRejected(
  lines: readonly CartLine[],
  rejected: readonly { clientLineId: string; message: string }[],
): CartLine[] {
  const reasons = new Map(rejected.map((line) => [line.clientLineId, line.message]));
  return lines.map((line) => {
    const reason = reasons.get(line.clientLineId);
    return reason === undefined ? line : { ...line, error: reason };
  });
}

export function cartTotal(lines: readonly CartLine[]): number {
  return sum(lines.map((line) => multiply(line.unitPrice, line.quantity)));
}

/** The lines as the order contract takes them: no prices (ORD-014). */
export function requestLines(lines: readonly CartLine[]): OrderLineRequest[] {
  return lines.map((line) => ({
    clientLineId: line.clientLineId,
    itemId: line.itemId,
    quantity: line.quantity,
    ...(line.selection.variantId !== undefined && { variantId: line.selection.variantId }),
    modifiers: (line.selection.modifiers ?? []).map((entry) => ({
      groupId: entry.groupId,
      optionIds: [...entry.optionIds],
    })),
    ...(line.comboChoices !== undefined && { comboChoices: [...line.comboChoices] }),
    ...(line.instructions.trim() !== '' && { instructions: line.instructions.trim() }),
  }));
}
