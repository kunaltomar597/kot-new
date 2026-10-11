import { z } from 'zod';
import { RecommendationLayer } from './recommendations.js';
import {
  DeviceType,
  Id,
  IsoDate,
  OrderItemState,
  OrderSource,
  OrderType,
  Paise,
  PaymentMode,
  Role,
  SignedPaise,
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

/** The most invoices one page of the register carries (P4-05c: a year is 700,000 or more). */
export const REGISTER_PAGE_MAX = 1_000;

/** RPT-006: a range of invoice dates, a page at a time. */
export const InvoiceRegisterQuery = z
  .strictObject({
    from: IsoDate,
    to: IsoDate,
    /** Invoices to skip, in register order. */
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(REGISTER_PAGE_MAX).default(500),
  })
  .refine(withinRange, rangeMessages.order)
  .refine(withinMaxDays, rangeMessages.length);
export type InvoiceRegisterQuery = z.infer<typeof InvoiceRegisterQuery>;

/** RPT-006: every invoice number in sequence, cancelled ones included, a page at a time. */
export const InvoiceRegisterResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  /** Invoices in the whole range, and where the next page starts (null after the last). */
  total: z.int().min(0),
  /** Of them, voided. */
  voided: z.int().min(0),
  offset: z.int().min(0),
  nextOffset: z.int().min(0).nullable(),
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

/** The reports that can be exported (RPT-017): every report (P4-06). */
export const ReportKind = z.enum([
  'SALES',
  'ITEMS',
  'PAYMENTS',
  'SHIFTS',
  'GST',
  'INVOICE_REGISTER',
  'SOURCES',
  'STAFF',
  'DISCOUNTS',
  'CANCELLATIONS',
  'REPRINTS',
  'KITCHEN',
  'TABLES',
  'RECOMMENDATIONS',
  /** The audit log (AUD-005), with the optional action and person filters below. */
  'AUDIT',
  /** Suspicious activity (RPT-014, AUD-006). */
  'SUSPICIOUS',
  /** Diners' feedback (RPT-013). */
  'FEEDBACK',
]);
export type ReportKind = z.infer<typeof ReportKind>;

/** CSV for spreadsheets and the CA, Excel with real numbers, PDF to print or send (P4-06). */
export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF'] as const;
export const ExportFormat = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof ExportFormat>;

/** The most rows an Excel or PDF export carries; CSV has no limit (P4-06). */
export const EXPORT_ROW_LIMITS = { XLSX: 200_000, PDF: 5_000 } as const;

/**
 * RPT-017: export a report as CSV, Excel or PDF. Every export is stamped and audited, so it is a
 * POST even though it changes no business data.
 */
export const ReportExportRequest = z
  .strictObject({
    report: ReportKind,
    from: IsoDate,
    to: IsoDate,
    format: ExportFormat.default('CSV'),
    /** AUDIT only: one action, one person. */
    action: z
      .string()
      .regex(/^[A-Z][A-Z_]{1,59}$/)
      .optional(),
    actorId: Id.optional(),
  })
  .refine(withinRange, rangeMessages.order)
  .refine(withinMaxDays, rangeMessages.length);
export type ReportExportRequest = z.infer<typeof ReportExportRequest>;

export const EXPORT_CONTENT_TYPES = {
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
} as const satisfies Record<ExportFormat, string>;

export const ReportExportResponse = z.object({
  /** e.g. "sales_2026-09-01_2026-09-26.csv". */
  filename: z.string(),
  contentType: z.enum([
    EXPORT_CONTENT_TYPES.CSV,
    EXPORT_CONTENT_TYPES.XLSX,
    EXPORT_CONTENT_TYPES.PDF,
  ]),
  /** CSV is text; Excel and PDF files are base64. */
  encoding: z.enum(['utf-8', 'base64']),
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

// ---------------------------------------------------------------- the full suite (P4-05a)

const Count = z.int().min(0);

/** Money of billed lines: before discounts, the discounts, and the taxable value after them. */
const LineMoney = z.object({ gross: Paise, discounts: Paise, net: Paise });

/** RPT-004: billed sales by where the order came from and by order type. */
export const SourceSalesResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  rows: z.array(LineMoney.extend({ source: OrderSource, orderType: OrderType, orders: Count })),
  totals: LineMoney.extend({ orders: Count }),
});
export type SourceSalesResponse = z.infer<typeof SourceSalesResponse>;

/**
 * RPT-003: each person's work. Sales are the billed taxable value of the items they took or, for
 * a guest's order, approved. Acknowledgements cover alerts and service requests; escalations are
 * their alerts that went on to the managers; cancellations and voids are the ones they asked for.
 */
export const StaffPerformanceResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  staff: z.array(
    z.object({
      staffId: Id,
      name: z.string(),
      role: Role,
      ordersCreated: Count,
      ordersApproved: Count,
      net: Paise,
      acknowledgements: Count,
      /** Whole seconds from raised to acknowledged; null without any. */
      averageAckSeconds: Count.nullable(),
      escalations: Count,
      cancellations: Count,
      voids: Count,
    }),
  ),
});
export type StaffPerformanceResponse = z.infer<typeof StaffPerformanceResponse>;

