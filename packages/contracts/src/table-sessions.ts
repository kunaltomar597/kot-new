import { z } from 'zod';
import { Id, IsoDate, Paise, TableState, Timestamp } from './common.js';

/**
 * Table sessions (P1-02b, TBL-003 to TBL-005, TBL-007, WTR-008): a table is opened with covers
 * and a responsible waiter, moves through the table states (`@rp/domain` `tableMachine`), can
 * move to a free table with its orders, and ends when the bill is settled or, when opened by
 * mistake, closed without a bill.
 */

export const OpenTableRequest = z.strictObject({
  /** Guests seated (TBL-003). */
  covers: z.int().min(1).max(99),
  /** The responsible waiter; defaults to the table's assigned waiter, else the person opening. */
  waiterId: Id.optional(),
});
export type OpenTableRequest = z.infer<typeof OpenTableRequest>;

export const TableSessionParams = z.strictObject({ sessionId: Id });
export type TableSessionParams = z.infer<typeof TableSessionParams>;

export const TableSessionView = z.object({
  id: Id,
  tableId: Id,
  tableLabel: z.string(),
  /** The table's state while the session is open, FREE once it is closed. */
  state: TableState,
  status: z.enum(['OPEN', 'CLOSED']),
  covers: z.int().positive(),
  waiterId: Id,
  waiterName: z.string(),
  businessDate: IsoDate,
  openedAt: Timestamp,
  closedAt: Timestamp.nullable(),
  closeReason: z.string().nullable(),
});
export type TableSessionView = z.infer<typeof TableSessionView>;

/** Frees a table opened by mistake; only while nothing billable has been ordered. */
export const CloseWithoutBillRequest = z.strictObject({
  reason: z.string().trim().min(3).max(200),
});
export type CloseWithoutBillRequest = z.infer<typeof CloseWithoutBillRequest>;

/** TBL-005: move the session and all its orders to a free table. */
export const MoveTableRequest = z.strictObject({ toTableId: Id });
export type MoveTableRequest = z.infer<typeof MoveTableRequest>;

/**
 * TBL-006: the guests at this table join another open table, for one bill. Their orders, tickets
 * and open requests go with them; this table's session closes.
 */
export const MergeTablesRequest = z.strictObject({ intoTableSessionId: Id });
export type MergeTablesRequest = z.infer<typeof MergeTablesRequest>;

/**
 * TBL-006: dishes go to another open table's bill: whole lines (a combo with its parts), not yet
 * on a printed bill.
 */
export const TransferItemsRequest = z.strictObject({
  toTableSessionId: Id,
  orderItemIds: z.array(Id).min(1).max(100),
  reason: z.string().trim().min(3).max(200).optional(),
});
export type TransferItemsRequest = z.infer<typeof TransferItemsRequest>;

export const TransferItemsResponse = z.object({
  from: TableSessionView,
  to: TableSessionView,
  /** The lines moved, combo parts included. */
  orderItemIds: z.array(Id),
});
export type TransferItemsResponse = z.infer<typeof TransferItemsResponse>;

/** A table's bill printed from the waiter app (WTR-008): issued, and printed if it could be. */
export const PrintTableBillResponse = z.object({
  invoiceId: Id,
  invoiceNumber: z.string(),
  grandTotal: Paise,
  printed: z.boolean(),
  /** Why it did not print, in plain words; the bill is issued all the same. */
  error: z.string().nullable(),
});
export type PrintTableBillResponse = z.infer<typeof PrintTableBillResponse>;

/** A table's state after it was marked clean (TBL-004). */
export const TableStateView = z.object({ tableId: Id, state: TableState });
export type TableStateView = z.infer<typeof TableStateView>;

/** TBL-002: another waiter looks after this session. */
export const AssignSessionWaiterRequest = z.strictObject({
  waiterId: Id,
  reason: z.string().trim().min(3).max(200).optional(),
});
export type AssignSessionWaiterRequest = z.infer<typeof AssignSessionWaiterRequest>;

/** One table on the live overview (TBL-007). */
export const TableOverviewEntry = z.object({
  tableId: Id,
  label: z.string(),
  sectionId: Id,
  capacity: z.int().positive(),
  state: TableState,
  session: z
    .object({
      id: Id,
      openedAt: Timestamp,
      covers: z.int().positive(),
      waiterId: Id,
      waiterName: z.string(),
      /** Billable items so far at their order prices, before discounts, charges and tax. */
      amountSoFar: Paise,
      /** Items from the tablet or QR waiting for staff approval. */
      pendingApprovals: z.int().nonnegative(),
      /** Dishes ready at the pass for this table; a combo counts once all its parts are (WTR-007). */
      readyItems: z.int().nonnegative(),
    })
    .nullable(),
  /** Water, waiter and bill requests not yet resolved (service requests arrive in P2/P3). */
  activeServiceRequests: z.int().nonnegative(),
});
export type TableOverviewEntry = z.infer<typeof TableOverviewEntry>;

export const TableOverviewResponse = z.object({
  tables: z.array(TableOverviewEntry),
  /**
   * Whether the person asking may print a table's bill (WTR-008): the POS roles always; waiters,
   * for their own tables, only when the restaurant allows it (`bills.waiterMayPrint`).
   */
  mayPrintBill: z.boolean().default(false),
});
export type TableOverviewResponse = z.infer<typeof TableOverviewResponse>;
