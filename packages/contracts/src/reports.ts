import { z } from 'zod';
import {
  DeviceType,
  Id,
  IsoDate,
  OrderItemState,
  OrderSource,
  OrderType,
  Paise,
  PaymentMode,
  Timestamp,
} from './common.js';

/**
 * Core reports v1 (P1-13a, RPT-001, RPT-002, RPT-005, RPT-006). Every report takes a range of
 * business dates (the invoice register: invoice dates, as GST files by them), at most a year.
 * Voided invoices count in no totals; the register lists them.
 */

const MAX_DAYS = 366;

function withinRange(range: { from: string; to: string }): boolean {
  return range.from <= range.to;
}

function withinMaxDays(range: { from: string; to: string }): boolean {
  return Date.parse(range.to) - Date.parse(range.from) <= (MAX_DAYS - 1) * 86_400_000;
}

const rangeMessages = {
  order: { message: 'from must not be after to' },
  length: { message: `A report covers at most ${String(MAX_DAYS)} days` },
};

export const ReportRangeQuery = z
  .strictObject({ from: IsoDate, to: IsoDate })
  .refine(withinRange, rangeMessages.order)
  .refine(withinMaxDays, rangeMessages.length);
export type ReportRangeQuery = z.infer<typeof ReportRangeQuery>;

const SalesTotals = z.object({
  invoices: z.int().min(0),
  grossSales: Paise,
  discounts: Paise,
  serviceCharge: Paise,
  tax: Paise,
  roundOff: z.int(),
  netSales: Paise,
});

/** RPT-001: sales for the range, by business date and by hour of the day (IST). */
export const SalesSummaryResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  totals: SalesTotals,
  byDay: z.array(SalesTotals.extend({ businessDate: IsoDate })),
  byHour: z.array(SalesTotals.extend({ hour: z.int().min(0).max(23) })),
});
export type SalesSummaryResponse = z.infer<typeof SalesSummaryResponse>;

const ItemFigures = z.object({
  quantity: z.int().min(0),
  gross: Paise,
  discounts: Paise,
  /** Taxable value after discounts. */
  net: Paise,
  tax: Paise,
});

/** RPT-002: item-wise and category-wise sales. */
export const ItemSalesResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  items: z.array(
    ItemFigures.extend({ itemId: Id, name: z.string(), categoryId: Id, category: z.string() }),
  ),
  categories: z.array(ItemFigures.extend({ categoryId: Id, category: z.string() })),
});
export type ItemSalesResponse = z.infer<typeof ItemSalesResponse>;

/** RPT-005: payments per mode. */
export const PaymentModesResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  modes: z.array(
    z.object({
      mode: PaymentMode,
      label: z.string().nullable(),
      count: z.int().min(0),
      amount: Paise,
    }),
  ),
  total: Paise,
});
export type PaymentModesResponse = z.infer<typeof PaymentModesResponse>;

/** RPT-005: shifts with their cash and variance. A cashier sees their own shifts only. */
export const ShiftReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  shifts: z.array(
    z.object({
      shiftId: Id,
      staffId: Id,
      staffName: z.string(),
      businessDate: IsoDate,
      status: z.enum(['OPEN', 'CLOSED']),
      openedAt: Timestamp,
      closedAt: Timestamp.nullable(),
      openingFloat: Paise,
      cashPayments: Paise,
      cashIn: Paise,
      cashOut: Paise,
      expectedCash: z.int(),
      countedCash: Paise.nullable(),
      variance: z.int().nullable(),
    }),
  ),
  totalVariance: z.int(),
});
export type ShiftReportResponse = z.infer<typeof ShiftReportResponse>;

/** RPT-006: taxable value, CGST and SGST (any component) by SAC and rate. */
export const GstSummaryResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  rows: z.array(
    z.object({
      sacCode: z.string().nullable(),
      rateBp: z.int().min(0),
      taxableValue: Paise,
      components: z.record(z.string(), Paise),
      taxTotal: Paise,
    }),
  ),
  totals: z.object({
    taxableValue: Paise,
    components: z.record(z.string(), Paise),
    taxTotal: Paise,
  }),
});
export type GstSummaryResponse = z.infer<typeof GstSummaryResponse>;

/** RPT-006: every invoice number in sequence, cancelled ones included. */
export const InvoiceRegisterResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  invoices: z.array(
    z.object({
      invoiceId: Id,
      invoiceNumber: z.string(),
      invoiceDate: IsoDate,
      businessDate: IsoDate,
      series: z.string(),
      status: z.enum(['ISSUED', 'SETTLED', 'VOIDED']),
      customerName: z.string().nullable(),
      customerGstin: z.string().nullable(),
      taxableValue: Paise,
      taxTotal: Paise,
      grandTotal: Paise,
      voidReason: z.string().nullable(),
      replacesInvoiceNumber: z.string().nullable(),
    }),
  ),
});
export type InvoiceRegisterResponse = z.infer<typeof InvoiceRegisterResponse>;

