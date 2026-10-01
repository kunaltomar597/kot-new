import { Injectable } from '@nestjs/common';
import type {
  ApprovalChange,
  DomainEvent,
  OrderView,
  PendingApprovalsResponse,
  RejectOrderRequest,
  SubmitOrderResponse,
  TabletOrderRequest,
  TabletOrdersResponse,
} from '@rp/contracts';
import {
  type KotItemInput,
  type OrderItemState,
  orderItemMachine,
  tableMachine,
  transition,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import { AuthService } from '../auth/auth.service.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import { currentBusinessDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MenuPublishService } from '../menu/menu-publish.service.js';
import { ORDER_VIEW_INCLUDE, orderView, OrdersService } from './orders.service.js';

/** Who approves or rejects: a signed-in person, or a waiter's PIN on the tablet (ORD-004). */
export interface Approver {
  readonly restaurantId: string;
  readonly staffId: string;
  readonly deviceId: string | null;
  /** Waiters approve only their own tables' orders (ORDER_APPROVE_CUSTOMER: OWN). */
  readonly ownOnly: boolean;
}

type OrderRow = Prisma.OrderGetPayload<{
  include: typeof ORDER_VIEW_INCLUDE & {
    tableSession: { select: { id: true; status: true; waiterId: true; tableId: true } };
  };
}>;
type ItemRow = OrderRow['items'][number];

const WITH_SESSION = {
  ...ORDER_VIEW_INCLUDE,
  tableSession: { select: { id: true, status: true, waiterId: true, tableId: true } },
} as const satisfies Prisma.OrderInclude;

/** States on their way to the bill: what the running total counts (TAB-010). */
const BILLED: ReadonlySet<OrderItemState> = new Set([
  'SENT',
  'PREPARING',
  'READY',
  'PICKED_UP',
  'SERVED',
]);

const REMOVED_REASON = 'Removed with the diner’s agreement';

const errors = {
  notATablet: () =>
    new AppError(403, 'NOT_A_TABLE_TABLET', 'Only a table tablet bound to a table can do this.'),
  tableNotOpen: () =>
    new AppError(
      409,
      'TABLE_NOT_OPEN',
      'This table is not open yet. Please ask a waiter to seat you.',
    ),
  notFound: () => new AppError(404, 'ORDER_NOT_FOUND', 'There is no such order.'),
  notPending: () =>
    new AppError(409, 'ORDER_NOT_PENDING', 'Nothing in this order waits for approval.'),
  notALine: (orderItemId: string) =>
    new AppError(422, 'NOT_A_WAITING_LINE', 'That line is not waiting for approval.', {
      orderItemId,
    }),
  allRemoved: () =>
    new AppError(
      422,
      'NOTHING_TO_APPROVE',
      'Every line would be removed. Reject the order instead, with a reason.',
    ),
  outOfStock: (names: readonly string[]) =>
    new AppError(
      409,
      'OUT_OF_STOCK',
      `${names.join(', ')} ran out. Remove it with the diner, then approve.`,
      { items: names },
    ),
};

/**
 * Diners' orders and their approval (P3-03a, ORD-003 to ORD-005, TAB-008 to TAB-010, WTR-004).
 * A table tablet orders for its own open table; the order waits (PENDING_APPROVAL) and its
 * waiter is alerted. A waiter (own tables), the cashier or a manager approves it, changing
 * quantities or removing lines first with the diner's agreement, and it then goes to the kitchen
 * exactly as a staff order does (tickets, stock); or rejects it with a reason the diner sees. The
 * waiter can also approve on the tablet with their PIN ("Approve at table").
 */
@Injectable()
export class OrderApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly orders: OrdersService,
    private readonly menu: MenuPublishService,
  ) {}

  // ---------------------------------------------------------------- the tablet

  async submitFromTablet(
    device: AuthenticatedDevice,
    request: TabletOrderRequest,
  ): Promise<SubmitOrderResponse> {
    const session = await this.openSessionOf(device);
    if (session === null) throw errors.tableNotOpen();
    return this.orders.submit(
      { restaurantId: device.restaurantId, staffId: null, deviceId: device.deviceId },
      {
        idempotencyKey: request.idempotencyKey,
        source: 'TABLE_TABLET',
        orderType: 'DINE_IN',
        tableSessionId: session.id,
        lines: request.lines,
        ...(request.orderNote !== undefined && { orderNote: request.orderNote }),
      },
    );
  }

  async listForTablet(device: AuthenticatedDevice): Promise<TabletOrdersResponse> {
    const session = await this.openSessionOf(device);
    if (session === null) {
      return { tableSessionId: null, orders: [], runningTotal: 0, pendingTotal: 0 };
    }
    const { orders } = await this.orders.listForSession(device.restaurantId, session.id);
    let runningTotal = 0;
    let pendingTotal = 0;
    for (const order of orders) {
      for (const item of order.items) {
        if (item.parentOrderItemId !== null) continue;
        if (BILLED.has(item.state)) runningTotal += item.lineTotal;
        else if (item.state === 'PENDING_APPROVAL') pendingTotal += item.lineTotal;
      }
    }
    return { tableSessionId: session.id, orders, runningTotal, pendingTotal };
  }

  async approveAtTable(
    device: AuthenticatedDevice,
    orderId: string,
    request: { staffId: string; pin: string; changes: ApprovalChange[]; dinerAgreed: boolean },
  ): Promise<OrderView> {
    if (device.type !== 'TABLE_TABLET' || device.tableId === null) throw errors.notATablet();
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId: device.restaurantId },
      select: { tableId: true },
    });
    if (order?.tableId !== device.tableId) throw errors.notFound();
    const { staff, ownOnly } = await this.auth.tableApprover(device, request.staffId, request.pin);
    return this.approve(
      { restaurantId: device.restaurantId, staffId: staff.id, deviceId: device.deviceId, ownOnly },
      orderId,
      request.changes,
    );
  }

  // ---------------------------------------------------------------- staff

  async pending(approver: Approver): Promise<PendingApprovalsResponse> {
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId: approver.restaurantId,
        items: { some: { state: 'PENDING_APPROVAL' } },
        ...(approver.ownOnly && { tableSession: { waiterId: approver.staffId } }),
      },
      include: { ...WITH_SESSION, table: { select: { label: true } } },
      orderBy: [{ createdAt: 'asc' }, { orderNumber: 'asc' }],
    });
    return {
      orders: orders.map((order) => ({
        order: orderView(order),
        tableLabel: order.table?.label ?? null,
        waiterId: order.tableSession?.waiterId ?? null,
      })),
    };
  }

  /** Sends the waiting lines to the kitchen, after the changes agreed with the diner. */
  async approve(
    approver: Approver,
    orderId: string,
    changes: readonly ApprovalChange[],
  ): Promise<OrderView> {
    const menu = await this.menu.current(approver.restaurantId);
    const now = new Date();
    await this.prisma.transaction(async (tx) => {
      const order = await this.lock(tx, approver, orderId);
      const waiting = this.waitingLines(order);
      const businessDate = await currentBusinessDate(tx, approver.restaurantId, now);
      const removed = await this.applyChanges(tx, approver, order, waiting, changes, now);
      const approved = waiting.filter((line) => !removed.has(line.id));
      if (approved.length === 0) throw errors.allRemoved();
      const quantities = new Map(
        changes.filter((change) => change.quantity > 0).map((c) => [c.orderItemId, c.quantity]),
      );
      const lines = approved.map((line) => this.withQuantity(order, line, quantities));
      await this.checkStock(tx, approver.restaurantId, lines);

      const inputs: KotItemInput[] = [];
      const partIds = new Map<string, string>();
      for (const { line, quantity, parts } of lines) {
        for (const target of [line, ...parts.map((part) => part.row)]) {
          const to = transition(orderItemMachine, target.state, 'APPROVE').to;
          await tx.orderItem.update({
            where: { id: target.id },
            data: { state: to, sentAt: now, approvedById: approver.staffId },
          });
          await this.emit(tx, approver.restaurantId, businessDate, order, {
            type: 'ItemStatusChanged',
            payload: {
              orderId: order.id,
              orderItemId: target.id,
              from: target.state,
              to,
              actorId: approver.staffId,
              ...(approver.deviceId !== null && { deviceId: approver.deviceId }),
            },
          });
        }
        for (const part of parts) partIds.set(`${line.id}:${part.row.itemId}`, part.row.id);
        inputs.push({
          orderItemId: line.id,
          itemId: line.itemId,
          name: line.name,
          quantity,
          stationId: line.stationId,
          ...(line.variantName !== null && { variantName: line.variantName }),
          modifiers: line.modifiers.map((modifier) => modifier.name),
          ...(line.instructions !== null && { instructions: line.instructions }),
          comboComponents: parts.map((part) => ({
            itemId: part.row.itemId,
            name: part.row.name,
            quantity: part.perUnit,
            stationId: part.row.stationId,
          })),
        });
      }
      await this.orders.sendToKitchen(
        tx,
        approver.restaurantId,
        businessDate,
        order.id,
        inputs,
        partIds,
        menu,
      );
      for (const { line, quantity, parts } of lines) {
        if (parts.length === 0) {
          await this.menu.decrementStock(tx, approver.restaurantId, line.itemId, quantity);
        }
        for (const part of parts) {
          await this.menu.decrementStock(
            tx,
            approver.restaurantId,
            part.row.itemId,
            part.perUnit * quantity,
          );
        }
      }
      await this.addToBill(tx, approver.restaurantId, businessDate, order);
      await tx.orderEvent.create({
        data: {
          restaurantId: approver.restaurantId,
          orderId: order.id,
          businessDate: order.businessDate,
          type: 'APPROVED',
          toState: 'SENT',
          actorId: approver.staffId,
          deviceId: approver.deviceId,
          payload: { lines: lines.length, changes: changes.length },
        },
      });
      await this.audit.record(tx, {
        action: 'ORDER_APPROVED',
        entityType: 'order',
        entityId: order.id,
        actorId: approver.staffId,
        deviceId: approver.deviceId,
        restaurantId: approver.restaurantId,
        before: { lines: waiting.map((line) => ({ id: line.id, quantity: line.quantity })) },
        after: {
          orderNumber: order.orderNumber,
          lines: lines.map(({ line, quantity }) => ({ id: line.id, quantity })),
          changes,
        },
        reason: changes.length === 0 ? null : REMOVED_REASON,
      });
      await this.emit(tx, approver.restaurantId, businessDate, order, {
        type: 'OrderApproved',
        payload: { orderId: order.id, approvedBy: approver.staffId },
      });
    });
    return this.orders.get(approver.restaurantId, orderId);
  }

  /** Refuses every waiting line, with the reason the diner sees (ORD-003). */
  async reject(
    approver: Approver,
    orderId: string,
    request: RejectOrderRequest,
  ): Promise<OrderView> {
    const now = new Date();
    await this.prisma.transaction(async (tx) => {
      const order = await this.lock(tx, approver, orderId);
      const waiting = this.waitingLines(order);
      const businessDate = await currentBusinessDate(tx, approver.restaurantId, now);
      for (const line of waiting) {
        await this.end(tx, approver, order, line, request.reason, now, businessDate);
      }
      await this.closeIfEnded(tx, order.id);
      await tx.orderEvent.create({
        data: {
          restaurantId: approver.restaurantId,
          orderId: order.id,
          businessDate: order.businessDate,
          type: 'REJECTED',
          toState: 'REJECTED',
          actorId: approver.staffId,
          deviceId: approver.deviceId,
          payload: { lines: waiting.length },
        },
      });
      await this.audit.record(tx, {
        action: 'ORDER_REJECTED',
        entityType: 'order',
        entityId: order.id,
        actorId: approver.staffId,
        deviceId: approver.deviceId,
        restaurantId: approver.restaurantId,
        before: { lines: waiting.map((line) => ({ id: line.id, quantity: line.quantity })) },
        after: { orderNumber: order.orderNumber, state: 'REJECTED' },
        reason: request.reason,
      });
      await this.emit(tx, approver.restaurantId, businessDate, order, {
        type: 'OrderRejected',
        payload: { orderId: order.id, rejectedBy: approver.staffId, reason: request.reason },
      });
    });
    return this.orders.get(approver.restaurantId, orderId);
  }

  // ---------------------------------------------------------------- helpers

  /** The open session at a tablet's own table (AUTH-009). */
  private async openSessionOf(device: AuthenticatedDevice): Promise<{ id: string } | null> {
    if (device.type !== 'TABLE_TABLET' || device.tableId === null) throw errors.notATablet();
    return this.prisma.tableSession.findFirst({
      where: { restaurantId: device.restaurantId, tableId: device.tableId, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
      select: { id: true },
    });
  }

  /** The order, locked with its table; checked against the approver's own tables. */
  private async lock(
    tx: TransactionClient,
    approver: Approver,
    orderId: string,
  ): Promise<OrderRow> {
    const found = await tx.order.findFirst({
      where: { id: orderId, restaurantId: approver.restaurantId },
      select: { id: true, tableId: true },
    });
    if (found === null) throw errors.notFound();
    if (found.tableId !== null) {
      await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${found.tableId}::uuid FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT 1 AS locked FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: WITH_SESSION,
    });
    if (approver.ownOnly) {
      const owner = order.tableSession?.waiterId ?? order.createdById;
      if (owner !== approver.staffId) throw authErrors.forbidden();
    }
    if (order.tableSession !== null && order.tableSession.status !== 'OPEN') {
      throw new AppError(409, 'TABLE_SESSION_CLOSED', 'This table has been closed.');
    }
    return order;
  }

  /** The order's whole lines waiting for approval; none means nothing to do. */
  private waitingLines(order: OrderRow): ItemRow[] {
    const waiting = order.items.filter(
      (item) => item.state === 'PENDING_APPROVAL' && item.parentOrderItemId === null,
    );
    if (waiting.length === 0) throw errors.notPending();
    return waiting;
  }

  /** Quantities changed and lines removed (0) with the diner's agreement; returns the removed. */
  private async applyChanges(
    tx: TransactionClient,
    approver: Approver,
    order: OrderRow,
    waiting: readonly ItemRow[],
    changes: readonly ApprovalChange[],
    now: Date,
  ): Promise<Set<string>> {
    const removed = new Set<string>();
    const businessDate = isoDateOf(order.businessDate);
    for (const change of changes) {
      const line = waiting.find((candidate) => candidate.id === change.orderItemId);
      if (line === undefined) throw errors.notALine(change.orderItemId);
      if (change.quantity === 0) {
        await this.end(tx, approver, order, line, REMOVED_REASON, now, businessDate);
        removed.add(line.id);
        continue;
      }
      if (change.quantity === line.quantity) continue;
      await tx.orderItem.update({
        where: { id: line.id },
        data: { quantity: change.quantity, lineTotal: line.unitPrice * change.quantity },
      });
      for (const part of this.partsOf(order, line)) {
        await tx.orderItem.update({
          where: { id: part.id },
          data: { quantity: (part.quantity / line.quantity) * change.quantity },
        });
      }
    }
    return removed;
  }

  private partsOf(order: OrderRow, line: ItemRow): ItemRow[] {
    return order.items.filter((item) => item.parentOrderItemId === line.id);
  }

  /** A line with its approved quantity and its combo parts (units per combo). */
  private withQuantity(order: OrderRow, line: ItemRow, quantities: ReadonlyMap<string, number>) {
    const quantity = quantities.get(line.id) ?? line.quantity;
    const parts = this.partsOf(order, line).map((row) => ({
      row,
      perUnit: row.quantity / line.quantity,
    }));
    return { line, quantity, parts };
  }

  private async checkStock(
    tx: TransactionClient,
    restaurantId: string,
    lines: readonly ReturnType<OrderApprovalsService['withQuantity']>[],
  ): Promise<void> {
    const needs = new Map<string, { quantity: number; name: string }>();
    const add = (itemId: string, name: string, quantity: number) =>
      needs.set(itemId, { name, quantity: (needs.get(itemId)?.quantity ?? 0) + quantity });
    for (const { line, quantity, parts } of lines) {
      if (parts.length === 0) add(line.itemId, line.name, quantity);
      for (const part of parts) add(part.row.itemId, part.row.name, part.perUnit * quantity);
    }
    const short: string[] = [];
    for (const [itemId, need] of [...needs].sort(([a], [b]) => a.localeCompare(b))) {
      const stock = await this.menu.lockAvailability(tx, restaurantId, itemId);
      if (!stock.available || (stock.stockCount !== null && stock.stockCount < need.quantity)) {
        short.push(need.name);
      }
    }
    if (short.length > 0) throw errors.outOfStock(short);
  }

  /** A waiting line and its parts end as REJECTED with the reason the diner sees. */
  private async end(
    tx: TransactionClient,
    approver: Approver,
    order: OrderRow,
    line: ItemRow,
    reason: string,
    now: Date,
    businessDate: string,
  ): Promise<void> {
    for (const target of [line, ...this.partsOf(order, line)]) {
      const to = transition(orderItemMachine, target.state, 'REJECT').to;
      await tx.orderItem.update({
        where: { id: target.id },
        data: { state: to, endedAt: now, endReason: reason, approvedById: approver.staffId },
      });
      if (target === line) {
        await this.emit(tx, approver.restaurantId, businessDate, order, {
          type: 'ItemStatusChanged',
          payload: {
            orderId: order.id,
            orderItemId: target.id,
            from: target.state,
            to,
            actorId: approver.staffId,
            ...(approver.deviceId !== null && { deviceId: approver.deviceId }),
          },
        });
      }
    }
  }

  /** An order whose every line ended is cancelled. */
  private async closeIfEnded(tx: TransactionClient, orderId: string): Promise<void> {
    const live = await tx.orderItem.count({
      where: { orderId, state: { notIn: ['REJECTED', 'CANCELLED', 'VOIDED'] } },
    });
    if (live === 0)
      await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
  }

  /** Approved lines join the table's bill: a table waiting for its bill is OCCUPIED again. */
  private async addToBill(
    tx: TransactionClient,
    restaurantId: string,
    businessDate: string,
    order: OrderRow,
  ): Promise<void> {
    if (order.tableSession === null) return;
    const table = await tx.diningTable.findUniqueOrThrow({
      where: { id: order.tableSession.tableId },
    });
    if (table.state !== 'BILL_REQUESTED' && table.state !== 'BILL_PRINTED') return;
    const to = transition(tableMachine, table.state, 'ADD_ITEMS').to;
    await tx.diningTable.update({ where: { id: table.id }, data: { state: to } });
    await this.emit(tx, restaurantId, businessDate, order, {
      type: 'TableStateChanged',
      payload: { tableId: table.id, state: to },
    });
  }

  private async emit(
    tx: TransactionClient,
    restaurantId: string,
    businessDate: string,
    order: OrderRow,
    event: Pick<DomainEvent, 'type' | 'payload'>,
  ): Promise<void> {
    await appendEvent(
      tx,
      {
        eventId: newId(),
        version: 1,
        occurredAt: new Date().toISOString(),
        restaurantId,
        businessDate,
        ...event,
      } as DomainEvent,
      {
        aggregate: { type: 'order', id: order.id },
        ...(order.tableId !== null && { audience: { tableIds: [order.tableId] } }),
      },
    );
  }
}
