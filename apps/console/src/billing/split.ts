import type { BillView, SplitBillRequest } from '@rp/contracts';

/**
 * A split by items (BILL-007): each bill line goes to one part, whole. Parts are numbered as the
 * cashier chose them and sent in order, empty numbers skipped. Returns why it cannot be sent, or
 * the request.
 */
export function itemsSplit(
  bill: BillView,
  assignment: Readonly<Record<string, number | undefined>>,
): { ok: true; request: SplitBillRequest } | { ok: false; problem: 'UNASSIGNED' | 'NEED_TWO' } {
  const parts = new Map<number, { orderItemId: string; quantity: number }[]>();
  for (const line of bill.lines) {
    const part = assignment[line.orderItemId];
    if (part === undefined) return { ok: false, problem: 'UNASSIGNED' };
    parts.set(part, [
      ...(parts.get(part) ?? []),
      { orderItemId: line.orderItemId, quantity: line.quantity },
    ]);
  }
  if (parts.size < 2) return { ok: false, problem: 'NEED_TWO' };
  return {
    ok: true,
    request: {
      mode: 'ITEMS',
      parts: [...parts.entries()].sort(([a], [b]) => a - b).map(([, items]) => items),
      seriesId: null,
    },
  };
}
