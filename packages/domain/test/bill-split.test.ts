import { describe, expect, it } from 'vitest';
import { type BillInput, computeBill } from '../src/bill.js';
import { type SplitPart, splitBill } from '../src/bill-split.js';
import { sum } from '../src/money.js';

const GST5 = {
  id: 'gst5',
  name: 'GST 5 %',
  components: [
    { code: 'CGST', rateBp: 250 },
    { code: 'SGST', rateBp: 250 },
  ],
};
const GST18 = {
  id: 'gst18',
  name: 'GST 18 %',
  components: [
    { code: 'CGST', rateBp: 900 },
    { code: 'SGST', rateBp: 900 },
  ],
};

const INPUT: BillInput = {
  priceMode: 'TAX_EXCLUSIVE',
  lines: [
    { id: 'tikka', unitPrice: 28_000, quantity: 3, taxGroupId: 'gst5' },
    {
      id: 'lassi',
      unitPrice: 8_333,
      quantity: 2,
      taxGroupId: 'gst5',
      discount: { kind: 'PERCENT', rateBp: 1_000 },
    },
    { id: 'water', unitPrice: 2_000, quantity: 1, taxGroupId: 'gst18' },
  ],
  taxGroups: [GST5, GST18],
  billDiscount: { kind: 'FLAT', amount: 1_001 },
  serviceCharge: { rateBp: 500, taxGroupId: 'gst5' },
  roundOff: { kind: 'NEAREST', unit: 100 },
};

/** Every amount of the parts adds up to the whole bill. */
function expectExact(parts: readonly SplitPart[], input: BillInput) {
  const bill = computeBill(input);
  const total = (pick: (part: SplitPart) => number) => sum(parts.map(pick));
  expect(total((part) => part.subtotal)).toBe(bill.subtotal);
  expect(total((part) => part.discountTotal)).toBe(bill.discountTotal);
  expect(total((part) => part.serviceCharge)).toBe(bill.serviceCharge);
  expect(total((part) => part.taxTotal)).toBe(bill.taxTotal);
  expect(total((part) => part.roundOff)).toBe(bill.roundOff);
  expect(total((part) => part.grandTotal)).toBe(bill.grandTotal);
  for (const code of ['CGST', 'SGST']) {
    const partTax = total((part) =>
      sum(
        part.taxLines.flatMap((line) =>
          line.components.filter((c) => c.code === code).map((c) => c.amount),
        ),
      ),
    );
    const billTax = sum(
      bill.taxLines.flatMap((line) =>
        line.components.filter((c) => c.code === code).map((c) => c.amount),
      ),
    );
    expect(partTax).toBe(billTax);
  }
  for (const part of parts) {
    expect(part.grandTotal).toBe(part.totalBeforeRoundOff + part.roundOff);
  }
}

describe('[BILL-007] splitting a bill', () => {
  it('splits into equal parts that add up exactly, component by component', () => {
    const bill = computeBill(INPUT);
    for (const count of [2, 3, 7]) {
      const parts = splitBill(
        bill,
        Array.from({ length: count }, () => [1, 1, 1]),
      );
      expect(parts).toHaveLength(count);
      expectExact(parts, INPUT);
      const totals = parts.map((part) => part.grandTotal);
      // Equal parts differ by a few paise at most: each amount spreads its remainder.
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(20);
    }
  });

  it('splits by items: each part carries only its items, and the whole still adds up', () => {
    const bill = computeBill(INPUT);
    // Part 1: two tikkas and the water; part 2: one tikka and both lassis.
    const parts = splitBill(bill, [
      [2, 0, 1],
      [1, 2, 0],
    ]);
    expectExact(parts, INPUT);
    expect(parts[0]?.lines.map((line) => [line.lineId, line.share])).toEqual([
      ['tikka', 2],
      ['water', 1],
    ]);
    expect(parts[1]?.lines.map((line) => line.lineId)).toEqual(['tikka', 'lassi']);
    expect(parts[0]?.lines[0]?.grossAmount).toBe(56_000);
    // Part 2 has no 18 % item, so no 18 % tax.
    expect(parts[1]?.taxLines.some((line) => line.taxGroupId === 'gst18')).toBe(false);
  });

  it('works for tax-inclusive prices and without round-off', () => {
    const input: BillInput = { ...INPUT, priceMode: 'TAX_INCLUSIVE', roundOff: { kind: 'NONE' } };
    const parts = splitBill(computeBill(input), [
      [1, 1, 0],
      [1, 1, 0],
      [1, 0, 1],
    ]);
    expectExact(parts, input);
  });

  it('refuses a line that goes nowhere, a part that takes nothing, and a single part', () => {
    const bill = computeBill(INPUT);
    expect(() =>
      splitBill(bill, [
        [3, 2, 0],
        [0, 0, 0],
      ]),
    ).toThrow(/take something/);
    expect(() =>
      splitBill(bill, [
        [3, 0, 0],
        [0, 2, 0],
      ]),
    ).toThrow(/go to a part/);
    expect(() => splitBill(bill, [[3, 2, 1]])).toThrow(/at least two/);
    expect(() =>
      splitBill(bill, [
        [3, 2],
        [0, 0, 1],
      ]),
    ).toThrow(/every line/);
  });
});