/** The reports that can be exported (RPT-017). */
export const ReportKind = z.enum([
  'SALES',
  'ITEMS',
  'PAYMENTS',
  'SHIFTS',
  'GST',
  'INVOICE_REGISTER',
]);
export type ReportKind = z.infer<typeof ReportKind>;

/**
 * RPT-017: export a report. CSV now (P1-13b); PDF and Excel follow in P4 as further formats.
 * Every export is stamped and audited, so it is a POST even though it changes no business data.
 */
export const ReportExportRequest = z
  .strictObject({
    report: ReportKind,
    from: IsoDate,
    to: IsoDate,
    format: z.literal('CSV').default('CSV'),
  })
  .refine(withinRange, rangeMessages.order)
  .refine(withinMaxDays, rangeMessages.length);
export type ReportExportRequest = z.infer<typeof ReportExportRequest>;

export const ReportExportResponse = z.object({
  /** e.g. "sales_2026-09-01_2026-09-26.csv". */
  filename: z.string(),
  contentType: z.literal('text/csv; charset=utf-8'),
  /** The whole file, stamped with the restaurant, the filters, generated by and generated at. */
  content: z.string(),
  generatedAt: Timestamp,
});
export type ReportExportResponse = z.infer<typeof ReportExportResponse>;

export const OrderDrillDownParams = z.strictObject({ orderId: Id });
export type OrderDrillDownParams = z.infer<typeof OrderDrillDownParams>;

/** A person as reports name them; null when nobody is recorded (e.g. a QR guest). */
const StaffRef = z.object({ id: Id, name: z.string() }).nullable();
const DeviceRef = z.object({ id: Id, name: z.string(), type: DeviceType }).nullable();

/**
 * RPT-015: everything about one order and who did it: created by and on which device, approvals,
 * each item's status times, KOTs, every state change and audited action (modified, cancelled,
 * voided, discounts) with actor and approver, and the invoices with who issued, printed, settled
 * or voided them.
 */
export const OrderDrillDownResponse = z.object({
  orderId: Id,
  orderNumber: z.int().min(1),
  businessDate: IsoDate,
  orderType: OrderType,
  source: OrderSource,
  status: z.string(),
  tableLabel: z.string().nullable(),
  takeawayToken: z.int().nullable(),
  createdAt: Timestamp,
  createdBy: StaffRef,
  device: DeviceRef,
  approvals: z.array(
    z.object({
      action: z.string(),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']),
      requestedBy: StaffRef,
      decidedBy: StaffRef,
      requestedAt: Timestamp,
      decidedAt: Timestamp.nullable(),
      reason: z.string().nullable(),
    }),
  ),
  items: z.array(
    z.object({
      orderItemId: Id,
      name: z.string(),
      variantName: z.string().nullable(),
      quantity: z.int(),
      state: OrderItemState,
      createdBy: StaffRef,
      approvedBy: StaffRef,
      sentAt: Timestamp.nullable(),
      preparingAt: Timestamp.nullable(),
      readyAt: Timestamp.nullable(),
      pickedUpAt: Timestamp.nullable(),
      servedAt: Timestamp.nullable(),
      endedAt: Timestamp.nullable(),
      endReason: z.string().nullable(),
    }),
  ),
  kots: z.array(
    z.object({
      kotId: Id,
      kotNumber: z.int(),
      kind: z.enum(['NEW', 'MODIFIED', 'CANCELLED']),
      station: z.string(),
      createdAt: Timestamp,
      printStatus: z.string(),
      printedAt: Timestamp.nullable(),
    }),
  ),
  /** Each state change of the order and its items, oldest first. */
  history: z.array(
    z.object({
      at: Timestamp,
      event: z.string(),
      orderItemId: Id.nullable(),
      itemName: z.string().nullable(),
      fromState: OrderItemState.nullable(),
      toState: OrderItemState.nullable(),
      by: StaffRef,
      device: DeviceRef,
      reason: z.string().nullable(),
    }),
  ),
  /** Audited actions on the order, its items, its bill and its invoices, oldest first. */
  audit: z.array(
    z.object({
      at: Timestamp,
      action: z.string(),
      entityType: z.string(),
      entityId: Id.nullable(),
      by: StaffRef,
      approvedBy: StaffRef,
      device: DeviceRef,
      reason: z.string().nullable(),
    }),
  ),
  invoices: z.array(
    z.object({
      invoiceId: Id,
      invoiceNumber: z.string(),
      status: z.enum(['ISSUED', 'SETTLED', 'VOIDED']),
      grandTotal: Paise,
      issuedAt: Timestamp,
      issuedBy: StaffRef,
      printCount: z.int().min(0),
      /** Who printed the original; reprints are in `audit`. */
      printedBy: StaffRef,
      settledAt: Timestamp.nullable(),
      settledBy: StaffRef,
      voidedAt: Timestamp.nullable(),
      voidedBy: StaffRef,
      voidApprovedBy: StaffRef,
      voidReason: z.string().nullable(),
    }),
  ),
});
export type OrderDrillDownResponse = z.infer<typeof OrderDrillDownResponse>;
