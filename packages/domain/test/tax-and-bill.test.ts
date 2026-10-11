import { describe, expect, it } from 'vitest';
import {
  computeBill,
  computeGroupTax,
  decideDiscount,
  discountAmount,
  effectiveDiscountRateBp,
  taxTotalsByComponent,
  totalRateBp,
  validateTaxGroup,
  type BillInput,
  type TaxGroup,
} from '../src/index.js';

const GST5: TaxGroup = {
  id: 'gst5',
  name: 'GST 5 %',
  components: [
    { code: 'CGST', rateBp: 250 },
    { code: 'SGST', rateBp: 250 },
  ],
};
const GST18: TaxGroup = {
  id: 'gst18',
  name: 'GST 18 %',
  components: [
    { code: 'CGST', rateBp: 900 },
    { code: 'SGST', rateBp: 900 },
  ],
};
const EXEMPT: TaxGroup = { id: 'exempt', name: 'Exempt', components: [] };

describe('[BILL-004] tax groups are data, never hard-coded', () => {
  it('sums component rates', () => {
    expect(totalRateBp(GST5)).toBe(500);
    expect(totalRateBp(EXEMPT)).toBe(0);
  });

  it('validates definitions', () => {
    expect(validateTaxGroup(GST5)).toEqual([]);
    expect(
      validateTaxGroup({
        id: '',
        name: ' ',
        components: [
          { code: 'CGST', rateBp: 250 },
          { code: 'CGST', rateBp: -1 },
          { code: '', rateBp: 20_000 },
        ],
      }),
    ).toHaveLength(6);
    expect(() => computeGroupTax(100, { ...GST5, id: '' }, 'TAX_EXCLUSIVE')).toThrow();
  });

  it('computes exclusive tax per component', () => {
    const result = computeGroupTax(10_000, GST5, 'TAX_EXCLUSIVE');
    expect(result).toEqual({
      taxableValue: 10_000,
      components: [
        { code: 'CGST', rateBp: 250, amount: 250 },
        { code: 'SGST', rateBp: 250, amount: 250 },
      ],
      taxTotal: 500,
      grossTotal: 10_500,
    });
    expect(computeGroupTax(12_345, GST18, 'TAX_EXCLUSIVE').taxTotal).toBe(2222);
  });

  it('backs tax out of inclusive prices and keeps the total exact', () => {
    const exact = computeGroupTax(10_500, GST5, 'TAX_INCLUSIVE');
    expect(exact.taxableValue).toBe(10_000);
    expect(exact.taxTotal).toBe(500);
    expect(exact.grossTotal).toBe(10_500);

    const odd = computeGroupTax(10_010, GST5, 'TAX_INCLUSIVE');
    expect(odd.taxableValue).toBe(9533);
    expect(odd.components.map((component) => component.amount)).toEqual([239, 238]);
    expect(odd.taxableValue + odd.taxTotal).toBe(10_010);
  });

  it('handles zero-rated groups', () => {
    expect(computeGroupTax(5000, EXEMPT, 'TAX_INCLUSIVE')).toEqual({
      taxableValue: 5000,
      components: [],
      taxTotal: 0,
      grossTotal: 5000,
    });
    expect(computeGroupTax(5000, EXEMPT, 'TAX_EXCLUSIVE').grossTotal).toBe(5000);
  });
});

describe('[BILL-005] discounts', () => {
  it('computes percentage and flat discounts', () => {
    expect(discountAmount(10_000, { kind: 'PERCENT', rateBp: 1000 })).toBe(1000);
    expect(discountAmount(10_000, { kind: 'FLAT', amount: 2500 })).toBe(2500);
    expect(() => discountAmount(10_000, { kind: 'FLAT', amount: 10_001 })).toThrow(/exceed/);
    expect(() => discountAmount(10_000, { kind: 'PERCENT', rateBp: 10_001 })).toThrow();
  });

  it('expresses flat discounts as a rate rounded up', () => {
    expect(effectiveDiscountRateBp(10_000, { kind: 'FLAT', amount: 1001 })).toBe(1001);
    expect(effectiveDiscountRateBp(3, { kind: 'FLAT', amount: 1 })).toBe(3334);
    expect(effectiveDiscountRateBp(0, { kind: 'FLAT', amount: 0 })).toBe(0);
    expect(effectiveDiscountRateBp(5000, { kind: 'PERCENT', rateBp: 750 })).toBe(750);
  });

  it('applies role limits and override rules', () => {
    expect(decideDiscount('CASHIER', 1000)).toBe('ALLOWED');
    expect(decideDiscount('CASHIER', 1001)).toBe('REQUIRES_MANAGER_OVERRIDE');
    expect(decideDiscount('CASHIER', 10_000)).toBe('REQUIRES_MANAGER_OVERRIDE');
    expect(decideDiscount('CASHIER', 500, { CASHIER: 0 })).toBe('REQUIRES_MANAGER_OVERRIDE');
    expect(decideDiscount('CASHIER', 500, {})).toBe('REQUIRES_MANAGER_OVERRIDE');
    expect(decideDiscount('MANAGER', 10_000)).toBe('ALLOWED');
    expect(decideDiscount('OWNER', 5000)).toBe('ALLOWED');
    expect(decideDiscount('WAITER', 100)).toBe('DENIED');
    expect(decideDiscount('KITCHEN', 100)).toBe('DENIED');
  });
});

