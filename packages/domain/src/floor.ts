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
