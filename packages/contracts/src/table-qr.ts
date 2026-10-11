import { z } from 'zod';
import { Id, Timestamp } from './common.js';

/**
 * Table QR codes (P5-04, QR-001, ONB-004 step 10): each table's code opens the QR menu at
 * `<site>/t/<token>`; regenerating one stops the old code at once.
 */

/** One table's code: none yet, or its address and when it was made. */
export const TableQrView = z.object({
  tableId: Id,
  label: z.string(),
  sectionName: z.string(),
  /** The address the code opens, or null when the table has no code or the site is not set. */
  url: z.string().nullable(),
  hasCode: z.boolean(),
  issuedAt: Timestamp.nullable(),
});
export type TableQrView = z.infer<typeof TableQrView>;

export const TableQrCodesResponse = z.object({
  /** The QR menu site (RP_QR_SITE_URL), or null when it is not set and codes cannot be printed. */
  siteUrl: z.string().nullable(),
  tables: z.array(TableQrView),
});
export type TableQrCodesResponse = z.infer<typeof TableQrCodesResponse>;

/** A new code for a table: the printed one stops working (QR-001). */
export const RegenerateTableQrRequest = z.strictObject({
  reason: z.string().trim().min(3).max(200),
});
export type RegenerateTableQrRequest = z.infer<typeof RegenerateTableQrRequest>;

/** A6: one card per page, for a stand. A5: two panels side by side that fold into a tent. */
export const TableTentSize = z.enum(['A6', 'A5']);
export type TableTentSize = z.infer<typeof TableTentSize>;

export const TableTentsRequest = z.strictObject({
  size: TableTentSize,
  /** The tables to print, in floor order; all tables with a code when left out. */
  tableIds: z.array(Id).min(1).max(500).optional(),
});
export type TableTentsRequest = z.infer<typeof TableTentsRequest>;

export const TableTentsResponse = z.object({
  /** e.g. "table-tents_A6_2026-10-02.pdf". */
  filename: z.string(),
  contentType: z.literal('application/pdf'),
  encoding: z.literal('base64'),
  content: z.string(),
  pages: z.int().positive(),
});
export type TableTentsResponse = z.infer<typeof TableTentsResponse>;
