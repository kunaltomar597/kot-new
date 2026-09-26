import type { RecipientContext } from '@rp/domain';
import { dbDate } from '../common/business-dates.js';
import type { TransactionClient } from '../database/prisma.service.js';

export interface RecipientSubject {
  readonly restaurantId: string;
  readonly businessDate: string;
  readonly tableId: string | null;
  readonly tableSessionId: string | null;
  readonly selectedIds?: readonly string[];
  readonly wearerId?: string | null;
}

/**
 * The people a rule can name, as the restaurant is now (P2-03):
 * - the responsible waiter of the table session (TBL-002);
 * - the waiters assigned to the table's section today (shift assignments);
 * - managers on duty: Owner and managers signed in on a device now, else every active manager;
 * - cashiers on duty: those with an open cash shift, else those signed in;
 * - the Owner.
 */
export async function recipientContext(
  tx: TransactionClient,
  subject: RecipientSubject,
  now: Date,
  reachable: (staffId: string) => boolean,
): Promise<RecipientContext> {
  const { restaurantId } = subject;
  const [session, table, staff, signedIn, shifts] = await Promise.all([
    subject.tableSessionId === null
      ? Promise.resolve(null)
      : tx.tableSession.findUnique({
          where: { id: subject.tableSessionId },
          select: { waiterId: true },
        }),
    subject.tableId === null
      ? Promise.resolve(null)
      : tx.diningTable.findUnique({ where: { id: subject.tableId }, select: { sectionId: true } }),
    tx.staff.findMany({
      where: { restaurantId, active: true, archivedAt: null },
      select: { id: true, onBreakSince: true, role: { select: { baseRole: true } } },
    }),
    tx.session.findMany({
      where: { restaurantId, revokedAt: null, expiresAt: { gt: now } },
      select: { staffId: true },
    }),
    tx.shift.findMany({ where: { restaurantId, status: 'OPEN' }, select: { staffId: true } }),
  ]);
  const byRole = (roles: readonly string[]) =>
    staff.filter((person) => roles.includes(person.role.baseRole)).map((person) => person.id);
  const online = new Set(signedIn.map((entry) => entry.staffId));
  const managers = byRole(['OWNER', 'MANAGER']);
  const cashiers = byRole(['CASHIER']);
  const onDuty = (ids: readonly string[], preferred: ReadonlySet<string>) => {
    const present = ids.filter((id) => preferred.has(id));
    return present.length > 0 ? present : [...ids];
  };
  const sectionWaiterIds =
    table === null
      ? []
      : (
          await tx.shiftAssignment.findMany({
            where: {
              restaurantId,
              sectionId: table.sectionId,
              businessDate: dbDate(subject.businessDate),
            },
            select: { staffId: true },
          })
        ).map((assignment) => assignment.staffId);
  return {
    responsibleWaiterId: session?.waiterId ?? null,
    sectionWaiterIds: [...new Set(sectionWaiterIds)],
    allWaiterIds: byRole(['WAITER']),
    managersOnDuty: onDuty(managers, online),
    cashiersOnDuty: onDuty(cashiers, new Set(shifts.map((shift) => shift.staffId))),
    ownerIds: byRole(['OWNER']),
    selectedIds: subject.selectedIds ?? [],
    wearerId: subject.wearerId ?? null,
    onBreak: new Set(
      staff.filter((person) => person.onBreakSince !== null).map((person) => person.id),
    ),
    reachable,
  };
}
