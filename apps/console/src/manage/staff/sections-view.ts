import type {
  FloorResponse,
  StaffView,
  UpdateWaiterAssignmentsRequest,
  WaiterAssignmentSet,
  WaiterAssignmentView,
} from '@rp/contracts';
import {
  type AssignmentScope,
  type FloorTable,
  grantOf,
  type PlannedAssignment,
  reapplyAssignments,
  type Role,
  tablesOf,
  tablesWithoutWaiter,
  toWaiterAssignments,
} from '@rp/domain';

/**
 * Today's sections (P4-02b, TBL-002): what the page shows and the whole-day plan it sends. The
 * server replaces the day's assignments with each save, so every change is made to the plan as it
 * stands on the server, without people and places no longer in use.
 */

/** A section in use today, with its tables in use, in the manager's display order. */
export interface ActiveSection {
  readonly id: string;
  readonly name: string;
  readonly tables: readonly { readonly id: string; readonly label: string }[];
}

/** The floor without archived sections and tables. */
export function activeFloor(floor: FloorResponse): ActiveSection[] {
  return floor.sections
    .filter((section) => section.archivedAt === null)
    .map((section) => ({
      id: section.id,
      name: section.name,
      tables: section.tables
        .filter((table) => table.archivedAt === null)
        .map((table) => ({ id: table.id, label: table.label })),
    }));
}

function floorTables(floor: readonly ActiveSection[]): FloorTable[] {
  return floor.flatMap((section) =>
    section.tables.map((table) => ({ id: table.id, sectionId: section.id })),
  );
}

const ROLE_ORDER: Readonly<Record<Role, number>> = {
  WAITER: 0,
  MANAGER: 1,
  CASHIER: 2,
  OWNER: 3,
  KITCHEN: 4,
};

/**
 * The people who may be given tables today: active and taking orders (the server's rule, their
 * custom role applied), waiters first, then by name.
 */
export function assignablePeople(staff: readonly StaffView[]): StaffView[] {
  return staff
    .filter((person) => person.active && grantOf(person, 'ORDER_CREATE') !== 'DENY')
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName),
    );
}

/** Who and what may still be assigned, so a saved plan never names anything gone. */
export function scopeOf(
  people: readonly StaffView[],
  floor: readonly ActiveSection[],
): AssignmentScope {
  return {
    staffIds: new Set(assignablePeople(people).map((person) => person.id)),
    sectionIds: new Set(floor.map((section) => section.id)),
    tableIds: new Set(floorTables(floor).map((table) => table.id)),
  };
}

export function planOf(assignments: readonly WaiterAssignmentView[]): PlannedAssignment[] {
  return assignments.map(({ staffId, sectionIds, tableIds }) => ({
    staffId,
    sectionIds,
    tableIds,
  }));
}

/** The plan with one person's sections and tables replaced; nothing ticked takes them off. */
export function withPlanFor(
  plan: readonly PlannedAssignment[],
  change: PlannedAssignment,
): PlannedAssignment[] {
  const others = plan.filter((assignment) => assignment.staffId !== change.staffId);
  if (change.sectionIds.length + change.tableIds.length === 0) return others;
  const at = plan.findIndex((assignment) => assignment.staffId === change.staffId);
  if (at === -1) return [...others, change];
  return [...others.slice(0, at), change, ...others.slice(at)];
}

/** The request for a plan, kept to what is still in use. */
export function requestOf(
  plan: readonly PlannedAssignment[],
  scope: AssignmentScope,
): UpdateWaiterAssignmentsRequest {
  return {
    assignments: reapplyAssignments(plan, scope).assignments.map((assignment) => ({
      staffId: assignment.staffId,
      sectionIds: [...assignment.sectionIds],
      tableIds: [...assignment.tableIds],
    })),
  };
}

/** One person's day in words: their sections, their own tables, and how many tables in all. */
export interface PersonDay {
  readonly sections: readonly string[];
  readonly tables: readonly string[];
  readonly tableCount: number;
}

export function personDay(
  staffId: string,
  plan: readonly PlannedAssignment[],
  floor: readonly ActiveSection[],
): PersonDay {
  const mine = plan.find((assignment) => assignment.staffId === staffId);
  const sectionName = new Map(floor.map((section) => [section.id, section.name]));
  const tableLabel = new Map(
    floor.flatMap((section) => section.tables.map((table) => [table.id, table.label] as const)),
  );
  const tables = floorTables(floor);
  return {
    sections: (mine?.sectionIds ?? []).flatMap((id) => sectionName.get(id) ?? []),
    tables: (mine?.tableIds ?? []).flatMap((id) => tableLabel.get(id) ?? []),
    tableCount: tablesOf(staffId, tables, toWaiterAssignments(plan, tables)).length,
  };
}

/** Tables nobody looks after, by section: the whole section, or some of its tables. */
export interface Uncovered {
  readonly sectionId: string;
  readonly section: string;
  /** Empty when the whole section is uncovered. */
  readonly tables: readonly string[];
}

export function uncoveredOf(
  plan: readonly PlannedAssignment[],
  floor: readonly ActiveSection[],
): Uncovered[] {
  const tables = floorTables(floor);
  const open = new Set(tablesWithoutWaiter(tables, toWaiterAssignments(plan, tables)));
  return floor.flatMap((section) => {
    const missing = section.tables.filter((table) => open.has(table.id));
    if (missing.length === 0) return [];
    const whole = missing.length === section.tables.length;
    return [
      {
        sectionId: section.id,
        section: section.name,
        tables: whole ? [] : missing.map((table) => table.label),
      },
    ];
  });
}

/** "Same as last time": the earlier day's plan and the names of the people left out of it. */
export function sameAsBefore(
  previous: WaiterAssignmentSet,
  scope: AssignmentScope,
): { readonly plan: PlannedAssignment[]; readonly leftOut: string[] } {
  const { assignments, leftOut } = reapplyAssignments(planOf(previous.assignments), scope);
  const names = new Map(
    previous.assignments.map((assignment) => [assignment.staffId, assignment.staffName]),
  );
  return { plan: assignments, leftOut: leftOut.map((id) => names.get(id) ?? id) };
}

/** A business date as people say it, e.g. "Sunday, 27 September" (the date is a calendar date). */
export function dayOf(isoDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** Names in a sentence: "Priya and Ravi". */
export function namesOf(names: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
}
