import { fitsPlan, PLAN_COLUMNS, PLAN_ROWS, TABLE_SHAPES, TABLE_SIZE } from '@rp/domain';
import { z } from 'zod';
import { Id, IsoDate, TableState, Timestamp } from './common.js';

/**
 * The floor (P1-02a, TBL-001, TBL-002, ONB-004 step 5): sections contain tables, and waiters are
 * assigned to sections or single tables for the business day.
 */

const Reason = z.string().trim().min(3).max(200);

// ---------------------------------------------------------------- sections and tables

export const SectionRequest = z.strictObject({
  name: z.string().trim().min(1).max(40),
  /** Position among the sections, lowest first. */
  displayOrder: z.int().min(0).max(999),
});
export type SectionRequest = z.infer<typeof SectionRequest>;

export const SectionParams = z.strictObject({ sectionId: Id });
export type SectionParams = z.infer<typeof SectionParams>;

export const TableRequest = z.strictObject({
  /** Number or name shown to staff and on tickets, e.g. "12" or "Terrace 3". */
  label: z.string().trim().min(1).max(20),
  /** Seats (covers) the table is laid for. */
  capacity: z.int().min(1).max(50),
  sectionId: Id,
  displayOrder: z.int().min(0).max(9_999),
});
export type TableRequest = z.infer<typeof TableRequest>;

export const TableParams = z.strictObject({ tableId: Id });
export type TableParams = z.infer<typeof TableParams>;

/** Where a table sits on its section's floor plan, in grid cells (ONB-004 step 5, S). */
export const TableLayout = z
  .strictObject({
    x: z
      .int()
      .min(0)
      .max(PLAN_COLUMNS - TABLE_SIZE.min),
    y: z
      .int()
      .min(0)
      .max(PLAN_ROWS - TABLE_SIZE.min),
    w: z.int().min(TABLE_SIZE.min).max(TABLE_SIZE.max),
    h: z.int().min(TABLE_SIZE.min).max(TABLE_SIZE.max),
    shape: z.enum(TABLE_SHAPES),
  })
  .refine(fitsPlan, { message: 'The table must fit on the plan' });
export type TableLayout = z.infer<typeof TableLayout>;

export const TableView = z.object({
  id: Id,
  label: z.string(),
  capacity: z.int().positive(),
  sectionId: Id,
  state: TableState,
  displayOrder: z.int().nonnegative(),
  /** Active table tablets bound to the table (TBL-001, AUTH-009). */
  tabletDeviceIds: z.array(Id),
  /** Its place on the section's floor plan; null until someone places it. */
  layout: TableLayout.nullable().default(null),
  archivedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type TableView = z.infer<typeof TableView>;

export const SectionView = z.object({
  id: Id,
  name: z.string(),
  displayOrder: z.int().nonnegative(),
  archivedAt: Timestamp.nullable(),
  /** Its tables in display order, archived ones included. */
  tables: z.array(TableView),
  updatedAt: Timestamp,
});
export type SectionView = z.infer<typeof SectionView>;

/** The whole floor in display order, archived sections and tables included (clients filter). */
export const FloorResponse = z.object({ sections: z.array(SectionView) });
export type FloorResponse = z.infer<typeof FloorResponse>;

/**
 * The floor plan as dragged (ONB-004 step 5, S): the tables whose place changed, each with its
 * new place or null to take it off the plan. Tables of one section may not overlap.
 */
export const FloorLayoutRequest = z.strictObject({
  tables: z
    .array(z.strictObject({ tableId: Id, layout: TableLayout.nullable() }))
    .min(1)
    .max(500),
});
export type FloorLayoutRequest = z.infer<typeof FloorLayoutRequest>;

/** Archived sections and tables are hidden, never deleted (BRD §9.4). */
export const FloorArchiveRequest = z.strictObject({ reason: Reason });
export type FloorArchiveRequest = z.infer<typeof FloorArchiveRequest>;

// ---------------------------------------------------------------- waiter assignment

/** One waiter's sections and single tables for the business day (TBL-002). */
export const WaiterAssignmentInput = z
  .strictObject({
    staffId: Id,
    sectionIds: z.array(Id).max(20),
    tableIds: z.array(Id).max(100),
  })
  .refine((assignment) => assignment.sectionIds.length + assignment.tableIds.length > 0, {
    message: 'Give the waiter at least one section or table',
  });
export type WaiterAssignmentInput = z.infer<typeof WaiterAssignmentInput>;

/** Replaces the business day's assignments; an empty list clears them. */
export const UpdateWaiterAssignmentsRequest = z.strictObject({
  assignments: z
    .array(WaiterAssignmentInput)
    .max(100)
    .refine(
      (assignments) =>
        new Set(assignments.map((assignment) => assignment.staffId)).size === assignments.length,
      { message: 'List each waiter once' },
    ),
  reason: Reason.optional(),
});
export type UpdateWaiterAssignmentsRequest = z.infer<typeof UpdateWaiterAssignmentsRequest>;

export const WaiterAssignmentView = z.object({
  staffId: Id,
  staffName: z.string(),
  sectionIds: z.array(Id),
  tableIds: z.array(Id),
});
export type WaiterAssignmentView = z.infer<typeof WaiterAssignmentView>;

export const WaiterAssignmentSet = z.object({
  businessDate: IsoDate,
  assignments: z.array(WaiterAssignmentView),
});
export type WaiterAssignmentSet = z.infer<typeof WaiterAssignmentSet>;

export const WaiterAssignmentsResponse = z.object({
  /** Today's business date and its assignments (empty until the manager assigns). */
  current: WaiterAssignmentSet,
  /** The most recent earlier set, which the manager can apply again in one step. */
  previous: WaiterAssignmentSet.nullable(),
});
export type WaiterAssignmentsResponse = z.infer<typeof WaiterAssignmentsResponse>;
