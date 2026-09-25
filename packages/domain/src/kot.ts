import { DomainError } from './errors.js';

/**
 * Kitchen Order Ticket routing (ORD-007, MENU-005, KDS-003): items are split by kitchen station,
 * one KOT per station; combos are exploded into their component items, each routed to its own
 * station and grouped under the combo name on the ticket.
 */

export interface KotComponentInput {
  readonly itemId: string;
  readonly name: string;
  /** Units of this component per one combo. */
  readonly quantity: number;
  readonly stationId: string;
  readonly variantName?: string;
  readonly modifiers?: readonly string[];
}

export interface KotItemInput {
  readonly orderItemId: string;
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number;
  /** Ignored for combos (components carry their own station). */
  readonly stationId?: string;
  readonly variantName?: string;
  readonly modifiers?: readonly string[];
  readonly instructions?: string;
  readonly comboComponents?: readonly KotComponentInput[];
}

export interface KotLine {
  readonly orderItemId: string;
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number;
  readonly variantName?: string;
  readonly modifiers: readonly string[];
  readonly instructions?: string;
  /** Set when this line is a component of a combo. */
  readonly comboName?: string;
}

export interface KotDraft {
  readonly stationId: string;
  readonly lines: readonly KotLine[];
}

function assertQuantity(quantity: number, label: string): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new DomainError('INVALID_QUANTITY', `${label} quantity must be a positive integer`, {
      quantity,
    });
  }
}

/** Splits items into per-station KOT drafts, in order of first appearance. */
export function splitIntoKots(items: readonly KotItemInput[]): KotDraft[] {
  const byStation = new Map<string, KotLine[]>();
  const push = (stationId: string, line: KotLine): void => {
    let lines = byStation.get(stationId);
    if (!lines) {
      lines = [];
      byStation.set(stationId, lines);
    }
    lines.push(line);
  };

  for (const item of items) {
    assertQuantity(item.quantity, item.name);
    const components = item.comboComponents ?? [];
    if (components.length > 0) {
      for (const component of components) {
        assertQuantity(component.quantity, component.name);
        push(component.stationId, {
          orderItemId: item.orderItemId,
          itemId: component.itemId,
          name: component.name,
          quantity: component.quantity * item.quantity,
          ...(component.variantName !== undefined && { variantName: component.variantName }),
          modifiers: component.modifiers ?? [],
          ...(item.instructions !== undefined && { instructions: item.instructions }),
          comboName: item.name,
        });
      }
      continue;
    }
    if (item.stationId === undefined || item.stationId === '') {
      throw new DomainError('INVALID_ARGUMENT', `Item "${item.name}" has no kitchen station`, {
        orderItemId: item.orderItemId,
      });
    }
    push(item.stationId, {
      orderItemId: item.orderItemId,
      itemId: item.itemId,
      name: item.name,
      quantity: item.quantity,
      ...(item.variantName !== undefined && { variantName: item.variantName }),
      modifiers: item.modifiers ?? [],
      ...(item.instructions !== undefined && { instructions: item.instructions }),
    });
  }

  return [...byStation.entries()].map(([stationId, lines]) => ({ stationId, lines }));
}
