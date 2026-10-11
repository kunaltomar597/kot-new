import { z } from 'zod';
import { InvoiceView } from './billing.js';
import { Id, IsoDate, Timestamp } from './common.js';

/**
 * Archive-then-purge (DATA-008, AUD-004, P7-06b): the Owner archives a whole financial year of
 * business records to a folder (and the cloud), it is read back, then deleted from the database.
 */

/** A financial year as people write it: 2023-24. */
export const FinancialYearLabel = z.string().regex(/^\d{4}-\d{2}$/);

export const ArchiveStatus = z.enum(['ARCHIVING', 'VERIFYING', 'PURGING', 'DONE', 'FAILED']);
export type ArchiveStatus = z.infer<typeof ArchiveStatus>;

/** One archive-then-purge (DATA-008): the purge record once DONE. */
export const ArchiveRunView = z.object({
  id: Id,
  financialYear: FinancialYearLabel,
  status: ArchiveStatus,
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  requestedBy: z.string().nullable(),
  /** The folder the archive and the export went to. */
  folder: z.string().nullable(),
  archiveFile: z.string().nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  /** Records archived (and purged), by kind. */
  counts: z.record(z.string(), z.int().nonnegative()).nullable(),
  error: z.string().nullable(),
});
export type ArchiveRunView = z.infer<typeof ArchiveRunView>;

export const ArchivesResponse = z.object({
  /** Whole years that may be archived and purged now, oldest first. */
  years: z.array(
    z.object({
      financialYear: FinancialYearLabel,
      startDate: IsoDate,
      endDate: IsoDate,
      invoices: z.int().nonnegative(),
      /** GST law still asks for these records (72 months, §12): the restaurant keeps the archive. */
      withinStatutoryPeriod: z.boolean(),
      statutoryUntil: IsoDate,
      /** Only the oldest year may go next. */
      next: z.boolean(),
    }),
  ),
  runs: z.array(ArchiveRunView),
  running: z.boolean(),
});
export type ArchivesResponse = z.infer<typeof ArchivesResponse>;

export const StartArchiveRequest = z.strictObject({
  financialYear: FinancialYearLabel,
  /** Where the archive and the export go: the second backup location, or a folder typed in. */
  folder: z.string().trim().min(1).max(260).nullable(),
  /** The Owner read the warning that GST law still asks for these records. */
  acknowledgeStatutory: z.boolean(),
  reason: z.string().trim().min(3).max(200),
});
export type StartArchiveRequest = z.infer<typeof StartArchiveRequest>;

// ------------------------------------------------------- the archive viewer (DATA-009, P7-06c)

export const ArchiveParams = z.object({ id: Id });
export type ArchiveParams = z.infer<typeof ArchiveParams>;

/** An archived year day by day: the daily sales report, read from the archive. */
export const ArchivedDaysResponse = z.object({
  financialYear: FinancialYearLabel,
  restaurants: z.array(z.string()),
  days: z.array(
    z.object({
      date: IsoDate,
      invoices: z.int().nonnegative(),
      voided: z.int().nonnegative(),
      /** Settled and issued invoices only, in paise. */
      sales: z.int(),
      tax: z.int(),
    }),
  ),
  totals: z.object({
    invoices: z.int().nonnegative(),
    voided: z.int().nonnegative(),
    sales: z.int(),
    tax: z.int(),
  }),
});
export type ArchivedDaysResponse = z.infer<typeof ArchivedDaysResponse>;

/** Find invoices in an archive: a business date, or an invoice number. */
export const ArchivedInvoiceQuery = z
  .strictObject({
    date: IsoDate.optional(),
    number: z.string().trim().min(1).max(40).optional(),
  })
  .refine((query) => (query.date === undefined) !== (query.number === undefined), {
    message: 'Give a date or an invoice number',
  });
export type ArchivedInvoiceQuery = z.infer<typeof ArchivedInvoiceQuery>;

export const ArchivedInvoiceListResponse = z.object({
  invoices: z.array(
    z.object({
      id: Id,
      invoiceNumber: z.string(),
      invoiceDate: IsoDate,
      status: z.enum(['ISSUED', 'SETTLED', 'VOIDED']),
      customer: z.string().nullable(),
      grandTotal: z.int(),
    }),
  ),
});
export type ArchivedInvoiceListResponse = z.infer<typeof ArchivedInvoiceListResponse>;

export const ArchivedInvoiceParams = z.object({ id: Id, invoiceId: Id });
export type ArchivedInvoiceParams = z.infer<typeof ArchivedInvoiceParams>;

/** One archived invoice, and its text as printed (to print again). */
export const ArchivedInvoiceResponse = z.object({
  invoice: InvoiceView,
  printed: z.array(z.string()),
});
export type ArchivedInvoiceResponse = z.infer<typeof ArchivedInvoiceResponse>;

// ------------------------------------------------------- the full data export (DATA-010)

export const DataExportView = z.object({
  status: z.enum(['RUNNING', 'DONE', 'FAILED']),
  folder: z.string(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  /** Tables written, once done. */
  tables: z.int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type DataExportView = z.infer<typeof DataExportView>;

export const DataExportResponse = z.object({ last: DataExportView.nullable() });
export type DataExportResponse = z.infer<typeof DataExportResponse>;

export const StartDataExportRequest = z.strictObject({
  /** A folder; null for the second backup location. */
  folder: z.string().trim().min(1).max(260).nullable(),
});
export type StartDataExportRequest = z.infer<typeof StartDataExportRequest>;
