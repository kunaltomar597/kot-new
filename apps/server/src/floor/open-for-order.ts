import { responsibleWaiters, tableMachine, transition } from '@rp/domain';
import type { AuditService } from '../audit/audit.service.js';
import { dbDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import type { TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';

/**
 * QR-010: approving a diner's order for a table that is not open opens the table, laid for one
 * until the waiter says more. Its waiter is the one who looks after the table today (TBL-002), or
 * else whoever approved. If someone opened the table meanwhile, the order joins that session.
 * The caller holds the table's row lock.
 */
export async function openTableForOrder(
  tx: TransactionClient,
  audit: AuditService,
  input: {
    readonly restaurantId: string;
    readonly tableId: string;
    readonly businessDate: string;
    readonly approverId: string;
    readonly deviceId: string | null;
  },
): Promise<string> {
  const { restaurantId, tableId, businessDate } = input;
  const open = await tx.tableSession.findFirst({
    where: { restaurantId, tableId, status: 'OPEN' },
    select: { id: true },
  });
  if (open !== null) return open.id;
  const table = await tx.diningTable.findFirst({
    where: { id: tableId, restaurantId, archivedAt: null },
  });
  if (table === null) throw new AppError(404, 'TABLE_NOT_FOUND', 'There is no such active table.');
  // Diners ordering at a table waiting to be cleaned are evidently seated there (TBL-004).
  const from = table.state === 'NEEDS_CLEANING' ? 'FREE' : table.state;
  if (from !== 'FREE') {
    throw new AppError(409, 'TABLE_NOT_FREE', `Table ${table.label} is already in use.`);
  }
  const to = transition(tableMachine, from, 'OPEN').to;
  const assignments = await tx.shiftAssignment.findMany({
    where: { restaurantId, businessDate: dbDate(businessDate) },
    orderBy: { id: 'asc' },
    select: { staffId: true, sectionId: true, tableId: true },
  });
  const waiterId = responsibleWaiters(table, assignments)[0] ?? input.approverId;
  const session = await tx.tableSession.create({
    data: {
      id: newId(),
      restaurantId,
      tableId,
      businessDate: dbDate(businessDate),
      covers: 1,
      waiterId,
    },
  });
  await tx.diningTable.update({ where: { id: tableId }, data: { state: to } });
  await audit.record(tx, {
    action: 'TABLE_OPENED',
    entityType: 'table_session',
    entityId: session.id,
    actorId: input.approverId,
    deviceId: input.deviceId,
    restaurantId,
    before: null,
    after: { tableId, covers: 1, waiterId },
    reason: 'Opened by approving a QR order',
  });
  const occurredAt = new Date().toISOString();
  for (const event of [
    { type: 'TableOpened', payload: { tableId, tableSessionId: session.id, covers: 1, waiterId } },
    { type: 'TableStateChanged', payload: { tableId, state: to } },
  ] as const) {
    await appendEvent(
      tx,
      { eventId: newId(), version: 1, occurredAt, restaurantId, businessDate, ...event },
      { aggregate: { type: 'table_session', id: session.id } },
    );
  }
  return session.id;
}
