import { z } from 'zod';
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
