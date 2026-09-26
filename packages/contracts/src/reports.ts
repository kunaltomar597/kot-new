import { z } from 'zod';
import { Id, IsoDate, Paise, PaymentMode, Timestamp } from './common.js';

/**
 * Core reports v1 (P1-13a, RPT-001, RPT-002, RPT-005, RPT-006). Every report takes a range of
 * business dates (the invoice register: invoice dates, as GST files by them), at most a year.
 * Voided invoices count in no totals; the register lists them.
 */

const MAX_DAYS = 366;

export const ReportRangeQuery = z
  .strictObject({ from: IsoDate, to: IsoDate })
  .refine((range) => range.from <= range.to, { message: 'from must not be after to' })
  .refine((range) => Date.parse(range.to) - Date.parse(range.from) <= (MAX_DAYS - 1) * 86_400_000, {
    message: `A report covers at most ${String(MAX_DAYS)} days`,
  });
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
