import type { ApprovalChange, OrderView, PendingApprovalsResponse } from '@rp/contracts';

type Entry = PendingApprovalsResponse['orders'][number];
type Item = OrderView['items'][number];

/** Events after which the approvals inbox is read again (WTR-004). */
export const affectsApprovals = (eventType: string) =>
  /^(OrderSubmitted|OrderApproved|OrderRejected|TableMoved|TableClosed|TableWaiterChanged)$/.test(
    eventType,
  );

/** A diner's line waiting for approval, as the inbox shows it. */
export interface WaitingLine {
  readonly id: string;
  readonly name: string;
  /** The variant and options chosen, e.g. "Half · Extra cheese"; empty without any. */
  readonly details: string;
  readonly instructions: string | null;
  readonly quantity: number;
  readonly unitPrice: number;
}

/** The lines of an order still waiting for approval (combo parts travel with their combo). */
export function waitingLines(order: OrderView): WaitingLine[] {
  return order.items
    .filter((item: Item) => item.state === 'PENDING_APPROVAL' && item.parentOrderItemId === null)
    .map((item) => ({
      id: item.id,
      name: item.name,
      details: [item.variantName, ...item.modifiers.map((modifier) => modifier.name)]
        .filter((part): part is string => part !== null && part !== '')
        .join(' · '),
      instructions: item.instructions,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    }));
}

/** The quantities the approver set, where they differ from the diner's (0 removes a line). */
export function approvalChanges(
  lines: readonly WaitingLine[],
  quantities: ReadonlyMap<string, number>,
): ApprovalChange[] {
  return lines.flatMap((line) => {
    const quantity = quantities.get(line.id);
    return quantity === undefined || quantity === line.quantity
      ? []
      : [{ orderItemId: line.id, quantity }];
  });
}

/** The waiting lines' value before tax at the quantities shown. */
export function approvalTotal(
  lines: readonly WaitingLine[],
  quantities: ReadonlyMap<string, number> = new Map(),
): number {
  return lines.reduce(
    (total, line) => total + line.unitPrice * (quantities.get(line.id) ?? line.quantity),
    0,
  );
}

/** Whether approving these quantities leaves anything to send (else: reject instead). */
export function anythingLeft(
  lines: readonly WaitingLine[],
  quantities: ReadonlyMap<string, number>,
): boolean {
  return lines.some((line) => (quantities.get(line.id) ?? line.quantity) > 0);
}

/** The inbox's entries for the tables in view; all of them without a filter. */
export function approvalsFor(entries: readonly Entry[], sessionId?: string): Entry[] {
  return sessionId === undefined
    ? [...entries]
    : entries.filter((entry) => entry.order.tableSessionId === sessionId);
}
