import { Injectable } from '@nestjs/common';
import type {
  DomainEvent,
  ModifyOrderItemRequest,
  OrderItemStatusRequest,
  OrderView,
} from '@rp/contracts';
import {
  canTransition,
  type Capability,
  grantFor,
  type OrderItemEvent,
  type OrderItemState,
  orderItemMachine,
  transition,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import type { ConsumedOverride, Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { allocateDailyNumber } from '../database/numbering.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent, type EventAudience } from '../events/outbox.js';
import type { OrderItem, Prisma } from '../generated/prisma/client.js';
import { MenuPublishService } from '../menu/menu-publish.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { OrdersService } from './orders.service.js';

/** The grant each floor or kitchen step needs (BRD §4.2). */
const STEP_CAPABILITY: Readonly<Record<OrderItemStatusRequest['event'], Capability>> = {
  START_PREPARING: 'ITEM_MARK_PREPARING_READY',
  MARK_READY: 'ITEM_MARK_PREPARING_READY',
  PICK_UP: 'ITEM_MARK_PICKED_UP',
  SERVE: 'ITEM_MARK_SERVED',
};

/** States in which a station still has the item on its screen or rail. */
const AT_STATION: ReadonlySet<OrderItemState> = new Set(['SENT', 'PREPARING', 'READY']);

type ItemWithOrder = OrderItem & {
  order: {
    id: string;
    tableId: string | null;
    createdById: string | null;
    tableSession: { waiterId: string | null } | null;
  };
  components: OrderItem[];
};

/** Timestamps a step sets, including those it implies (ADR-0006 shortcuts). */
function stepTimes(event: OrderItemEvent, item: OrderItem, now: Date) {
  switch (event) {
    case 'START_PREPARING':
      return { preparingAt: now };
    case 'MARK_READY':
      return { readyAt: now, preparingAt: item.preparingAt ?? now };
    case 'PICK_UP':
      return { pickedUpAt: now };
    case 'SERVE':
      return { servedAt: now, pickedUpAt: item.pickedUpAt ?? now };
    default:
      return {};
  }
}

/**
 * The order engine, item side (P1-06b, ORD-010 to ORD-012). Every change follows `@rp/domain`
 * `orderItemMachine` under a row lock, records an `order_events` row and `ItemStatusChanged`, and
 * nothing reaches or leaves the kitchen silently: cancellations and voids of items a station
 * holds print a CANCELLED slip, and changes a MODIFIED ticket. A combo line carries its parts.
 */
@Injectable()
export class OrderItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly menu: MenuPublishService,
    private readonly settings: SettingsService,
    private readonly orders: OrdersService,
  ) {}

  async setStatus(
    principal: Principal,
    orderItemId: string,
    event: OrderItemStatusRequest['event'],
  ): Promise<OrderView> {
    if (grantFor(principal.role, STEP_CAPABILITY[event]) !== 'ALLOW') throw authErrors.forbidden();
    const orderId = await this.prisma.transaction(async (tx) => {
      const item = await this.lock(tx, principal.restaurantId, orderItemId);
      const now = new Date();
      for (const target of [item, ...item.components]) {
        // Parts follow their combo where they can; the line itself must be able to move.
        if (target !== item && target.state !== item.state) continue;
        const to = transition(orderItemMachine, target.state, event).to;
        await tx.orderItem.update({
          where: { id: target.id },
          data: { state: to, ...stepTimes(event, target, now) },
        });
        await this.changed(tx, principal, item.order, target, to, event);
      }
      return item.orderId;
    });
    return this.orders.get(principal.restaurantId, orderId);
  }

  async cancel(
    principal: Principal,
    orderItemId: string,
    reason: string,
    ownOnly: boolean,
  ): Promise<OrderView> {
    const orderId = await this.prisma.transaction(async (tx) => {
      const item = await this.lock(tx, principal.restaurantId, orderItemId);
      this.assertLine(item);
      if (ownOnly) this.assertOwn(principal, item);
      const ended = await this.end(tx, principal, item, 'CANCEL', 'CANCELLED', reason);
      // Nothing was cooked: counted stock goes back (MENU-006).
      for (const target of ended) {
        if (target.parentOrderItemId === null && item.components.length > 0) continue;
        await this.menu.restoreStock(tx, principal.restaurantId, target.itemId, target.quantity);
      }
      await this.audit.record(tx, {
        action: 'ORDER_ITEM_CANCELLED',
        entityType: 'order_item',
        entityId: item.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { state: item.state, quantity: item.quantity, lineTotal: item.lineTotal },
        after: { state: 'CANCELLED' },
        reason,
      });
      return item.orderId;
    });
    return this.orders.get(principal.restaurantId, orderId);
  }

  async void(
    principal: Principal,
    orderItemId: string,
    reason: string,
    override: ConsumedOverride | undefined,
  ): Promise<OrderView> {
    const orderId = await this.prisma.transaction(async (tx) => {
      const item = await this.lock(tx, principal.restaurantId, orderItemId);
      this.assertLine(item);
      if (item.state === 'SENT') {
        throw new AppError(
          409,
          'ITEM_NOT_STARTED',
          'The kitchen has not started this item. Cancel it instead.',
        );
      }
      await this.end(tx, principal, item, 'VOID', 'VOIDED', reason);
      await this.audit.record(tx, {
        action: 'ORDER_ITEM_VOIDED',
        entityType: 'order_item',
        entityId: item.id,
        actorId: principal.staffId,
        approverId: override?.approverId ?? null,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { state: item.state, quantity: item.quantity, lineTotal: item.lineTotal },
        after: { state: 'VOIDED' },
        reason,
      });
      return item.orderId;
    });
    return this.orders.get(principal.restaurantId, orderId);
  }

  async modify(
    principal: Principal,
    orderItemId: string,
    change: ModifyOrderItemRequest,
  ): Promise<OrderView> {
    const settings = await this.settings.snapshot(principal.restaurantId);
    const maxLength = settings.get('orders.specialInstructionsMaxLength');
    if ((change.instructions?.length ?? 0) > maxLength) {
      throw new AppError(
        422,
        'INSTRUCTIONS_TOO_LONG',
        `Instructions are limited to ${String(maxLength)} characters.`,
      );
    }
    const orderId = await this.prisma.transaction(async (tx) => {
      const item = await this.lock(tx, principal.restaurantId, orderItemId);
      this.assertLine(item);
      if (item.components.length > 0) {
        throw new AppError(
          409,
          'COMBO_NOT_MODIFIABLE',
          'A combo cannot be changed. Cancel it and order it again.',
        );
      }
      if (item.state !== 'SENT' && item.state !== 'PENDING_APPROVAL') {
        throw new AppError(
          409,
          'ITEM_ALREADY_STARTED',
          'The kitchen has started this item, so it cannot be changed.',
        );
      }
      const quantity = change.quantity ?? item.quantity;
      const instructions =
        change.instructions === undefined ? item.instructions : change.instructions;
      if (quantity === item.quantity && instructions === item.instructions) return item.orderId;

      // Stock follows the quantity for items already sent (staff orders, approved ones).
      const delta = quantity - item.quantity;
      if (item.state === 'SENT' && delta > 0) {
        const stock = await this.menu.lockAvailability(tx, principal.restaurantId, item.itemId);
        if (!stock.available || (stock.stockCount !== null && stock.stockCount < delta)) {
          throw new AppError(409, 'OUT_OF_STOCK', `${item.name} is out of stock.`);
        }
        await this.menu.decrementStock(tx, principal.restaurantId, item.itemId, delta);
      } else if (item.state === 'SENT' && delta < 0) {
        await this.menu.restoreStock(tx, principal.restaurantId, item.itemId, -delta);
      }
      await tx.orderItem.update({
        where: { id: item.id },
        data: { quantity, instructions, lineTotal: item.unitPrice * quantity },
      });
      if (item.state === 'SENT') {
        await this.slip(tx, principal, item.orderId, 'MODIFIED', [
          { stationId: item.stationId, orderItemId: item.id, quantity },
        ]);
      }
      await this.orderEvent(tx, principal, item, 'MODIFIED', item.state, item.state, {
        quantity: { from: item.quantity, to: quantity },
        instructions: { from: item.instructions, to: instructions },
      });
      await this.audit.record(tx, {
        action: 'ORDER_ITEM_MODIFIED',
        entityType: 'order_item',
        entityId: item.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: {
          quantity: item.quantity,
          instructions: item.instructions,
          lineTotal: item.lineTotal,
        },
        after: { quantity, instructions, lineTotal: item.unitPrice * quantity },
      });
      return item.orderId;
    });
    return this.orders.get(principal.restaurantId, orderId);
  }

  /**
   * Ends a line and its parts (cancel or void), and hands each station still holding one of them
   * a CANCELLED slip (ORD-012). Returns what ended.
   */
  private async end(
    tx: TransactionClient,
    principal: Principal,
    item: ItemWithOrder,
    event: 'CANCEL' | 'VOID',
    to: 'CANCELLED' | 'VOIDED',
    reason: string,
  ): Promise<OrderItem[]> {
    transition(orderItemMachine, item.state, event);
    const targets = [item, ...item.components].filter(
      (target) => target === item || canTransition(orderItemMachine, target.state, event),
    );
    const now = new Date();
    const slips: { stationId: string; orderItemId: string; quantity: number }[] = [];
    for (const target of targets) {
      await tx.orderItem.update({
        where: { id: target.id },
        data: { state: to, endedAt: now, endReason: reason },
      });
      await this.changed(tx, principal, item.order, target, to, event, reason);
      const cooking = item.components.length === 0 || target !== item;
      if (cooking && AT_STATION.has(target.state)) {
        slips.push({
          stationId: target.stationId,
          orderItemId: target.id,
          quantity: target.quantity,
        });
      }
    }
    if (slips.length > 0) await this.slip(tx, principal, item.orderId, 'CANCELLED', slips);
    return targets;
  }

  /** A MODIFIED or CANCELLED ticket per station, numbered with the day's KOTs (ORD-008). */
  private async slip(
    tx: TransactionClient,
    principal: Principal,
    orderId: string,
    kind: 'MODIFIED' | 'CANCELLED',
    lines: readonly { stationId: string; orderItemId: string; quantity: number }[],
  ): Promise<void> {
    const { restaurantId } = principal;
    const businessDate = await currentBusinessDate(tx, restaurantId);
    const byStation = new Map<string, typeof lines>();
    for (const line of lines)
      byStation.set(line.stationId, [...(byStation.get(line.stationId) ?? []), line]);
    for (const [stationId, stationLines] of byStation) {
      const station = await tx.station.findUniqueOrThrow({
        where: { id: stationId },
        select: { mode: true },
      });
      const kotNumber = await allocateDailyNumber(tx, { restaurantId, businessDate, kind: 'KOT' });
      const kot = await tx.kot.create({
        data: {
          id: newId(),
          restaurantId,
          businessDate: dbDate(businessDate),
          kotNumber,
          orderId,
          stationId,
          kind,
          printStatus: station.mode === 'SCREEN' ? 'NOT_REQUIRED' : 'PENDING',
          lines: {
            create: stationLines.map((line) => ({
              restaurantId,
              orderItemId: line.orderItemId,
              quantity: line.quantity,
            })),
          },
        },
      });
      await this.emit(tx, restaurantId, businessDate, 'kot', kot.id, {
        type: 'KotCreated',
        payload: { kotId: kot.id, kotNumber, stationId, orderId, kind },
      });
    }
  }

  private async changed(
    tx: TransactionClient,
    principal: Principal,
    order: ItemWithOrder['order'],
    item: OrderItem,
    to: OrderItemState,
    event: OrderItemEvent,
    reason?: string,
  ): Promise<void> {
    await this.orderEvent(
      tx,
      principal,
      item,
      event,
      item.state,
      to,
      reason === undefined ? {} : { reason },
    );
    const businessDate = await currentBusinessDate(tx, principal.restaurantId);
    const audience: EventAudience = {
      stationIds: [item.stationId],
      ...(order.tableId !== null && { tableIds: [order.tableId] }),
    };
    await this.emit(
      tx,
      principal.restaurantId,
      businessDate,
      'order_item',
      item.id,
      {
        type: 'ItemStatusChanged',
        payload: {
          orderId: item.orderId,
          orderItemId: item.id,
          from: item.state,
          to,
          actorId: principal.staffId,
          deviceId: principal.deviceId,
        },
      },
      audience,
    );
  }

  private async orderEvent(
    tx: TransactionClient,
    principal: Principal,
    item: OrderItem,
    type: string,
    from: OrderItemState,
    to: OrderItemState,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.orderEvent.create({
      data: {
        restaurantId: principal.restaurantId,
        orderId: item.orderId,
        orderItemId: item.id,
        businessDate: item.businessDate,
        type,
        fromState: from,
        toState: to,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        payload: payload as Prisma.InputJsonObject,
      },
    });
  }

  /** Locks the item row and loads it with its order and combo parts. */
  private async lock(
    tx: TransactionClient,
    restaurantId: string,
    orderItemId: string,
  ): Promise<ItemWithOrder> {
    await tx.$queryRaw`SELECT 1 AS locked FROM order_items WHERE id = ${orderItemId}::uuid FOR UPDATE`;
    const item = await tx.orderItem.findFirst({
      where: { id: orderItemId, restaurantId },
      include: {
        order: {
          select: {
            id: true,
            tableId: true,
            createdById: true,
            tableSession: { select: { waiterId: true } },
          },
        },
        components: { orderBy: { id: 'asc' } },
      },
    });
    if (item === null) {
      throw new AppError(404, 'ORDER_ITEM_NOT_FOUND', 'There is no such order item.');
    }
    return item;
  }

  /** Cancels, voids and changes apply to order lines; a combo's parts follow their combo. */
  private assertLine(item: ItemWithOrder): void {
    if (item.parentOrderItemId !== null) {
      throw new AppError(
        409,
        'COMBO_PART',
        'This is part of a combo. Cancel, void or change the combo itself.',
      );
    }
  }

  /** Waiters hold some grants for their own tables only (OWN, BRD §4.2). */
  private assertOwn(principal: Principal, item: ItemWithOrder): void {
    const owner = item.order.tableSession?.waiterId ?? item.order.createdById;
    if (owner !== principal.staffId) throw authErrors.forbidden();
  }

  private async emit(
    tx: TransactionClient,
    restaurantId: string,
    businessDate: string,
    aggregateType: string,
    aggregateId: string,
    event: Pick<DomainEvent, 'type' | 'payload'>,
    audience?: EventAudience,
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
        aggregate: { type: aggregateType, id: aggregateId },
        ...(audience !== undefined && { audience }),
      },
    );
  }
}