/** RPT-007: every discount and complimentary item on a bill that counts, with who and why. */
export const DiscountReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  discounts: z.array(
    z.object({
      discountId: Id,
      businessDate: IsoDate,
      invoiceId: Id,
      invoiceNumber: z.string(),
      orderId: Id.nullable(),
      /** The dish, or null for a discount on the whole bill. */
      item: z.string().nullable(),
      complimentary: z.boolean(),
      kind: z.enum(['PERCENT', 'FLAT']),
      rateBp: z.int().min(0).nullable(),
      amount: Paise,
      reason: z.string(),
      appliedBy: StaffRef,
      approvedBy: StaffRef,
    }),
  ),
  totals: z.object({
    count: Count,
    amount: Paise,
    complimentaryCount: Count,
    complimentaryAmount: Paise,
  }),
});
export type DiscountReportResponse = z.infer<typeof DiscountReportResponse>;

/**
 * RPT-008: items cancelled or voided, with the stage they had reached (a void after the kitchen
 * started is wastage), and bills voided. Who, the approver, the reason and the value.
 */
export const CancellationReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  items: z.array(
    z.object({
      auditId: Id,
      at: Timestamp,
      businessDate: IsoDate,
      kind: z.enum(['CANCELLED', 'VOIDED']),
      orderId: Id.nullable(),
      orderItemId: Id.nullable(),
      item: z.string(),
      quantity: Count,
      stage: OrderItemState.nullable(),
      value: Paise,
      wastage: z.boolean(),
      by: StaffRef,
      approvedBy: StaffRef,
      reason: z.string().nullable(),
    }),
  ),
  bills: z.array(
    z.object({
      auditId: Id,
      at: Timestamp,
      businessDate: IsoDate,
      invoiceId: Id.nullable(),
      invoiceNumber: z.string(),
      value: Paise,
      by: StaffRef,
      approvedBy: StaffRef,
      reason: z.string().nullable(),
    }),
  ),
  totals: z.object({
    cancelledCount: Count,
    cancelledValue: Paise,
    voidedCount: Count,
    voidedValue: Paise,
    wastageValue: Paise,
    billCount: Count,
    billValue: Paise,
  }),
});
export type CancellationReportResponse = z.infer<typeof CancellationReportResponse>;

