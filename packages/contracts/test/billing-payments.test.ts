import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BillCustomerRequest,
  CloseShiftRequest,
  DiscountRequest,
  OpenBillRequest,
  PaymentRequest,
  RecordPaymentsRequest,
  SplitBillRequest,
} from '../src/index.js';

const id = () => randomUUID();

describe('[BILL-001] opening a bill', () => {
  it('takes either a table session or a takeaway order, not both or neither', () => {
    expect(OpenBillRequest.safeParse({ tableSessionId: id() }).success).toBe(true);
    expect(OpenBillRequest.safeParse({ orderId: id() }).success).toBe(true);
    expect(OpenBillRequest.safeParse({}).success).toBe(false);
    expect(OpenBillRequest.safeParse({ tableSessionId: id(), orderId: id() }).success).toBe(false);
  });
});

describe('[BILL-005] discounts', () => {
  it('needs a rate for a percentage and an amount for a flat discount, with a reason', () => {
    expect(
      DiscountRequest.parse({ kind: 'PERCENT', rateBp: 1_000, reason: 'Regular' }),
    ).toMatchObject({
      orderItemId: null,
      amount: null,
    });
    expect(
      DiscountRequest.safeParse({ kind: 'FLAT', amount: 500, reason: 'Late food' }).success,
    ).toBe(true);
    expect(
      DiscountRequest.safeParse({ kind: 'PERCENT', amount: 500, reason: 'Mixed up' }).success,
    ).toBe(false);
    expect(
      DiscountRequest.safeParse({ kind: 'FLAT', rateBp: 500, reason: 'Mixed up' }).success,
    ).toBe(false);
    expect(
      DiscountRequest.safeParse({ kind: 'PERCENT', rateBp: 10_001, reason: 'Too much' }).success,
    ).toBe(false);
    expect(DiscountRequest.safeParse({ kind: 'PERCENT', rateBp: 1_000 }).success).toBe(false);
  });
});

describe('[BILL-011] customer details', () => {
  it('keeps a phone number only with consent', () => {
    const base = { name: 'Asha', gstin: null };
    expect(
      BillCustomerRequest.safeParse({ ...base, phone: '98765 43210', phoneConsent: true }).success,
    ).toBe(true);
    expect(
      BillCustomerRequest.safeParse({ ...base, phone: '98765 43210', phoneConsent: false }).success,
    ).toBe(false);
    expect(
      BillCustomerRequest.safeParse({ ...base, phone: null, phoneConsent: false }).success,
    ).toBe(true);
  });
});

describe('[BILL-007] splitting', () => {
  it('splits by items or into 2 to 20 equal parts', () => {
    expect(SplitBillRequest.parse({ mode: 'EQUAL', parts: 3 })).toMatchObject({ seriesId: null });
    expect(SplitBillRequest.safeParse({ mode: 'EQUAL', parts: 1 }).success).toBe(false);
    expect(SplitBillRequest.safeParse({ mode: 'EQUAL', parts: 21 }).success).toBe(false);
    const part = [{ orderItemId: id(), quantity: 1 }];
    expect(SplitBillRequest.safeParse({ mode: 'ITEMS', parts: [part, part] }).success).toBe(true);
    expect(SplitBillRequest.safeParse({ mode: 'ITEMS', parts: [part] }).success).toBe(false);
    expect(SplitBillRequest.safeParse({ mode: 'ITEMS', parts: [part, []] }).success).toBe(false);
  });
});

describe('[BILL-008] payments', () => {
  it('allows tendered only on cash and a mode name only for OTHER', () => {
    expect(PaymentRequest.parse({ mode: 'CASH', amount: 100, tendered: 500 })).toMatchObject({
      reference: null,
      otherModeName: null,
    });
    expect(PaymentRequest.safeParse({ mode: 'CARD', amount: 100, tendered: 500 }).success).toBe(
      false,
    );
    expect(PaymentRequest.safeParse({ mode: 'OTHER', amount: 100 }).success).toBe(false);
    expect(
      PaymentRequest.safeParse({ mode: 'OTHER', amount: 100, otherModeName: 'Dineout' }).success,
    ).toBe(true);
    expect(
      PaymentRequest.safeParse({ mode: 'UPI', amount: 100, otherModeName: 'Dineout' }).success,
    ).toBe(false);
    expect(PaymentRequest.safeParse({ mode: 'UPI', amount: 0 }).success).toBe(false);
  });

  it('carries an idempotency key and at most ten payments', () => {
    const payment = { mode: 'UPI', amount: 100 };
    expect(RecordPaymentsRequest.safeParse({ idempotencyKey: id(), payments: [] }).success).toBe(
      true,
    );
    expect(RecordPaymentsRequest.safeParse({ payments: [payment] }).success).toBe(false);
    expect(
      RecordPaymentsRequest.safeParse({
        idempotencyKey: id(),
        payments: new Array(11).fill(payment),
      }).success,
    ).toBe(false);
  });
});

describe('[BILL-013] closing a shift', () => {
  it('takes the counted cash or a denomination count, not both or neither', () => {
    expect(CloseShiftRequest.safeParse({ countedCash: 1_000 }).success).toBe(true);
    expect(CloseShiftRequest.safeParse({ denominations: { '500': 2, '0.5': 4 } }).success).toBe(
      true,
    );
    expect(CloseShiftRequest.safeParse({}).success).toBe(false);
    expect(CloseShiftRequest.safeParse({ countedCash: 1, denominations: { '1': 1 } }).success).toBe(
      false,
    );
    expect(CloseShiftRequest.safeParse({ denominations: { abc: 1 } }).success).toBe(false);
  });
});