function baseBill(overrides: Partial<BillInput> = {}): BillInput {
  return {
    priceMode: 'TAX_EXCLUSIVE',
    taxGroups: [GST5, GST18, EXEMPT],
    lines: [
      { id: 'a', unitPrice: 25_000, quantity: 2, taxGroupId: 'gst5' },
      { id: 'b', unitPrice: 15_000, quantity: 1, taxGroupId: 'gst5' },
      { id: 'c', unitPrice: 10_000, quantity: 1, taxGroupId: 'gst18' },
    ],
    billDiscount: { kind: 'PERCENT', rateBp: 1000 },
    roundOff: { kind: 'NEAREST', unit: 100 },
    ...overrides,
  };
}

describe('[BILL-001] bill computation', () => {
  it('computes a tax-exclusive bill with a bill discount and round-off', () => {
    const bill = computeBill(baseBill());
    expect(bill.subtotal).toBe(75_000);
    expect(bill.billDiscountTotal).toBe(7500);
    expect(bill.lines.map((line) => line.netAmount)).toEqual([45_000, 13_500, 9000]);
    expect(bill.taxLines).toEqual([
      {
        taxGroupId: 'gst5',
        taxGroupName: 'GST 5 %',
        source: 'ITEMS',
        taxableValue: 58_500,
        components: [
          { code: 'CGST', rateBp: 250, amount: 1463 },
          { code: 'SGST', rateBp: 250, amount: 1463 },
        ],
        taxTotal: 2926,
      },
      {
        taxGroupId: 'gst18',
        taxGroupName: 'GST 18 %',
        source: 'ITEMS',
        taxableValue: 9000,
        components: [
          { code: 'CGST', rateBp: 900, amount: 810 },
          { code: 'SGST', rateBp: 900, amount: 810 },
        ],
        taxTotal: 1620,
      },
    ]);
    expect(bill.taxTotal).toBe(4546);
    expect(bill.totalBeforeRoundOff).toBe(72_046);
    expect(bill.roundOff).toBe(-46);
    expect(bill.grandTotal).toBe(72_000);
    expect(bill.lines.map((line) => line.taxableValue)).toEqual([45_000, 13_500, 9000]);
    expect(taxTotalsByComponent(bill.taxLines)).toEqual({ CGST: 2273, SGST: 2273 });
  });

  it('[BILL-006] adds an optional service charge taxed with its own group', () => {
    const bill = computeBill(baseBill({ serviceCharge: { rateBp: 500, taxGroupId: 'gst18' } }));
    expect(bill.serviceCharge).toBe(3375);
    const serviceTax = bill.taxLines.find((line) => line.source === 'SERVICE_CHARGE');
    expect(serviceTax?.taxTotal).toBe(608);
    expect(bill.taxableValueTotal).toBe(67_500 + 3375);
    expect(bill.totalBeforeRoundOff).toBe(72_046 + 3983);
    expect(bill.grandTotal).toBe(76_000);
  });

  it('service charge is off unless configured', () => {
    expect(computeBill(baseBill({ serviceCharge: null })).serviceCharge).toBe(0);
  });

  it('backs tax out of tax-inclusive prices', () => {
    const bill = computeBill({
      priceMode: 'TAX_INCLUSIVE',
      taxGroups: [GST5],
      lines: [{ id: 'x', unitPrice: 10_500, quantity: 1, taxGroupId: 'gst5' }],
      roundOff: { kind: 'NONE' },
    });
    expect(bill.taxableValueTotal).toBe(10_000);
    expect(bill.taxTotal).toBe(500);
    expect(bill.grandTotal).toBe(10_500);
    expect(bill.roundOff).toBe(0);

    const discounted = computeBill({
      priceMode: 'TAX_INCLUSIVE',
      taxGroups: [GST5],
      lines: [{ id: 'x', unitPrice: 10_500, quantity: 1, taxGroupId: 'gst5' }],
      billDiscount: { kind: 'PERCENT', rateBp: 1000 },
      roundOff: { kind: 'NONE' },
    });
    expect(discounted.grandTotal).toBe(9450);
    expect(discounted.taxableValueTotal).toBe(9000);
    expect(discounted.taxTotal).toBe(450);
  });

  it('handles item discounts and complimentary items', () => {
    const bill = computeBill({
      priceMode: 'TAX_EXCLUSIVE',
      taxGroups: [GST5],
      lines: [
        {
          id: 'a',
          unitPrice: 20_000,
          quantity: 1,
          taxGroupId: 'gst5',
          discount: { kind: 'FLAT', amount: 5000 },
        },
        { id: 'b', unitPrice: 8000, quantity: 1, taxGroupId: 'gst5', complimentary: true },
      ],
      roundOff: { kind: 'NONE' },
    });
    expect(bill.itemDiscountTotal).toBe(13_000);
    expect(bill.discountTotal).toBe(13_000);
    expect(bill.lines[1]?.netAmount).toBe(0);
    expect(bill.taxableValueTotal).toBe(15_000);
    expect(bill.grandTotal).toBe(15_750);
  });

  it('computes an empty bill and an all-complimentary bill', () => {
    const empty = computeBill({
      priceMode: 'TAX_EXCLUSIVE',
      taxGroups: [],
      lines: [],
      roundOff: { kind: 'NONE' },
    });
    expect(empty.grandTotal).toBe(0);
    expect(empty.taxLines).toEqual([]);

    const allFree = computeBill({
      priceMode: 'TAX_EXCLUSIVE',
      taxGroups: [GST5],
      lines: [{ id: 'a', unitPrice: 5000, quantity: 2, taxGroupId: 'gst5', complimentary: true }],
      billDiscount: { kind: 'PERCENT', rateBp: 1000 },
      roundOff: { kind: 'NEAREST', unit: 100 },
    });
    expect(allFree.grandTotal).toBe(0);
    expect(allFree.lines[0]?.taxableValue).toBe(0);
  });

  it('rejects invalid input', () => {
    expect(() =>
      computeBill(
        baseBill({ lines: [{ id: 'a', unitPrice: 100, quantity: 0, taxGroupId: 'gst5' }] }),
      ),
    ).toThrow(/quantity/);
    expect(() =>
      computeBill(
        baseBill({ lines: [{ id: 'a', unitPrice: 1.5, quantity: 1, taxGroupId: 'gst5' }] }),
      ),
    ).toThrow();
    expect(() =>
      computeBill(
        baseBill({ lines: [{ id: 'a', unitPrice: 100, quantity: 1, taxGroupId: 'nope' }] }),
      ),
    ).toThrow(/Unknown tax group/);
    expect(() =>
      computeBill(
        baseBill({
          lines: [
            { id: 'a', unitPrice: 100, quantity: 1, taxGroupId: 'gst5' },
            { id: 'a', unitPrice: 100, quantity: 1, taxGroupId: 'gst5' },
          ],
        }),
      ),
    ).toThrow(/Duplicate/);
    expect(() =>
      computeBill(baseBill({ serviceCharge: { rateBp: 500, taxGroupId: 'nope' } })),
    ).toThrow();
  });

  it('[ORD-014] is deterministic for the same input', () => {
    expect(computeBill(baseBill())).toEqual(computeBill(baseBill()));
  });

  it('keeps every total consistent across many random bills', () => {
    let seed = 42;
    const random = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let run = 0; run < 300; run += 1) {
      const priceMode = random(2) === 0 ? 'TAX_EXCLUSIVE' : 'TAX_INCLUSIVE';
      const lineCount = 1 + random(8);
      const lines = Array.from({ length: lineCount }, (_, index) => ({
        id: `l${index}`,
        unitPrice: 100 + random(100_000),
        quantity: 1 + random(5),
        taxGroupId: ['gst5', 'gst18', 'exempt'][random(3)] ?? 'gst5',
      }));
      const bill = computeBill({
        priceMode,
        taxGroups: [GST5, GST18, EXEMPT],
        lines,
        billDiscount: { kind: 'PERCENT', rateBp: random(2001) },
        serviceCharge: random(2) === 0 ? { rateBp: 500, taxGroupId: 'gst5' } : null,
        roundOff: { kind: 'NEAREST', unit: 100 },
      });
      const netTotal = bill.lines.reduce((total, line) => total + line.netAmount, 0);
      expect(bill.subtotal - bill.discountTotal).toBe(netTotal);
      const itemTaxable = bill.lines.reduce((total, line) => total + line.taxableValue, 0);
      expect(itemTaxable + bill.serviceCharge).toBe(bill.taxableValueTotal);
      expect(bill.taxableValueTotal + bill.taxTotal).toBe(bill.totalBeforeRoundOff);
      expect(bill.grandTotal % 100).toBe(0);
      expect(Math.abs(bill.roundOff)).toBeLessThanOrEqual(50);
    }
  });
});
