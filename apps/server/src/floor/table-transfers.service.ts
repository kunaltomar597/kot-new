import { Injectable } from '@nestjs/common';
import type { TableSessionView, TransferItemsRequest, TransferItemsResponse } from '@rp/contracts';
import { isBillable, isKitchenActive, OPEN_SERVICE_REQUEST_STATES } from '@rp/domain';
import type { Principal } from '../auth/principal.js';
import { authErrors } from '../auth/auth-errors.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { allocateDailyNumber } from '../database/numbering.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import {
  type SessionRow,
  sessionNotFound,
  TableSessionsService,
} from './table-sessions.service.js';

/** Audit actions the kitchen screen reads to say where a ticket's table came from (KDS). */
export const ORDERS_MOVED_ACTIONS = ['TABLES_MERGED', 'ITEMS_TRANSFERRED'] as const;

function samePlace(): AppError {
  return new AppError(409, 'TABLE_SAME', 'Choose another open table.');
}

function billPrinted(label: string): AppError {
  return new AppError(
    409,
    'TABLE_BILL_PRINTED',
    `The bill for ${label} is printed. Settle it, or reopen it, first.`,
  );
}

/**
 * Merging tables and moving dishes between them (TBL-006). Both lock the two tables in a fixed
 * order, like a move (TBL-005), so two people acting on the same tables cannot deadlock or both
 * succeed; both are audited and tell every screen through `OrdersMoved`. Nothing is ever deleted:
 * a merged table's session is closed with the session it joined, and dishes moved out of an
 * order that keeps others go to a new order at the other table, made by the same person.
 */
