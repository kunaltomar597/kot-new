import { Injectable } from '@nestjs/common';
import type {
  UpdateWaiterAssignmentsRequest,
  WaiterAssignmentSet,
  WaiterAssignmentsResponse,
  WaiterAssignmentView,
} from '@rp/contracts';
import { grantFor, type WaiterAssignment } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';

type Client = Pick<TransactionClient, 'shiftAssignment'>;

function sameSet(a: readonly WaiterAssignmentView[], b: readonly WaiterAssignmentView[]): boolean {
  const strip = (views: readonly WaiterAssignmentView[]) =>
    JSON.stringify(
      views.map(({ staffId, sectionIds, tableIds }) => [staffId, sectionIds, tableIds]),
    );
  return strip(a) === strip(b);
}

/**
 * Waiter assignment (P1-02a, TBL-002): at shift start the manager assigns waiters to sections,
 * and optionally to single tables, for the business day. Each day starts empty; the previous set
 * is offered so the manager can apply it again in one step. `@rp/domain` `responsibleWaiters`
 * turns the day's assignments into the responsible waiter of a table.
 */
@Injectable()
export class WaiterAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(restaurantId: string): Promise<WaiterAssignmentsResponse> {
    const today = await currentBusinessDate(this.prisma, restaurantId);
    return this.response(this.prisma, restaurantId, today);
  }

  /** The day's assignments for the responsible-waiter rule (P1-02b). */
  async assignmentsFor(
    client: Client,
    restaurantId: string,
    businessDate: string,
  ): Promise<WaiterAssignment[]> {
    const rows = await client.shiftAssignment.findMany({
      where: { restaurantId, businessDate: dbDate(businessDate) },
      orderBy: { id: 'asc' },
      select: { staffId: true, sectionId: true, tableId: true },
    });
    return rows;
  }

  update(
    principal: Principal,
    request: UpdateWaiterAssignmentsRequest,
  ): Promise<WaiterAssignmentsResponse> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const { restaurantId } = principal;
      const today = await currentBusinessDate(tx, restaurantId);
      const tables = await this.validate(tx, restaurantId, request);
      const before = await this.setFor(tx, restaurantId, today);
      const wanted = request.assignments.map((assignment) => ({
        staffId: assignment.staffId,
        sectionIds: [...new Set(assignment.sectionIds)],
        tableIds: [...new Set(assignment.tableIds)],
      }));
      if (
        sameSet(
          before.assignments,
          wanted.map((view) => ({ ...view, staffName: '' })),
        )
      ) {
        return this.response(tx, restaurantId, today);
      }

      await tx.shiftAssignment.deleteMany({
        where: { restaurantId, businessDate: dbDate(today) },
      });
      // Ids are time-ordered, so reading by id gives back the order the manager chose.
      const rows = wanted.flatMap((assignment) =>
        [
          ...assignment.sectionIds.map((sectionId) => ({ sectionId, tableId: null })),
          ...assignment.tableIds.map((tableId) => ({
            sectionId: tables.get(tableId) ?? '',
            tableId,
          })),
        ].map((row) => ({
          id: newId(),
          restaurantId,
          businessDate: dbDate(today),
          staffId: assignment.staffId,
          ...row,
        })),
      );
      if (rows.length > 0) await tx.shiftAssignment.createMany({ data: rows });

      await this.audit.record(tx, {
        action: 'WAITER_ASSIGNMENTS_CHANGED',
        entityType: 'waiter_assignments',
        entityId: null,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId,
        before: { businessDate: today, assignments: before.assignments },
        after: { businessDate: today, assignments: wanted },
        reason: request.reason ?? null,
      });
      await announceSetupChange(tx, restaurantId, 'WAITER_ASSIGNMENTS', {
        type: 'waiter_assignments',
        id: restaurantId,
      });
      return this.response(tx, restaurantId, today);
    });
  }

  /**
   * Checks every person may take orders (TBL-002 assigns waiters; captains and managers who serve
   * count too) and every section and table is active. Returns each table's section.
   */
  private async validate(
    tx: TransactionClient,
    restaurantId: string,
    request: UpdateWaiterAssignmentsRequest,
  ): Promise<Map<string, string>> {
    const staffIds = request.assignments.map((assignment) => assignment.staffId);
    const sectionIds = [...new Set(request.assignments.flatMap((a) => a.sectionIds))];
    const tableIds = [...new Set(request.assignments.flatMap((a) => a.tableIds))];

    const staff = await tx.staff.findMany({
      where: { id: { in: staffIds }, restaurantId, active: true, archivedAt: null },
      select: { id: true, role: { select: { baseRole: true } } },
    });
    const assignable = new Set(
      staff
        .filter((person) => grantFor(person.role.baseRole, 'ORDER_CREATE') !== 'DENY')
        .map((person) => person.id),
    );
    const refused = staffIds.filter((id) => !assignable.has(id));
    if (refused.length > 0) {
      throw new AppError(
        422,
        'STAFF_NOT_ASSIGNABLE',
        'Only active staff who take orders can be given tables.',
        { staffIds: refused },
      );
    }

    const sections = await tx.section.findMany({
      where: { id: { in: sectionIds }, restaurantId, archivedAt: null },
      select: { id: true },
    });
    if (sections.length !== sectionIds.length) {
      const found = new Set(sections.map((section) => section.id));
      throw new AppError(422, 'SECTION_NOT_FOUND', 'A section is unknown or archived.', {
        sectionIds: sectionIds.filter((id) => !found.has(id)),
      });
    }

    const tables = await tx.diningTable.findMany({
      where: { id: { in: tableIds }, restaurantId, archivedAt: null },
      select: { id: true, sectionId: true },
    });
    if (tables.length !== tableIds.length) {
      const found = new Set(tables.map((table) => table.id));
      throw new AppError(422, 'TABLE_NOT_FOUND', 'A table is unknown or archived.', {
        tableIds: tableIds.filter((id) => !found.has(id)),
      });
    }
    return new Map(tables.map((table) => [table.id, table.sectionId]));
  }

  private async response(
    client: Pick<TransactionClient, 'shiftAssignment' | 'staff'>,
    restaurantId: string,
    today: string,
  ): Promise<WaiterAssignmentsResponse> {
    const current = await this.setFor(client, restaurantId, today);
    const earlier = await client.shiftAssignment.findFirst({
      where: { restaurantId, businessDate: { lt: dbDate(today) } },
      orderBy: { businessDate: 'desc' },
      select: { businessDate: true },
    });
    const previous =
      earlier === null
        ? null
        : await this.setFor(client, restaurantId, isoDateOf(earlier.businessDate));
    return { current, previous };
  }

  private async setFor(
    client: Pick<TransactionClient, 'shiftAssignment' | 'staff'>,
    restaurantId: string,
    businessDate: string,
  ): Promise<WaiterAssignmentSet> {
    const rows = await client.shiftAssignment.findMany({
      where: { restaurantId, businessDate: dbDate(businessDate) },
      orderBy: { id: 'asc' },
      select: {
        staffId: true,
        sectionId: true,
        tableId: true,
        staff: { select: { displayName: true } },
      },
    });
    const byStaff = new Map<string, WaiterAssignmentView>();
    for (const row of rows) {
      let view = byStaff.get(row.staffId);
      if (view === undefined) {
        view = {
          staffId: row.staffId,
          staffName: row.staff.displayName,
          sectionIds: [],
          tableIds: [],
        };
        byStaff.set(row.staffId, view);
      }
      if (row.tableId === null) view.sectionIds.push(row.sectionId);
      else view.tableIds.push(row.tableId);
    }
    return { businessDate, assignments: [...byStaff.values()] };
  }
}
