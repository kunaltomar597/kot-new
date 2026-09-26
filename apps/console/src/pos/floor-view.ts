import type { FloorResponse, TableOverviewEntry, TableOverviewResponse } from '@rp/contracts';
import type { Translator } from '@rp/i18n';

/** One section of the POS floor, in the manager's display order, active tables only. */
export interface FloorSection {
  readonly id: string;
  readonly name: string;
  readonly tables: readonly TableOverviewEntry[];
}

/**
 * The live floor (TBL-007): the overview's tables grouped under their sections in display order.
 * Archived sections and tables are left out; a table the overview has but the floor does not (it
 * was added since the floor was read) goes to the end, under no section.
 */
export function floorSections(
  floor: FloorResponse,
  overview: TableOverviewResponse,
): FloorSection[] {
  const byId = new Map(overview.tables.map((table) => [table.tableId, table]));
  const placed = new Set<string>();
  const sections: FloorSection[] = [];
  for (const section of floor.sections) {
    if (section.archivedAt !== null) continue;
    const tables: TableOverviewEntry[] = [];
    for (const table of section.tables) {
      const live = byId.get(table.id);
      if (table.archivedAt !== null || live === undefined) continue;
      tables.push(live);
      placed.add(table.id);
    }
    if (tables.length > 0) sections.push({ id: section.id, name: section.name, tables });
  }
  const rest = overview.tables.filter((table) => !placed.has(table.tableId));
  if (rest.length > 0) sections.push({ id: '', name: '', tables: rest });
  return sections;
}

/** Whole minutes since `openedAt`, never negative (clocks on devices drift). */
export function minutesSince(openedAt: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(openedAt)) / 60_000));
}

/** "25 min" or "1 h 05 min": how long guests have been seated (TBL-007). */
export function seatedFor(openedAt: string, now: number, t: Translator): string {
  const minutes = minutesSince(openedAt, now);
  if (minutes < 60) return t('pos.seatedMinutes', { minutes });
  return t('pos.seatedHours', {
    hours: Math.floor(minutes / 60),
    minutes: String(minutes % 60).padStart(2, '0'),
  });
}

/** The short facts on a table tile: guests, time seated, waiter. */
export function tileDetails(table: TableOverviewEntry, now: number, t: Translator): string[] {
  if (table.session === null) return [];
  return [
    t('pos.guests', { count: table.session.covers }),
    seatedFor(table.session.openedAt, now, t),
    table.session.waiterName,
  ];
}

/** What is waiting for staff at a table: approvals first, then service requests. */
export function tileAlert(table: TableOverviewEntry, t: Translator): string | undefined {
  const approvals = table.session?.pendingApprovals ?? 0;
  if (approvals > 0) return t('pos.toApprove', { count: approvals });
  if (table.activeServiceRequests > 0) {
    return t('pos.requests', { count: table.activeServiceRequests });
  }
  return undefined;
}

/** Events after which the overview is read again (tables, orders, bills, service requests). */
export function affectsFloor(eventType: string): boolean {
  return /^(Table|Order|Bill|ServiceRequest|ItemStatusChanged$|MenuPublished$)/.test(eventType);
}
