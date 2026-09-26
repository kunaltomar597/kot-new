import { describe, expect, it } from 'vitest';
import {
  type BillableItem,
  calculateBill,
  describeItem,
} from '../../src/billing/bill-calculation.js';

const item = (overrides: Partial<BillableItem>): BillableItem => ({
  id: 'a',
  name: 'Paneer Tikka',
  variantName: null,
  modifiers: [],
  quantity: 1,
  unitPrice: 10_000,
  taxGroupId: 'gst5',
  taxRates: [
    { code: 'CGST', rateBp: 250 },
    { code: 'SGST', rateBp: 250 },
  ],
  ...overrides,
});

const settings = {
  priceMode: 'TAX_EXCLUSIVE' as const,
  roundingUnitPaise: 0,
  serviceChargeRateBp: null,
};
const names = new Map([
  ['gst5', 'GST 5 %'],
  ['gst18', 'GST 18 %'],
]);

describe('[BILL-001] pricing a bill from stored order items', () => {
  it('describes a line with its variant and modifiers', () => {
    expect(
      describeItem({
        name: 'Paneer Tikka',
        variantName: 'Half',
        modifiers: [
          { name: 'Extra cheese', quantity: 1 },
          { name: 'Mint chutney', quantity: 2 },
        ],
      }),
    ).toBe('Paneer Tikka (Half) + Extra cheese, Mint chutney x2');
  });

  it('[BILL-004] taxes with the rates stored when each item was ordered', () => {
    // The group's rate changed between two orders of one meal: each keeps its own rate.
    const { result, groupIdOf } = calculateBill(
      [
        item({ id: 'a' }),
        item({
          id: 'b',
          taxRates: [
            { code: 'CGST', rateBp: 600 },
            { code: 'SGST', rateBp: 600 },
          ],
        }),
      ],
      [],
      names,
      settings,
    );
    expect(result.taxLines.map((line) => line.taxTotal)).toEqual([500, 1_200]);
    expect(result.taxLines.map((line) => groupIdOf.get(line.taxGroupId))).toEqual(['gst5', 'gst5']);
  });

  it('[BILL-006] taxes the service charge with the group carrying the most value', () => {
    const { result, groupIdOf } = calculateBill(
      [
        item({ id: 'a', unitPrice: 5_000 }),
        item({
          id: 'b',
          taxGroupId: 'gst18',
          unitPrice: 20_000,
          taxRates: [
            { code: 'CGST', rateBp: 900 },
            { code: 'SGST', rateBp: 900 },
          ],
        }),
      ],
      [],
      names,
      { ...settings, serviceChargeRateBp: 1_000 },
    );
    const charge = result.taxLines.find((line) => line.source === 'SERVICE_CHARGE');
    expect(result.serviceCharge).toBe(2_500);
    expect(groupIdOf.get(charge?.taxGroupId ?? '')).toBe('gst18');
  });

  it('[BILL-005] treats a 100 % item discount as complimentary', () => {
    const { result } = calculateBill(
      [item({ id: 'a' }), item({ id: 'b' })],
      [{ id: 'd', orderItemId: 'b', kind: 'PERCENT', rateBp: 10_000, amount: 0 }],
      names,
      settings,
    );
    expect(result.lines.map((line) => line.netAmount)).toEqual([10_000, 0]);
    expect(result.grandTotal).toBe(10_500);
  });
});
