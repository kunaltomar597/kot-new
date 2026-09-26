import type { BillView, InvoicePaymentsView, InvoiceView, ShiftView } from '@rp/contracts';
import { STAFF } from './fakes.js';

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const B = {
  bill: uuid(700),
  session: uuid(701),
  item1: uuid(702),
  item2: uuid(703),
  tax: uuid(704),
  invoice: uuid(705),
  shift: uuid(706),
  discount: uuid(707),
} as const;

export function billView(overrides: Partial<BillView> = {}): BillView {
  return {
    id: B.bill,
    status: 'OPEN',
    tableSessionId: B.session,
    orderId: null,
    tableLabel: 'T4',
    priceMode: 'TAX_EXCLUSIVE',
    lines: [
      {
        orderItemId: B.item1,
        description: 'Paneer Tikka (Full)',
        quantity: 2,
        unitPrice: 28_000,
        grossAmount: 56_000,
        itemDiscount: 0,
        billDiscountShare: 0,
        netAmount: 56_000,
        taxGroupId: B.tax,
        complimentary: false,
      },
      {
        orderItemId: B.item2,
        description: 'Lassi',
        quantity: 1,
        unitPrice: 8_000,
        grossAmount: 8_000,
        itemDiscount: 0,
        billDiscountShare: 0,
        netAmount: 8_000,
        taxGroupId: B.tax,
        complimentary: false,
      },
    ],
    discounts: [],
    serviceCharge: { enabled: true, removed: false, rateBp: 500, amount: 3_200 },
    subtotal: 64_000,
    discountTotal: 0,
    taxableValueTotal: 67_200,
    taxLines: [
      {
        taxGroupId: B.tax,
        name: 'GST 5 %',
        source: 'ITEMS',
        taxableValue: 64_000,
        components: [
          { code: 'CGST', rateBp: 250, amount: 1_600 },
          { code: 'SGST', rateBp: 250, amount: 1_600 },
        ],
        taxTotal: 3_200,
      },
    ],
    taxTotal: 3_200,
    roundOff: 0,
    grandTotal: 70_400,
    customer: { name: null, phone: null, phoneConsent: false, gstin: null },
    invoiceIds: [],
    editingInvoiceId: null,
    ...overrides,
  };
}

export function invoiceView(overrides: Partial<InvoiceView> = {}): InvoiceView {
  return {
    id: B.invoice,
    billId: B.bill,
    invoiceNumber: 'INV/26-27/000012',
    status: 'ISSUED',
    invoiceDate: '2026-09-26',
    financialYear: '2026-27',
    businessDate: '2026-09-26',
    issuedAt: '2026-09-26T10:00:00.000Z',
    issuedById: STAFF.CASHIER.staffId,
    tableLabel: 'T4',
    particulars: {
      displayName: 'Demo Dhaba',
      legalName: null,
      address: null,
      gstin: null,
      fssaiNumber: null,
      placeOfSupply: null,
      phone: null,
      headerLines: [],
      footerLines: [],
    },
    customer: { name: null, phone: null, phoneConsent: false, gstin: null },
    priceMode: 'TAX_EXCLUSIVE',
    lines: [],
    taxLines: [],
    subtotal: 64_000,
    discountTotal: 0,
    serviceCharge: 3_200,
    taxTotal: 3_200,
    roundOff: 0,
    grandTotal: 70_400,
    printCount: 0,
    version: 1,
    voidedAt: null,
    voidReason: null,
    replacesInvoiceId: null,
    ...overrides,
  };
}

export function paymentsView(overrides: Partial<InvoicePaymentsView> = {}): InvoicePaymentsView {
  return {
    invoiceId: B.invoice,
    invoiceNumber: 'INV/26-27/000012',
    status: 'ISSUED',
    grandTotal: 70_400,
    paid: 0,
    remaining: 70_400,
    payments: [],
    tableClosed: false,
    ...overrides,
  };
}

export function shiftView(overrides: Partial<ShiftView> = {}): ShiftView {
  return {
    id: B.shift,
    staffId: STAFF.CASHIER.staffId,
    status: 'OPEN',
    businessDate: '2026-09-26',
    openedAt: '2026-09-26T08:00:00.000Z',
    closedAt: null,
    openingFloat: 100_000,
    cashPayments: 50_000,
    cashIn: 0,
    cashOut: 10_000,
    expectedCash: 140_000,
    countedCash: null,
    variance: null,
    denominations: null,
    movements: [],
    ...overrides,
  };
}