/** RPT-009: kitchen tickets printed again, bills printed again (DUPLICATE) and bills edited. */
export const ReprintReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  events: z.array(
    z.object({
      auditId: Id,
      at: Timestamp,
      businessDate: IsoDate,
      kind: z.enum(['KOT_REPRINT', 'BILL_REPRINT', 'BILL_EDIT']),
      /** "KOT 12" or the invoice number. */
      reference: z.string(),
      orderId: Id.nullable(),
      invoiceId: Id.nullable(),
      by: StaffRef,
      approvedBy: StaffRef,
      reason: z.string().nullable(),
      /** A bill edit's grand total before and after. */
      before: z.int().nullable(),
      after: z.int().nullable(),
    }),
  ),
  totals: z.object({ kotReprints: Count, billReprints: Count, billEdits: Count }),
});
export type ReprintReportResponse = z.infer<typeof ReprintReportResponse>;

// ---------------------------------------------------------------- the full suite (P4-05b)

const Seconds = Count.nullable();

/** Average prep time (kitchen start, or sending, to ready) and ready-to-pickup time, in seconds. */
const KitchenTimes = z.object({
  /** Dishes cooked: lines that reached ready. */
  lines: Count,
  quantity: Count,
  averagePrepSeconds: Seconds,
  averagePickupSeconds: Seconds,
});

/** Pilot risk R-04: the median time a customer's order may wait for a waiter's approval. */
export const APPROVAL_TARGET_SECONDS = 90;

const ApprovalTimes = z.object({
  /** Customer orders (tablet and QR) approved in the period. */
  orders: Count,
  /** Whole seconds from the customer's order to its approval; null without any. */
  medianSeconds: Seconds,
  p95Seconds: Seconds,
  /** Approved orders that waited longer than the target. */
  overTarget: Count,
});

/**
 * Pilot KPI (BRD §2, risk R-04): how long customer orders wait for approval. Measured per order,
 * from the customer placing it to the first approval that sent it to the kitchen; orders that
 * were rejected are counted, not timed.
 */
export const ApprovalTimeReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  /** The median must stay within this many seconds. */
  targetSeconds: z.int().min(1),
  /** Null when no customer order was approved in the period. */
  meetsTarget: z.boolean().nullable(),
  rejected: Count,
  days: z.array(ApprovalTimes.extend({ businessDate: IsoDate })),
  totals: ApprovalTimes,
});
export type ApprovalTimeReportResponse = z.infer<typeof ApprovalTimeReportResponse>;

/** RPT-010: kitchen performance by station and by dish, and "Notify manager" presses. */
export const KitchenReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  stations: z.array(KitchenTimes.extend({ stationId: Id, name: z.string(), notifyManager: Count })),
  items: z.array(KitchenTimes.extend({ itemId: Id, name: z.string(), station: z.string() })),
  totals: KitchenTimes.extend({ notifyManager: Count }),
});
export type KitchenReportResponse = z.infer<typeof KitchenReportResponse>;

const TableFigures = z.object({
  /** Tables served: closed sessions, not ones closed as opened by mistake. */
  sessions: Count,
  covers: Count,
  averageSeatedSeconds: Seconds,
  /** Grand total of the sessions' bills that count. */
  spend: Paise,
  /** Spend per cover; null without covers. */
  spendPerCover: Paise.nullable(),
});

/** RPT-011: covers, turnover, seated time and spend per cover, by table and in total. */
export const TableReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  tables: z.array(TableFigures.extend({ tableId: Id, label: z.string() })),
  totals: TableFigures.extend({
    /** Tables not archived, and days in the range: turnover is sessions per table per day. */
    tableCount: Count,
    days: z.int().min(1),
    /** Sessions per table per day, in basis points (2.5 turns a day is 25,000). */
    turnoverBp: Count,
  }),
});
export type TableReportResponse = z.infer<typeof TableReportResponse>;

const SuggestionFigures = z.object({
  impressions: Count,
  taps: Count,
  addedToCart: Count,
  ordered: Count,
  /** Ordered per impression, in basis points; null without impressions. */
  attachRateBp: Count.nullable(),
  /** Line totals of suggested lines ordered and not rejected, cancelled or voided. */
  revenue: Paise,
});

