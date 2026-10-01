import type { OrderView } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import {
  affectsApprovals,
  anythingLeft,
  approvalChanges,
  approvalTotal,
  waitingLines,
} from '../src/index.js';

const ID = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function item(n: number, overrides: Partial<OrderView['items'][number]> = {}) {
  return {
    id: ID(n),
    itemId: ID(100 + n),
    parentOrderItemId: null,
    name: `Dish ${String(n)}`,
    variantId: null,
    variantName: null,
    modifiers: [],
    quantity: 1,
    unitPrice: 10_000,
    lineTotal: 10_000,
    stationId: ID(900),
    state: 'PENDING_APPROVAL' as const,
    instructions: null,
    ...overrides,
  };
}

const order: OrderView = {
  id: ID(1),
  orderNumber: 12,
  orderType: 'DINE_IN',
  source: 'TABLE_TABLET',
  status: 'OPEN',
  tableSessionId: ID(2),
  tableId: ID(3),
  takeawayToken: null,
  customerName: null,
  businessDate: '2026-10-02',
  createdAt: '2026-10-02T08:00:00.000Z',
  note: null,
  items: [
    item(1, {
      name: 'Pizza',
      variantName: 'Large',
      modifiers: [{ optionId: ID(50), name: 'Extra cheese', priceDelta: 4_000 }],
      quantity: 2,
      unitPrice: 44_000,
      lineTotal: 88_000,
    }),
    item(2, { name: 'Lassi', instructions: 'Less sugar' }),
    // A combo part travels with its combo; a sent line is not waiting.
    item(3, { name: 'Part', parentOrderItemId: ID(1), unitPrice: 0, lineTotal: 0 }),
    item(4, { name: 'Water', state: 'SENT' }),
  ],
  kots: [],
};

describe('[WTR-004] [ORD-003] the approvals inbox', () => {
  it('lists the waiting lines with what was chosen', () => {
    expect(waitingLines(order)).toEqual([
      {
        id: ID(1),
        name: 'Pizza',
        details: 'Large · Extra cheese',
        instructions: null,
        quantity: 2,
        unitPrice: 44_000,
      },
      {
        id: ID(2),
        name: 'Lassi',
        details: '',
        instructions: 'Less sugar',
        quantity: 1,
        unitPrice: 10_000,
      },
    ]);
  });

  it('sends only the quantities changed, and totals what is left', () => {
    const lines = waitingLines(order);
    const quantities = new Map([
      [ID(1), 1],
      [ID(2), 1],
    ]);
    expect(approvalChanges(lines, quantities)).toEqual([{ orderItemId: ID(1), quantity: 1 }]);
    expect(approvalTotal(lines)).toBe(98_000);
    expect(approvalTotal(lines, quantities)).toBe(54_000);
    expect(anythingLeft(lines, new Map([[ID(1), 0]]))).toBe(true);
    expect(
      anythingLeft(
        lines,
        new Map([
          [ID(1), 0],
          [ID(2), 0],
        ]),
      ),
    ).toBe(false);
  });

  it('reads the inbox again on orders and table moves', () => {
    expect(affectsApprovals('OrderSubmitted')).toBe(true);
    expect(affectsApprovals('OrderApproved')).toBe(true);
    expect(affectsApprovals('TableClosed')).toBe(true);
    expect(affectsApprovals('KotBumped')).toBe(false);
  });
});
