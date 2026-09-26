import { Injectable } from '@nestjs/common';
import type {
  DomainEvent,
  OpenTableRequest,
  TableOverviewEntry,
  TableSessionView,
} from '@rp/contracts';
import {
  grantFor,
  isBillable,
  ORDER_ITEM_STATES,
  responsibleWaiters,
  tableMachine,
  type TableEvent,
  type TableState,
  transition,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { authErrors } from '../auth/auth-errors.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent, type EventAudience } from '../events/outbox.js';
import type { DiningTable, TableSession } from '../generated/prisma/client.js';
import { WaiterAssignmentsService } from './waiter-assignments.service.js';

/** Items that keep a table from being closed without a bill: billable or awaiting approval. */
const OPEN_ITEM_STATES = ORDER_ITEM_STATES.filter(
  (state) => isBillable(state) || state === 'PENDING_APPROVAL',
);

type SessionRow = TableSession & { table: DiningTable };

type EventInput = {
  [T in DomainEvent['type']]: { type: T; payload: Extract<DomainEvent, { type: T }>['payload'] };
}[DomainEvent['type']];

function sessionNotFound(): AppError {
  return new AppError(404, 'TABLE_SESSION_NOT_FOUND', 'There is no such open table.');
}

/**
 * Table sessions (P1-02b, TBL-003 to TBL-005, WTR-008). Every change locks the table rows it
 * touches, follows `@rp/domain` `tableMachine`, writes an audit entry and the table events in one
 * transaction, so two devices acting on one table at once cannot both succeed.
 */
@Injectable()
export class TableSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly assignments: WaiterAssignmentsService,
  ) {}

  /** The live table overview (TBL-007): active tables in floor order. */
  async overview(restaurantId: string): Promise<TableOverviewEntry[]> {
    const tables = await this.prisma.diningTable.findMany({
      where: { restaurantId, archivedAt: null, section: { archivedAt: null } },
      orderBy: [
        { section: { displayOrder: 'asc' } },
        { displayOrder: 'asc' },
        { createdAt: 'asc' },
      ],
      include: { sessions: { where: { status: 'OPEN' }, take: 1 } },
    });
    const sessions = tables.flatMap((table) => table.sessions);
    const sessionIds = sessions.map((session) => session.id);
    const [names, items] = await Promise.all([
      this.staffNames(sessions.map((session) => session.waiterId).filter((id) => id !== null)),
      this.prisma.orderItem.findMany({
        where: { order: { tableSessionId: { in: sessionIds } } },
        select: { state: true, lineTotal: true, order: { select: { tableSessionId: true } } },
      }),
    ]);
    const amounts = new Map<string, number>();
    const pending = new Map<string, number>();
    for (const item of items) {
      const sessionId = item.order.tableSessionId;
      if (sessionId === null) continue;
      if (isBillable(item.state))
        amounts.set(sessionId, (amounts.get(sessionId) ?? 0) + item.lineTotal);
      if (item.state === 'PENDING_APPROVAL')
        pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1);
    }
    return tables.map((table) => {
      const session = table.sessions[0];
      return {
        tableId: table.id,
        label: table.label,
        sectionId: table.sectionId,
        capacity: table.capacity,
        state: table.state,
        session:
          session === undefined
            ? null
            : {
                id: session.id,
                openedAt: session.openedAt.toISOString(),
                covers: session.covers ?? 1,
                waiterId: session.waiterId ?? '',
                waiterName: names.get(session.waiterId ?? '') ?? '',
                amountSoFar: amounts.get(session.id) ?? 0,
                pendingApprovals: pending.get(session.id) ?? 0,
              },
        activeServiceRequests: 0,
      };
    });
  }

  open(
    principal: Principal,
    tableId: string,
    request: OpenTableRequest,
  ): Promise<TableSessionView> {
    return this.prisma.transaction(async (tx) => {
      const table = await this.lockTable(tx, principal.restaurantId, tableId);
      if (table === null) {
        throw new AppError(404, 'TABLE_NOT_FOUND', 'There is no such active table.');
      }
      if (table.state !== 'FREE') {
        throw new AppError(409, 'TABLE_NOT_FREE', `Table ${table.label} is already in use.`);
      }
      const to = transition(tableMachine, table.state, 'OPEN').to;
      const businessDate = await currentBusinessDate(tx, principal.restaurantId);
      const waiterId =
        request.waiterId ?? (await this.defaultWaiter(tx, principal, table, businessDate));
      await this.assertWaiter(tx, principal.restaurantId, waiterId);

      const session = await tx.tableSession.create({
        data: {
          id: newId(),
          restaurantId: principal.restaurantId,
          tableId,
          businessDate: dbDate(businessDate),
          covers: request.covers,
          waiterId,
        },
        include: { table: true },
      });
      await tx.diningTable.update({ where: { id: tableId }, data: { state: to } });
      await this.record(tx, principal, 'TABLE_OPENED', session.id, {
        before: null,
        after: { tableId, covers: request.covers, waiterId },
      });
      await this.emit(tx, principal.restaurantId, businessDate, session.id, [
        {
          type: 'TableOpened',
          payload: { tableId, tableSessionId: session.id, covers: request.covers, waiterId },
        },
        { type: 'TableStateChanged', payload: { tableId, state: to } },
      ]);
      return this.view(tx, { ...session, table: { ...session.table, state: to } });
    });
  }

  requestBill(
    principal: Principal,
    sessionId: string,
    requestedFrom: 'WAITER_APP' | 'POS',
  ): Promise<TableSessionView> {
    return this.prisma.transaction(async (tx) => {
      const session = await this.lockSession(tx, principal.restaurantId, sessionId);
      const to = transition(tableMachine, session.table.state, 'REQUEST_BILL').to;
      await tx.diningTable.update({ where: { id: session.tableId }, data: { state: to } });
      await this.emit(tx, principal.restaurantId, isoDateOf(session.businessDate), sessionId, [
        {
          type: 'BillRequested',
          payload: {
            tableSessionId: sessionId,
            requestedFrom,
          },
        },
        { type: 'TableStateChanged', payload: { tableId: session.tableId, state: to } },
      ]);
      return this.view(tx, { ...session, table: { ...session.table, state: to } });
    });
  }

  closeWithoutBill(
    principal: Principal,
    sessionId: string,
    reason: string,
  ): Promise<TableSessionView> {
    return this.prisma.transaction(async (tx) => {
      const session = await this.lockSession(tx, principal.restaurantId, sessionId);
      const to = this.next(session.table.state, 'CLOSE_WITHOUT_BILL');
      const items = await tx.orderItem.count({
        where: { order: { tableSessionId: sessionId }, state: { in: [...OPEN_ITEM_STATES] } },
      });
      if (items > 0) {
        throw new AppError(
          409,
          'TABLE_HAS_ITEMS',
          'Items have been ordered at this table. Cancel them, or print the bill, to close it.',
          { itemCount: items },
        );
      }
      const closed = await tx.tableSession.update({
        where: { id: sessionId },
        data: { status: 'CLOSED', closedAt: new Date(), closeReason: reason },
        include: { table: true },
      });
      await tx.diningTable.update({ where: { id: session.tableId }, data: { state: to } });
      await this.record(tx, principal, 'TABLE_CLOSED_WITHOUT_BILL', sessionId, {
        before: { status: 'OPEN', state: session.table.state },
        after: { status: 'CLOSED', state: to },
        reason,
      });
      await this.emit(tx, principal.restaurantId, isoDateOf(session.businessDate), sessionId, [
        { type: 'TableClosed', payload: { tableId: session.tableId, tableSessionId: sessionId } },
        { type: 'TableStateChanged', payload: { tableId: session.tableId, state: to } },
      ]);
      return this.view(tx, { ...closed, table: { ...closed.table, state: to } });
    });
  }

  move(
    principal: Principal,
    sessionId: string,
    toTableId: string,
    ownOnly: boolean,
  ): Promise<TableSessionView> {
    return this.prisma.transaction(async (tx) => {
      const found = await tx.tableSession.findFirst({
        where: { id: sessionId, restaurantId: principal.restaurantId, status: 'OPEN' },
        select: { tableId: true },
      });
      if (found === null) throw sessionNotFound();
      if (found.tableId === toTableId) {
        throw new AppError(409, 'TABLE_NOT_FREE', 'The guests are already at that table.');
      }
      // Both tables, in a fixed order so two moves in opposite directions cannot deadlock.
      for (const id of [found.tableId, toTableId].sort()) {
        await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${id}::uuid FOR UPDATE`;
      }
      const session = await this.lockSession(tx, principal.restaurantId, sessionId);
      if (ownOnly && session.waiterId !== principal.staffId) throw authErrors.forbidden();
      const target = await tx.diningTable.findFirst({
        where: {
          id: toTableId,
          restaurantId: principal.restaurantId,
          archivedAt: null,
          section: { archivedAt: null },
        },
      });
      if (target === null) {
        throw new AppError(404, 'TABLE_NOT_FOUND', 'There is no such active table.');
      }
      if (target.state !== 'FREE') {
        throw new AppError(409, 'TABLE_NOT_FREE', `Table ${target.label} is already in use.`);
      }

      const state = session.table.state;
      await tx.tableSession.update({ where: { id: sessionId }, data: { tableId: toTableId } });
      await tx.order.updateMany({
        where: { tableSessionId: sessionId },
        data: { tableId: toTableId },
      });
      await tx.diningTable.update({ where: { id: session.tableId }, data: { state: 'FREE' } });
      await tx.diningTable.update({ where: { id: toTableId }, data: { state } });
      const kots = await tx.kot.findMany({
        where: { order: { tableSessionId: sessionId } },
        select: { stationId: true },
        distinct: ['stationId'],
      });
      await this.noteMoveForPrinters(tx, principal.restaurantId, session, target.label, kots);
      await this.record(tx, principal, 'TABLE_MOVED', sessionId, {
        before: { tableId: session.tableId, tableLabel: session.table.label },
        after: { tableId: toTableId, tableLabel: target.label },
      });
      // Tickets update in place: their stations hear the move; printing stations get a note (TBL-005).
      await this.emit(
        tx,
        principal.restaurantId,
        isoDateOf(session.businessDate),
        sessionId,
        [
          {
            type: 'TableMoved',
            payload: { tableSessionId: sessionId, fromTableId: session.tableId, toTableId },
          },
          { type: 'TableStateChanged', payload: { tableId: session.tableId, state: 'FREE' } },
          { type: 'TableStateChanged', payload: { tableId: toTableId, state } },
        ],
        { stationIds: kots.map((kot) => kot.stationId) },
      );
      return this.view(tx, { ...session, tableId: toTableId, table: { ...target, state } });
    });
  }

  assignWaiter(
    principal: Principal,
    sessionId: string,
    waiterId: string,
    reason: string | undefined,
  ): Promise<TableSessionView> {
    return this.prisma.transaction(async (tx) => {
      const session = await this.lockSession(tx, principal.restaurantId, sessionId);
      await this.assertWaiter(tx, principal.restaurantId, waiterId);
      if (session.waiterId === waiterId) return this.view(tx, session);
      const updated = await tx.tableSession.update({
        where: { id: sessionId },
        data: { waiterId },
        include: { table: true },
      });
      await this.record(tx, principal, 'TABLE_WAITER_CHANGED', sessionId, {
        before: { waiterId: session.waiterId },
        after: { waiterId },
        reason: reason ?? null,
      });
      await this.emit(tx, principal.restaurantId, isoDateOf(session.businessDate), sessionId, [
        {
          type: 'TableWaiterChanged',
          payload: { tableId: session.tableId, tableSessionId: sessionId, waiterId },
        },
      ]);
      return this.view(tx, updated);
    });
  }

  private next(state: TableState, event: TableEvent): TableState {
    return transition(tableMachine, state, event).to;
  }

  /** The table's first responsible waiter today (TBL-002), else the person opening it. */
  private async defaultWaiter(
    tx: TransactionClient,
    principal: Principal,
    table: DiningTable,
    businessDate: string,
  ): Promise<string> {
    const assignments = await this.assignments.assignmentsFor(
      tx,
      principal.restaurantId,
      businessDate,
    );
    return responsibleWaiters(table, assignments)[0] ?? principal.staffId;
  }

  private async assertWaiter(
    tx: TransactionClient,
    restaurantId: string,
    staffId: string,
  ): Promise<void> {
    const person = await tx.staff.findFirst({
      where: { id: staffId, restaurantId, active: true, archivedAt: null },
      select: { role: { select: { baseRole: true } } },
    });
    if (person === null || grantFor(person.role.baseRole, 'ORDER_CREATE') === 'DENY') {
      throw new AppError(
        422,
        'STAFF_NOT_ASSIGNABLE',
        'Only active staff who take orders can look after a table.',
        { staffId },
      );
    }
  }

  /** Locks an active table row; null when there is no such active table. */
  private async lockTable(
    tx: TransactionClient,
    restaurantId: string,
    tableId: string,
  ): Promise<DiningTable | null> {
    await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${tableId}::uuid FOR UPDATE`;
    return tx.diningTable.findFirst({
      where: { id: tableId, restaurantId, archivedAt: null, section: { archivedAt: null } },
    });
  }

  /** An open session with its table row locked. */
  private async lockSession(
    tx: TransactionClient,
    restaurantId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    const found = await tx.tableSession.findFirst({
      where: { id: sessionId, restaurantId, status: 'OPEN' },
      select: { tableId: true },
    });
    if (found === null) throw sessionNotFound();
    await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${found.tableId}::uuid FOR UPDATE`;
    const session = await tx.tableSession.findFirst({
      where: { id: sessionId, status: 'OPEN' },
      include: { table: true },
    });
    if (session === null) throw sessionNotFound();
    return session;
  }

  private async staffNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const people = await this.prisma.staff.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true },
    });
    return new Map(people.map((person) => [person.id, person.displayName]));
  }

  private async view(tx: TransactionClient, session: SessionRow): Promise<TableSessionView> {
    const waiter =
      session.waiterId === null
        ? null
        : await tx.staff.findUnique({
            where: { id: session.waiterId },
            select: { displayName: true },
          });
    return {
      id: session.id,
      tableId: session.tableId,
      tableLabel: session.table.label,
      state: session.status === 'OPEN' ? session.table.state : 'FREE',
      status: session.status,
      covers: session.covers ?? 1,
      waiterId: session.waiterId ?? '',
      waiterName: waiter?.displayName ?? '',
      businessDate: isoDateOf(session.businessDate),
      openedAt: session.openedAt.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
      closeReason: session.closeReason,
    };
  }

  /**
   * Stations that print get a note "Moved from T4 to T7" (TBL-005): their tickets already on paper
   * stay valid, so nothing is printed again as a ticket. Screens update the tickets in place.
   */
  private async noteMoveForPrinters(
    tx: TransactionClient,
    restaurantId: string,
    session: { id: string; businessDate: Date; table: { label: string } },
    toLabel: string,
    kots: readonly { stationId: string }[],
  ): Promise<void> {
    if (kots.length === 0) return;
    const [stations, orders] = await Promise.all([
      tx.station.findMany({
        where: { id: { in: kots.map((kot) => kot.stationId) }, mode: { not: 'SCREEN' } },
        select: { id: true },
      }),
      tx.order.findMany({
        where: { tableSessionId: session.id },
        select: { orderNumber: true },
        orderBy: { orderNumber: 'asc' },
      }),
    ]);
    const lines = [
      `From ${session.table.label} to ${toLabel}`,
      `Orders ${orders.map((order) => String(order.orderNumber)).join(', ')}`,
    ];
    for (const station of stations) {
      await tx.printNotice.create({
        data: {
          restaurantId,
          businessDate: session.businessDate,
          stationId: station.id,
          title: 'MOVED',
          lines,
        },
      });
    }
  }

  private async emit(
    tx: TransactionClient,
    restaurantId: string,
    businessDate: string,
    sessionId: string,
    events: readonly EventInput[],
    audience?: EventAudience,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    for (const event of events) {
      await appendEvent(
        tx,
        {
          eventId: newId(),
          version: 1,
          occurredAt,
          restaurantId,
          businessDate,
          ...event,
        },
        {
          aggregate: { type: 'table_session', id: sessionId },
          ...(audience !== undefined && { audience }),
        },
      );
    }
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    sessionId: string,
    change: { before: unknown; after: unknown; reason?: string | null },
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'table_session',
      entityId: sessionId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before: change.before,
      after: change.after,
      reason: change.reason ?? null,
    });
  }
}