/** RPT-012: suggestions shown, opened, added and ordered, with revenue, per layer and dish. */
export const RecommendationReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  layers: z.array(SuggestionFigures.extend({ layer: RecommendationLayer })),
  items: z.array(SuggestionFigures.extend({ itemId: Id, name: z.string() })),
  totals: SuggestionFigures.extend({
    /** Orders in the range, and those with at least one suggested line. */
    orders: Count,
    ordersWithSuggestion: Count,
  }),
});
export type RecommendationReportResponse = z.infer<typeof RecommendationReportResponse>;

// ---------------------------------------------------------------- suspicious activity (P4-07b)

/**
 * The patterns AUD-006 flags, in the order the report shows them:
 * - VOID_AFTER_PRINT: a printed bill voided, or an item cancelled or voided after its bill printed;
 * - EDIT_AFTER_PRINT: a printed bill edited under its number (BILL-010);
 * - DISCOUNT_OVER_LIMIT: a discount above `audit.discountFlagBp` of what it applied to;
 * - REPEATED_REPRINT: a kitchen ticket or bill printed again `audit.reprintFlagCount` times or more;
 * - CASH_VARIANCE: a shift closed with more than `audit.cashVarianceFlagPaise` over or short;
 * - CANCELLED_AFTER_PREP: an item voided after the kitchen started it;
 * - SENT_NOT_BILLED: an item sent to the kitchen that is on no settled bill once its table or day
 *   is over;
 * - NO_SALE_DRAWER: the cash drawer opened without a sale (BILL-016).
 */
export const SUSPICIOUS_KINDS = [
  'VOID_AFTER_PRINT',
  'EDIT_AFTER_PRINT',
  'DISCOUNT_OVER_LIMIT',
  'REPEATED_REPRINT',
  'CASH_VARIANCE',
  'CANCELLED_AFTER_PREP',
  'SENT_NOT_BILLED',
  'NO_SALE_DRAWER',
] as const;
export const SuspiciousKind = z.enum(SUSPICIOUS_KINDS);
export type SuspiciousKind = z.infer<typeof SuspiciousKind>;

export const SuspiciousFlag = z.object({
  /** Stable within the report, e.g. the audit entry, discount, shift or order item behind it. */
  flagId: z.string(),
  kind: SuspiciousKind,
  at: Timestamp,
  businessDate: IsoDate,
  /** The person the flag is about: who voided, edited, discounted, reprinted most, closed the
   * shift, ordered the unbilled item or opened the drawer. */
  by: StaffRef,
  approvedBy: StaffRef,
  /** Everyone else involved, e.g. the others who reprinted the same bill. */
  alsoBy: z.array(z.object({ id: Id, name: z.string() })),
  reason: z.string().nullable(),
  orderId: Id.nullable(),
  invoiceId: Id.nullable(),
  invoiceNumber: z.string().nullable(),
  kotNumber: z.int().positive().nullable(),
  item: z.string().nullable(),
  quantity: Count.nullable(),
  /** The money at stake: the value voided or discounted, the bill's change, the variance (short
   * is negative). Null where there is none. */
  amount: SignedPaise.nullable(),
  /** A discount's rate of what it applied to, in basis points. */
  rateBp: Count.nullable(),
  /** How many times a document was printed again. */
  count: Count.nullable(),
});
export type SuspiciousFlag = z.infer<typeof SuspiciousFlag>;

/** RPT-014 / AUD-006: suspicious activity in a range, with the thresholds it used. */
export const SuspiciousActivityResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  thresholds: z.object({
    discountFlagBp: Count,
    cashVarianceFlagPaise: Paise,
    reprintFlagCount: z.int().positive(),
  }),
  flags: z.array(SuspiciousFlag),
  /** Flags per pattern, every pattern listed. */
  totals: z.array(z.object({ kind: SuspiciousKind, count: Count })),
  /** Flags per person they are about, most first. */
  people: z.array(z.object({ id: Id, name: z.string(), count: Count })),
});
export type SuspiciousActivityResponse = z.infer<typeof SuspiciousActivityResponse>;