@Injectable()
export class TableTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: TableSessionsService,
  ) {}

  /** The guests at `sessionId` join `intoSessionId`, for one bill. */
  merge(
    principal: Principal,
    sessionId: string,
    intoSessionId: string,
    ownOnly: boolean,
  ): Promise<TableSessionView> {
    return this.prisma.transaction(async (tx) => {
      if (sessionId === intoSessionId) throw samePlace();
      const [from, into] = await this.lockBoth(tx, principal, sessionId, intoSessionId, ownOnly);
      if (from.tableId === into.tableId) throw samePlace();
      for (const session of [from, into]) {
        if (session.table.state === 'BILL_PRINTED') throw billPrinted(session.table.label);
      }
      const [billed, discounts] = await Promise.all([
        tx.invoice.count({
          where: { bill: { tableSessionId: from.id }, status: { not: 'VOIDED' } },
        }),
        tx.discount.count({ where: { bill: { tableSessionId: from.id }, revokedAt: null } }),
      ]);
      if (billed > 0) throw billPrinted(from.table.label);
      if (discounts > 0) {
        throw new AppError(
          409,
          'TABLE_HAS_DISCOUNTS',
          `${from.table.label} has discounts. Take them back first, then merge.`,
        );
      }

      const orders = await tx.order.findMany({
        where: { tableSessionId: from.id },
        select: { id: true, orderNumber: true },
        orderBy: { orderNumber: 'asc' },
      });
      const orderIds = orders.map((order) => order.id);
      await tx.order.updateMany({
        where: { tableSessionId: from.id },
        data: { tableSessionId: into.id, tableId: into.tableId },
      });
      // Requests still open follow the guests; the table they were raised at stays recorded.
      await tx.serviceRequest.updateMany({
        where: { tableSessionId: from.id, state: { in: [...OPEN_SERVICE_REQUEST_STATES] } },
        data: { tableSessionId: into.id },
      });
      const covers = (into.covers ?? 1) + (from.covers ?? 1);
      const merged = await tx.tableSession.update({
        where: { id: into.id },
        data: { covers },
        include: { table: true },
      });
      const left = await this.sessions.stateAfterGuestsLeft(principal.restaurantId);
      await tx.tableSession.update({
        where: { id: from.id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          closeReason: `Merged into ${into.table.label}`,
          mergedIntoSessionId: into.id,
        },
      });
      await tx.diningTable.update({ where: { id: from.tableId }, data: { state: left } });

      const stationIds = await this.notePrinters(tx, principal.restaurantId, from, {
        title: 'MERGED',
        lines: [
          `${from.table.label} joined ${into.table.label}`,
          `Orders ${orders.map((order) => String(order.orderNumber)).join(', ')}`,
        ],
        orderItemWhere: { order: { id: { in: orderIds } } },
      });
      await this.sessions.record(tx, principal, 'TABLES_MERGED', from.id, {
        before: { tableId: from.tableId, tableLabel: from.table.label, covers: from.covers },
        after: {
          intoSessionId: into.id,
          tableId: into.tableId,
          tableLabel: into.table.label,
          covers,
          orderIds,
        },
      });
      await this.sessions.emit(
        tx,
        principal.restaurantId,
        isoDateOf(from.businessDate),
        from.id,
        [
          {
            type: 'OrdersMoved',
            payload: {
              kind: 'MERGE',
              fromTableSessionId: from.id,
              toTableSessionId: into.id,
              fromTableId: from.tableId,
              toTableId: into.tableId,
              orderIds,
            },
          },
          { type: 'TableClosed', payload: { tableId: from.tableId, tableSessionId: from.id } },
          { type: 'TableStateChanged', payload: { tableId: from.tableId, state: left } },
        ],
        { stationIds },
      );
      return this.sessions.view(tx, merged);
    });
  }

  /** Whole lines (a combo with its parts) go to another open table's bill. */
  transfer(
    principal: Principal,
    sessionId: string,
    request: TransferItemsRequest,
    ownOnly: boolean,
  ): Promise<TransferItemsResponse> {
    return this.prisma.transaction(async (tx) => {
      if (sessionId === request.toTableSessionId) throw samePlace();
      const [from, to] = await this.lockBoth(
        tx,
        principal,
        sessionId,
        request.toTableSessionId,
        ownOnly,
      );
      for (const session of [from, to]) {
        if (session.table.state === 'BILL_PRINTED') throw billPrinted(session.table.label);
      }
      const wanted = [...new Set(request.orderItemIds)];
      const lines = await tx.orderItem.findMany({
        where: { id: { in: wanted }, order: { tableSessionId: from.id } },
        select: {
          id: true,
          orderId: true,
          name: true,
          quantity: true,
          state: true,
          parentOrderItemId: true,
          _count: {
            select: {
              discounts: { where: { revokedAt: null } },
              invoiceLines: { where: { invoice: { status: { not: 'VOIDED' } } } },
            },
          },
        },
      });
      if (lines.length !== wanted.length) {
        throw new AppError(404, 'ORDER_ITEM_NOT_FOUND', `A dish is not on ${from.table.label}.`);
      }
      for (const line of lines) {
        if (line.parentOrderItemId !== null) {
          throw new AppError(
            409,
            'ITEM_NOT_MOVABLE',
            'Move the whole combo, not one of its parts.',
          );
        }
        if (!isBillable(line.state) && line.state !== 'HELD') {
          throw new AppError(
            409,
            'ITEM_NOT_MOVABLE',
            line.state === 'PENDING_APPROVAL'
              ? `${line.name} is waiting for approval. Approve it first.`
              : `${line.name} is no longer on the order.`,
          );
        }
        if (line._count.invoiceLines > 0) {
          throw new AppError(409, 'ITEM_NOT_MOVABLE', `${line.name} is on a printed bill.`);
        }
        if (line._count.discounts > 0) {
          throw new AppError(
            409,
            'ITEMS_DISCOUNTED',
            `${line.name} has a discount. Take it back first, then move it.`,
          );
        }
      }
      const parts = await tx.orderItem.findMany({
        where: { parentOrderItemId: { in: wanted } },
        select: { id: true },
      });
      const moving = new Set([...wanted, ...parts.map((part) => part.id)]);

      // An order whose every dish moves goes over whole, tickets and all; one that keeps some
      // dishes gives the moved ones to a new order at the other table, by the same person.
      const orderIds = [...new Set(lines.map((line) => line.orderId))];
      const sources = await tx.order.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true,
          source: true,
          createdById: true,
          deviceId: true,
          items: { select: { id: true } },
        },
        orderBy: { orderNumber: 'asc' },
      });
      const businessDate = await currentBusinessDate(tx, principal.restaurantId);
      const landed: string[] = [];
      for (const order of sources) {
        const ids = order.items.map((item) => item.id).filter((id) => moving.has(id));
        if (ids.length === order.items.length) {
          await tx.order.update({
            where: { id: order.id },
            data: { tableSessionId: to.id, tableId: to.tableId },
          });
          landed.push(order.id);
          continue;
        }
        const created = await tx.order.create({
          data: {
            id: newId(),
            restaurantId: principal.restaurantId,
            businessDate: dbDate(businessDate),
            orderNumber: await allocateDailyNumber(tx, {
              restaurantId: principal.restaurantId,
              businessDate,
              kind: 'ORDER',
            }),
            orderType: 'DINE_IN',
            source: order.source,
            tableSessionId: to.id,
            tableId: to.tableId,
            createdById: order.createdById,
            deviceId: order.deviceId,
            notes: `Moved from ${from.table.label}`,
          },
        });
        await tx.orderItem.updateMany({
          where: { id: { in: ids } },
          data: { orderId: created.id },
        });
        landed.push(created.id);
      }

      const moved = lines.map((line) => `${String(line.quantity)} × ${line.name}`);
      const stationIds = await this.notePrinters(tx, principal.restaurantId, from, {
        title: 'MOVED',
        lines: [`${from.table.label} to ${to.table.label}`, ...moved],
        orderItemWhere: { id: { in: [...moving] } },
      });
      await this.sessions.record(tx, principal, 'ITEMS_TRANSFERRED', from.id, {
        before: { tableId: from.tableId, tableLabel: from.table.label, orderItemIds: wanted },
        after: {
          toSessionId: to.id,
          tableId: to.tableId,
          tableLabel: to.table.label,
          orderIds: landed,
          items: moved,
        },
        reason: request.reason ?? null,
      });
      await this.sessions.emit(
        tx,
        principal.restaurantId,
        isoDateOf(from.businessDate),
        from.id,
        [
          {
            type: 'OrdersMoved',
            payload: {
              kind: 'TRANSFER',
              fromTableSessionId: from.id,
              toTableSessionId: to.id,
              fromTableId: from.tableId,
              toTableId: to.tableId,
              orderIds: landed,
            },
          },
        ],
        { stationIds },
      );
      return {
        from: await this.sessions.view(tx, from),
        to: await this.sessions.view(tx, to),
        orderItemIds: [...moving],
      };
    });
  }

  /** Both open sessions with their tables locked, in a fixed order (no deadlock). */
  private async lockBoth(
    tx: TransactionClient,
    principal: Principal,
    firstId: string,
    secondId: string,
    ownOnly: boolean,
  ): Promise<[SessionRow, SessionRow]> {
    const found = await tx.tableSession.findMany({
      where: { id: { in: [firstId, secondId] }, restaurantId: principal.restaurantId },
      select: { id: true, tableId: true, status: true },
    });
    if (found.length !== 2 || found.some((session) => session.status !== 'OPEN')) {
      throw sessionNotFound();
    }
    for (const tableId of found.map((session) => session.tableId).sort()) {
      await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${tableId}::uuid FOR UPDATE`;
    }
    const first = await this.sessions.lockSession(tx, principal.restaurantId, firstId);
    const second = await this.sessions.lockSession(tx, principal.restaurantId, secondId);
    // Waiters hold TABLE_MOVE_MERGE for their own tables only: both must be theirs.
    if (
      ownOnly &&
      (first.waiterId !== principal.staffId || second.waiterId !== principal.staffId)
    ) {
      throw authErrors.forbidden();
    }
    return [first, second];
  }

  /**
   * Printing stations still cooking the dishes get a note (screens show the change on the
   * ticket): the tickets on paper stay valid, nothing is printed again as a ticket. Returns every
   * station with a ticket for the dishes, so their screens hear the change.
   */
  private async notePrinters(
    tx: TransactionClient,
    restaurantId: string,
    from: SessionRow,
    note: {
      readonly title: string;
      readonly lines: readonly string[];
      readonly orderItemWhere: { order: { id: { in: string[] } } } | { id: { in: string[] } };
    },
  ): Promise<string[]> {
    const kotLines = await tx.kotLine.findMany({
      where: { orderItem: note.orderItemWhere },
      select: {
        kot: { select: { stationId: true, station: { select: { mode: true } } } },
        orderItem: { select: { state: true } },
      },
    });
    const stationIds = [...new Set(kotLines.map((line) => line.kot.stationId))];
    const printing = new Set(
      kotLines
        .filter(
          (line) => line.kot.station.mode !== 'SCREEN' && isKitchenActive(line.orderItem.state),
        )
        .map((line) => line.kot.stationId),
    );
    for (const stationId of printing) {
      await tx.printNotice.create({
        data: {
          restaurantId,
          businessDate: from.businessDate,
          stationId,
          title: note.title,
          lines: [...note.lines],
        },
      });
    }
    return stationIds;
  }
}
