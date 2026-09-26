import { describe, expect, it } from 'vitest';
import { applyPayments, cashVariance, countDenominations, expectedCash } from '../src/payments.js';

describe('[BILL-008] recording payments', () => {
  it('splits across modes and settles when the payments equal the total', () => {
    const outcome = applyPayments(61_200, 0, [
      { mode: 'CARD', amount: 40_000 },
      { mode: 'CASH', amount: 21_200, tendered: 25_000 },
    ]);
    expect(outcome).toMatchObject({ paid: 61_200, remaining: 0, settled: true });
    expect(outcome.payments[1]).toEqual({
      mode: 'CASH',
      amount: 21_200,
      tendered: 25_000,
      change: 3_800,
    });
    expect(outcome.payments[0]).toMatchObject({ tendered: null, change: null });
  });

  it('takes a bill in several steps and stays open until it is fully paid', () => {
    const first = applyPayments(10_000, 0, [{ mode: 'UPI', amount: 4_000 }]);
    expect(first).toMatchObject({ paid: 4_000, remaining: 6_000, settled: false });
    const second = applyPayments(10_000, first.paid, [{ mode: 'CASH', amount: 6_000 }]);
    expect(second).toMatchObject({ remaining: 0, settled: true });
    expect(second.payments[0]).toMatchObject({ tendered: 6_000, change: 0 });
  });

  it('refuses paying more than the bill, cash tendered short, zero payments and tendered on cards', () => {
    expect(() => applyPayments(10_000, 6_000, [{ mode: 'CARD', amount: 5_000 }])).toThrow(
      expect.objectContaining({ code: 'OVERPAYMENT' }),
    );
    expect(() =>
      applyPayments(10_000, 0, [{ mode: 'CASH', amount: 5_000, tendered: 4_000 }]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PAYMENT' }));
    expect(() => applyPayments(10_000, 0, [{ mode: 'UPI', amount: 0 }])).toThrow(/more than zero/);
    expect(() => applyPayments(10_000, 0, [{ mode: 'CARD', amount: 100, tendered: 200 }])).toThrow(
      /Only cash/,
    );
  });

  it('settles a bill of zero (everything complimentary) with no payments', () => {
    expect(applyPayments(0, 0, [])).toMatchObject({ settled: true, remaining: 0 });
  });
});

describe('[BILL-013] [AUD-006] shift cash', () => {
  it('expects float plus cash sales plus cash in minus cash out, and records the variance', () => {
    const expected = expectedCash({
      openingFloat: 200_000,
      cashPayments: 150_000,
      cashIn: 10_000,
      cashOut: 25_000,
    });
    expect(expected).toBe(335_000);
    expect(cashVariance(334_500, expected)).toBe(-500);
    expect(cashVariance(335_000, expected)).toBe(0);
  });

  it('counts denominations in rupees', () => {
    expect(countDenominations({ '500': 4, '100': 12, '10': 3, '0.5': 2 })).toBe(323_100);
    expect(() => countDenominations({ '-5': 1 })).toThrow();
  });
});
