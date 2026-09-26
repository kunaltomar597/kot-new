import { z } from 'zod';
import { Id, IsoDate, Paise, PaymentMode, Timestamp } from './common.js';

/**
 * Day-end (P1-11b, BILL-013, RPT-005): the Z-report of a business date and closing it. Open
 * shifts and unpaid takeaway bills block the close; open tables block it unless a manager carries
 * them forward to the next business date.
 */

export const ZReportView = z.object({
  businessDate: IsoDate,
  orders: z.int().min(0),
  invoices: z.object({
    count: z.int().min(0),
    settled: z.int().min(0),
    unsettled: z.int().min(0),
    voided: z.array(z.string()),
    /** Every invoice number issued on the date, voided ones included (RPT-006). */
    numbers: z.array(z.string()),
  }),
  grossSales: Paise,
  discounts: Paise,
  serviceCharge: Paise,
  taxTotal: Paise,
  roundOff: z.int(),
  netSales: Paise,
  settledSales: Paise,
  taxes: z.array(
    z.object({ code: z.string(), rateBp: z.int().min(0), taxableValue: Paise, amount: Paise }),
  ),
  payments: z.array(
    z.object({
      mode: PaymentMode,
      label: z.string().nullable(),
      count: z.int().min(0),
      amount: Paise,
    }),
  ),
  paymentsTotal: Paise,
  cash: z.object({ cashIn: Paise, cashOut: Paise }),
  shifts: z.array(
    z.object({
      shiftId: Id,
      staffId: Id,
      openingFloat: Paise,
      expectedCash: z.int(),
      countedCash: Paise.nullable(),
      variance: z.int().nullable(),
    }),
  ),
  totalVariance: z.int(),
});
export type ZReportView = z.infer<typeof ZReportView>;

/** What stands in the way of closing the day. */
export const DayEndBlockers = z.object({
  /** Close these shifts first. */
  openShifts: z.array(z.object({ shiftId: Id, staffId: Id })),
  /** Settle these tables, or carry them forward with `carryForwardTables`. */
  openTables: z.array(z.object({ tableSessionId: Id, tableLabel: z.string() })),
  /** Unpaid bills with no open table: take payment or void them. */
  unsettledInvoices: z.array(
    z.object({ invoiceId: Id, invoiceNumber: z.string(), grandTotal: Paise }),
  ),
});
export type DayEndBlockers = z.infer<typeof DayEndBlockers>;

export const DayEndPreview = z.object({
  businessDate: IsoDate,
  status: z.enum(['OPEN', 'CLOSED']),
  blockers: DayEndBlockers,
  report: ZReportView,
});
export type DayEndPreview = z.infer<typeof DayEndPreview>;

/**
 * Close a business date (BILL-013). `carryForwardTables` moves still-open tables to the next
 * business date instead of blocking; it is audited with the manager who closed the day.
 */
export const CloseDayRequest = z.strictObject({
  businessDate: IsoDate,
  carryForwardTables: z.boolean().default(false),
});
export type CloseDayRequest = z.input<typeof CloseDayRequest>;

export const DayEndParams = z.strictObject({ businessDate: IsoDate });
export type DayEndParams = z.infer<typeof DayEndParams>;

export const DayEndView = z.object({
  businessDate: IsoDate,
  closedAt: Timestamp,
  closedById: Id,
  /** Table sessions moved to the next business date. */
  carriedForward: z.array(Id),
  report: ZReportView,
});
export type DayEndView = z.infer<typeof DayEndView>;
