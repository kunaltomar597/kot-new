import type {
  DiscountReportResponse,
  InvoiceRegisterResponse,
  KitchenReportResponse,
  OrderDrillDownResponse,
  RecommendationReportResponse,
  SalesSummaryResponse,
} from '@rp/contracts';
import { STAFF } from './fakes.js';

export const ORDER_ID = '0199a0e0-0000-7000-8000-0000000000a9';
export const INVOICE_ID = '0199a0e0-0000-7000-8000-0000000000aa';

const totals = (invoices: number, net: number) => ({
  invoices,
  grossSales: net,
  discounts: 0,
  serviceCharge: 0,
  tax: Math.round(net / 21),
  roundOff: 0,
  netSales: net,
});

export function salesReport(from: string, to: string): SalesSummaryResponse {
  return {
    from,
    to,
    totals: totals(3, 123_456),
    byDay: [{ businessDate: from, ...totals(3, 123_456) }],
    byHour: [
      { hour: 13, ...totals(2, 100_000) },
      { hour: 20, ...totals(1, 23_456) },
    ],
  };
}

export function discountReport(from: string, to: string): DiscountReportResponse {
  return {
    from,
    to,
    discounts: [
      {
        discountId: '0199a0e0-0000-7000-8000-0000000000ab',
        businessDate: from,
        invoiceId: INVOICE_ID,
        invoiceNumber: 'INV/26-27/000012',
        orderId: ORDER_ID,
        item: 'Lassi',
        complimentary: true,
        kind: 'PERCENT',
        rateBp: 10_000,
        amount: 8_000,
        reason: 'Birthday',
        appliedBy: { id: STAFF.CASHIER.staffId, name: STAFF.CASHIER.displayName },
        approvedBy: { id: STAFF.MANAGER.staffId, name: STAFF.MANAGER.displayName },
      },
    ],
    totals: { count: 1, amount: 8_000, complimentaryCount: 1, complimentaryAmount: 8_000 },
  };
}

export function orderDrillDown(): OrderDrillDownResponse {
  return {
    orderId: ORDER_ID,
    orderNumber: 42,
    businessDate: '2026-10-01',
    orderType: 'DINE_IN',
    source: 'WAITER_APP',
    status: 'CLOSED',
    tableLabel: 'T4',
    takeawayToken: null,
    createdAt: '2026-10-01T07:30:00.000Z',
    createdBy: { id: STAFF.WAITER.staffId, name: STAFF.WAITER.displayName },
    device: null,
    approvals: [],
    items: [
      {
        orderItemId: '0199a0e0-0000-7000-8000-0000000000ac',
        name: 'Lassi',
        variantName: null,
        quantity: 1,
        state: 'SERVED',
        createdBy: { id: STAFF.WAITER.staffId, name: STAFF.WAITER.displayName },
        approvedBy: null,
        sentAt: '2026-10-01T07:30:05.000Z',
        preparingAt: null,
        readyAt: '2026-10-01T07:35:00.000Z',
        pickedUpAt: null,
        servedAt: '2026-10-01T07:37:00.000Z',
        endedAt: null,
        endReason: null,
      },
    ],
    kots: [],
    history: [],
    audit: [],
    invoices: [
      {
        invoiceId: INVOICE_ID,
        invoiceNumber: 'INV/26-27/000012',
        status: 'SETTLED',
        grandTotal: 0,
        issuedAt: '2026-10-01T08:30:00.000Z',
        issuedBy: { id: STAFF.CASHIER.staffId, name: STAFF.CASHIER.displayName },
        printCount: 1,
        printedBy: { id: STAFF.CASHIER.staffId, name: STAFF.CASHIER.displayName },
        settledAt: '2026-10-01T08:31:00.000Z',
        settledBy: { id: STAFF.CASHIER.staffId, name: STAFF.CASHIER.displayName },
        voidedAt: null,
        voidedBy: null,
        voidApprovedBy: null,
        voidReason: null,
      },
    ],
  };
}

export function registerPage(from: string, to: string, offset: number): InvoiceRegisterResponse {
  const invoice = (number: number) => ({
    invoiceId: `0199a0e0-0000-7000-8000-${String(number).padStart(12, '0')}`,
    invoiceNumber: `INV/26-27/${String(number).padStart(6, '0')}`,
    invoiceDate: from,
    businessDate: from,
    series: 'Main',
    status: 'SETTLED' as const,
    customerName: null,
    customerGstin: null,
    taxableValue: 10_000,
    taxTotal: 500,
    grandTotal: 10_500,
    voidReason: null,
    replacesInvoiceNumber: null,
  });
  const count = offset === 0 ? 200 : 50;
  return {
    from,
    to,
    total: 250,
    voided: 3,
    offset,
    nextOffset: offset === 0 ? 200 : null,
    invoices: Array.from({ length: count }, (_, index) => invoice(offset + index + 1)),
  };
}

export function kitchenReport(from: string, to: string): KitchenReportResponse {
  const times = { lines: 4, quantity: 6, averagePrepSeconds: 750, averagePickupSeconds: 45 };
  return {
    from,
    to,
    stations: [
      {
        stationId: '0199a0e0-0000-7000-8000-0000000000c1',
        name: 'Tandoor',
        ...times,
        notifyManager: 2,
      },
    ],
    items: [
      {
        itemId: '0199a0e0-0000-7000-8000-0000000000d1',
        name: 'Paneer Tikka',
        station: 'Tandoor',
        ...times,
      },
    ],
    totals: { ...times, notifyManager: 2 },
  };
}

export function suggestionReport(from: string, to: string): RecommendationReportResponse {
  const none = {
    impressions: 0,
    taps: 0,
    addedToCart: 0,
    ordered: 0,
    attachRateBp: null,
    revenue: 0,
  };
  return {
    from,
    to,
    layers: [
      {
        layer: 'RULE',
        impressions: 40,
        taps: 10,
        addedToCart: 8,
        ordered: 6,
        attachRateBp: 1_500,
        revenue: 120_000,
      },
      { layer: 'LEARNED', ...none },
      { layer: 'BEST_SELLER', ...none },
    ],
    items: [],
    totals: {
      impressions: 40,
      taps: 10,
      addedToCart: 8,
      ordered: 6,
      attachRateBp: 1_500,
      revenue: 120_000,
      orders: 30,
      ordersWithSuggestion: 5,
    },
  };
}
