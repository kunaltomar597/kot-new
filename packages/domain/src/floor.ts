/**
 * Waiter assignment (TBL-002): at shift start the manager assigns waiters to sections, and
 * optionally to individual tables. The responsible waiter for a table is its assigned waiter; a
 * table session may override it.
 */

/** One waiter assigned to a whole section (`tableId` null) or to one table of it. */
export interface WaiterAssignment {
  readonly staffId: string;
  readonly sectionId: string;
  readonly tableId: string | null;
}

export interface FloorTable {
  readonly id: string;
  readonly sectionId: string;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * The waiters responsible for a table, in assignment order. Waiters given the table itself take
 * it over from the section's waiters; otherwise the section's waiters share it. The first is the
 * default responsible waiter of a new table session.
 */
export function responsibleWaiters(
  table: FloorTable,
  assignments: readonly WaiterAssignment[],
): string[] {
  const direct = assignments.filter((assignment) => assignment.tableId === table.id);
  if (direct.length > 0) return unique(direct.map((assignment) => assignment.staffId));
  return unique(
    assignments
      .filter(
        (assignment) => assignment.tableId === null && assignment.sectionId === table.sectionId,
      )
      .map((assignment) => assignment.staffId),
  );
}

/** The tables a waiter looks after ("My tables", WTR-002), in the order given. */
export function tablesOf(
  staffId: string,
  tables: readonly FloorTable[],
  assignments: readonly WaiterAssignment[],
): string[] {
  return tables
    .filter((table) => responsibleWaiters(table, assignments).includes(staffId))
    .map((table) => table.id);
}

/** One person's sections and single tables for the day, as the manager gives them (TBL-002). */
export interface PlannedAssignment {
  readonly staffId: string;
  readonly sectionIds: readonly string[];
  readonly tableIds: readonly string[];
}

/**
 * The day's plan as single assignments, in order: each person's sections, then their tables with
 * each table's section. Tables not on the floor given are skipped.
 */
export function toWaiterAssignments(
  planned: readonly PlannedAssignment[],
  tables: readonly FloorTable[],
): WaiterAssignment[] {
  const sectionOf = new Map(tables.map((table) => [table.id, table.sectionId]));
  return planned.flatMap((assignment) => [
    ...assignment.sectionIds.map((sectionId) => ({
      staffId: assignment.staffId,
      sectionId,
      tableId: null,
    })),
    ...assignment.tableIds.flatMap((tableId) => {
      const sectionId = sectionOf.get(tableId);
      return sectionId === undefined ? [] : [{ staffId: assignment.staffId, sectionId, tableId }];
    }),
  ]);
}

/** The tables nobody looks after today, in the order given (TBL-002 at shift start). */
export function tablesWithoutWaiter(
  tables: readonly FloorTable[],
  assignments: readonly WaiterAssignment[],
): string[] {
  return tables
    .filter((table) => responsibleWaiters(table, assignments).length === 0)
    .map((table) => table.id);
}

/** Who may still be given tables, and which sections and tables are still in use. */
export interface AssignmentScope {
  /** Active people who take orders (ORDER_CREATE). */
  readonly staffIds: ReadonlySet<string>;
  /** Sections and tables not archived. */
  readonly sectionIds: ReadonlySet<string>;
  readonly tableIds: ReadonlySet<string>;
}

export interface ReappliedAssignments {
  readonly assignments: PlannedAssignment[];
  /** People of the earlier plan who are left out, in its order. */
  readonly leftOut: string[];
}

/**
 * "Same as last time" (TBL-002): an earlier day's plan given again, without people who were
 * deactivated or no longer take orders, and without archived sections and tables. Someone left
 * with nothing is left out.
 */
export function reapplyAssignments(
  earlier: readonly PlannedAssignment[],
  scope: AssignmentScope,
): ReappliedAssignments {
  const assignments: PlannedAssignment[] = [];
  const leftOut: string[] = [];
  for (const assignment of earlier) {
    const kept = {
      staffId: assignment.staffId,
      sectionIds: unique(assignment.sectionIds.filter((id) => scope.sectionIds.has(id))),
      tableIds: unique(assignment.tableIds.filter((id) => scope.tableIds.has(id))),
    };
    const hasWork = kept.sectionIds.length + kept.tableIds.length > 0;
    if (scope.staffIds.has(assignment.staffId) && hasWork) assignments.push(kept);
    else leftOut.push(assignment.staffId);
  }
  return { assignments, leftOut };
}
