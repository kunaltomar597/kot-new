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
import type { Actor, ConsumedOverride, Principal } from '../auth/principal.js';
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

/** How far along the kitchen and the floor an item is; ended items have no place. */
const PROGRESS: Partial<Record<OrderItemState, number>> = {
  SENT: 0,
  PREPARING: 1,
  READY: 2,
  PICKED_UP: 3,
  SERVED: 4,
};
const PROGRESS_STATES = ['SENT', 'PREPARING', 'READY', 'PICKED_UP', 'SERVED'] as const;

/** The step that brings an item to each state (ADR-0006 shortcuts included). */
const STEP_TO: Readonly<
  Record<Exclude<(typeof PROGRESS_STATES)[number], 'SENT'>, OrderItemStatusRequest['event']>
> = {
  PREPARING: 'START_PREPARING',
  READY: 'MARK_READY',
  PICKED_UP: 'PICK_UP',
  SERVED: 'SERVE',
};

/** An item ended by a cancel or a void, and how (a voided combo cancels its unstarted parts). */
interface Ended {
  readonly target: OrderItem;
  readonly event: 'CANCEL' | 'VOID';
}

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

  /**
   * A kitchen or floor step. A kitchen screen in station mode acts with the kitchen's grants and
   * only on its own station's items; its steps are attributed to the device (AUTH-005).
   *
   * A combo line and its parts move together both ways: a step on the line moves every part that
   * can take it, and a step on a part (the kitchen works on parts) brings the line along, so the
   * floor can serve, cancel or void the combo as one line (ORD-011).
   */
  async setStatus(
    principal: Actor,
    orderItemId: string,
    event: OrderItemStatusRequest['event'],
  ): Promise<OrderView> {
    if (grantFor(principal.role, STEP_CAPABILITY[event]) !== 'ALLOW') throw authErrors.forbidden();
    const orderId = await this.prisma.transaction(async (tx) => {
      // The combo line is locked before its part, in the order cancel and void lock them.
      const found = await tx.orderItem.findFirst({
        where: { id: orderItemId, restaurantId: principal.restaurantId },
        select: { parentOrderItemId: true },
      });
      const parentId = found?.parentOrderItemId ?? null;
      if (parentId !== null) await this.lockRow(tx, parentId);
      const item = await this.lock(tx, principal.restaurantId, orderItemId);
      const station = principal.stationId ?? null;
      if (station !== null && item.stationId !== station) {
        throw authErrors.forbidden();
      }
      const now = new Date();
      await this.step(tx, principal, item.order, item, event, now);
      // Parts follow their combo where they can; the line itself must be able to move.
      for (const part of item.components) {
        if (canTransition(orderItemMachine, part.state, event)) {
          await this.step(tx, principal, item.order, part, event, now);
        }
      }
      if (item.parentOrderItemId !== null) {
        await this.follow(tx, principal, item.order, item.parentOrderItemId, now);
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
      const ended = await this.end(tx, principal, item, 'CANCEL', reason);
      // Nothing was cooked: counted stock goes back (MENU-006).
      await this.restoreUncooked(tx, principal, item, ended);
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
      const ended = await this.end(tx, principal, item, 'VOID', reason);
      // Parts of a voided combo the kitchen had not started were not cooked either.
      await this.restoreUncooked(tx, principal, item, ended);
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
   * a CANCELLED slip (ORD-012). A voided combo's parts the kitchen has not started are cancelled
   * with it, so none is left on a kitchen screen. Returns what ended, and how.
   */
  private async end(
    tx: TransactionClient,
    principal: Principal,
    item: ItemWithOrder,
    event: 'CANCEL' | 'VOID',
    reason: string,
  ): Promise<Ended[]> {
    transition(orderItemMachine, item.state, event);
    const ended: Ended[] = [{ target: item, event }];
    for (const part of item.components) {
      if (canTransition(orderItemMachine, part.state, event)) ended.push({ target: part, event });
      else if (event === 'VOID' && canTransition(orderItemMachine, part.state, 'CANCEL')) {
        ended.push({ target: part, event: 'CANCEL' });
      }
    }
    const now = new Date();
    const slips: { stationId: string; orderItemId: string; quantity: number }[] = [];
    for (const { target, event: how } of ended) {
      const to = transition(orderItemMachine, target.state, how).to;
      await tx.orderItem.update({
        where: { id: target.id },
        data: { state: to, endedAt: now, endReason: reason },
      });
      await this.changed(tx, principal, item.order, target, to, how, reason);
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
    return ended;
  }

  /**
   * Counted stock goes back for what ended before the kitchen started it (MENU-006): a cancelled
   * dish, or the parts of a combo (the combo line itself holds no stock).
   */
  private async restoreUncooked(
    tx: TransactionClient,
    principal: Principal,
    item: ItemWithOrder,
    ended: readonly Ended[],
  ): Promise<void> {
    for (const { target, event } of ended) {
      if (event !== 'CANCEL') continue;
      if (target === item && item.components.length > 0) continue;
      await this.menu.restoreStock(tx, principal.restaurantId, target.itemId, target.quantity);
    }
  }

  /** Moves one item by a kitchen or floor step, with its times and events. */
  private async step(
    tx: TransactionClient,
    principal: Actor,
    order: ItemWithOrder['order'],
    target: OrderItem,
    event: OrderItemEvent,
    now: Date,
  ): Promise<OrderItem> {
    const to = transition(orderItemMachine, target.state, event).to;
    const moved = await tx.orderItem.update({
      where: { id: target.id },
      data: { state: to, ...stepTimes(event, target, now) },
    });
    await this.changed(tx, principal, order, target, to, event);
    return moved;
  }

  /**
   * Brings a combo line to where its parts are: in preparation once the kitchen starts any part,
   * then as far along as its least advanced part (ready when every part is ready, and so on).
   * It only moves forward, and never out of an ended or awaiting-approval state.
   */
  private async follow(
    tx: TransactionClient,
    principal: Actor,
    order: ItemWithOrder['order'],
    parentId: string,
    now: Date,
  ): Promise<void> {
    const parent = await tx.orderItem.findUniqueOrThrow({
      where: { id: parentId },
      include: { components: true },
    });
    const places = parent.components
      .map((part) => PROGRESS[part.state])
      .filter((place) => place !== undefined);
    if (PROGRESS[parent.state] === undefined || places.length === 0) return;
    const started = Math.max(...places) > 0 ? 1 : 0;
    const target = PROGRESS_STATES[Math.max(Math.min(...places), started)] ?? 'SENT';
    let line: OrderItem = parent;
    while (target !== 'SENT' && (PROGRESS[line.state] ?? 0) < (PROGRESS[target] ?? 0)) {
      // Picked up and served come after ready: a line not yet ready becomes ready first.
      const direct = STEP_TO[target];
      const event = canTransition(orderItemMachine, line.state, direct) ? direct : 'MARK_READY';
      line = await this.step(tx, principal, order, line, event, now);
    }
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
    principal: Actor,
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
          ...(principal.staffId !== null && { actorId: principal.staffId }),
          deviceId: principal.deviceId,
        },
      },
      audience,
    );
  }

  private async orderEvent(
    tx: TransactionClient,
    principal: Actor,
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

  private async lockRow(tx: TransactionClient, orderItemId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 AS locked FROM order_items WHERE id = ${orderItemId}::uuid FOR UPDATE`;
  }

  /** Locks the item row and loads it with its order and combo parts. */
  private async lock(
    tx: TransactionClient,
    restaurantId: string,
    orderItemId: string,
  ): Promise<ItemWithOrder> {
    await this.lockRow(tx, orderItemId);
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
