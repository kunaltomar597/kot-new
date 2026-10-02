import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  DomainEvent,
  MenuSnapshot,
  OrderListResponse,
  OrderView,
  RejectedLine,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from '@rp/contracts';
import {
  canonicalJson,
  initialOrderItemState,
  type OrderItemState,
  type OrderSource,
  splitIntoKots,
  tableMachine,
  transition,
  type KotItemInput,
} from '@rp/domain';
import {
  isRejectedLine,
  rejectLine,
  resolveOrderLine,
  type ResolvedOrderLine,
  type SalesChannel,
} from '@rp/ordering';
import { AuditService } from '../audit/audit.service.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { allocateDailyNumber } from '../database/numbering.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { appendEvent, type EventAudience } from '../events/outbox.js';
import { MenuPublishService } from '../menu/menu-publish.service.js';
import { SettingsService } from '../settings/settings.service.js';

type Accepted = Extract<SubmitOrderResponse, { status: 'ACCEPTED' }>;

/** What only a QR order carries (P5-03b). */
export interface SubmitOptions {
  /** The table, when it has no open session to name (QR-010). */
  readonly tableId?: string;
  /** The relay order this one came from (INT-005). */
  readonly externalRef?: string;
}

/** Who submits an order: a signed-in person on a device, or (later) a tablet or the QR relay. */
export interface OrderActor {
  readonly restaurantId: string;
  readonly staffId: string | null;
  readonly deviceId: string | null;
}

/** A priced, validated line, ready to be written. */
type ResolvedLine = ResolvedOrderLine;

const IDEMPOTENCY_SCOPE = 'orders.submit';
const IDEMPOTENCY_DAYS = 7;
const CHANNEL_OF: Readonly<Record<OrderSource, SalesChannel>> = {
  POS: 'POS',
  WAITER_APP: 'WAITER_APP',
  TABLE_TABLET: 'TABLE_TABLET',
  QR: 'QR',
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The order engine, submission side (P1-06a, ORD-001, ORD-006 to ORD-009, ORD-013, ORD-014,
 * ORD-017). Every line is priced from the published menu with `@rp/domain` `unitPriceOf`, never
 * from the client. Lines that cannot be served are all reported together and nothing is created.
 * A submission is idempotent: its key is locked for the transaction, and a repeat returns the
 * stored result with `replayed: true`, so retries never duplicate orders, tickets or stock
 * deductions. Staff orders go straight to the kitchen as per-station KOTs; customer orders wait
 * for approval (P3-03).
 */
export const ORDER_VIEW_INCLUDE = {
  items: { orderBy: { id: 'asc' }, include: { modifiers: { orderBy: { id: 'asc' } } } },
  kots: { orderBy: { kotNumber: 'asc' }, include: { station: { select: { name: true } } } },
} as const satisfies Prisma.OrderInclude;

export function orderView(
  order: Prisma.OrderGetPayload<{ include: typeof ORDER_VIEW_INCLUDE }>,
): OrderView {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    source: order.source,
    status: order.status,
    tableSessionId: order.tableSessionId,
    tableId: order.tableId,
    takeawayToken: order.takeawayToken,
    customerName: order.customerName,
    businessDate: isoDateOf(order.businessDate),
    createdAt: order.createdAt.toISOString(),
    note: order.notes,
    items: order.items.map((item) => ({
      id: item.id,
      itemId: item.itemId,
      parentOrderItemId: item.parentOrderItemId,
      name: item.name,
      variantId: item.variantId,
      variantName: item.variantName,
      modifiers: item.modifiers.map(({ modifierOptionId, name, priceDelta }) => ({
        optionId: modifierOptionId,
        name,
        priceDelta,
      })),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      stationId: item.stationId,
      state: item.state,
      instructions: item.instructions,
      endReason: item.endReason,
    })),
    kots: order.kots.map(({ id, kotNumber, stationId, station, kind, printStatus }) => ({
      id,
      kotNumber,
      stationId,
      stationName: station.name,
      kind,
      printStatus,
    })),
  };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly menu: MenuPublishService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * `options` are for orders from outside the restaurant's own screens: a QR order names its
   * table, which may not be open (QR-010), and the relay order it came from (INT-005).
   */
  async submit(
    actor: OrderActor,
    request: SubmitOrderRequest,
    options: SubmitOptions = {},
  ): Promise<SubmitOrderResponse> {
    const requestHash = sha256(canonicalJson(request));
    const [menu, settings, restaurant] = await Promise.all([
      this.menu.current(actor.restaurantId),
      this.settings.snapshot(actor.restaurantId),
      this.prisma.restaurant.findUniqueOrThrow({
        where: { id: actor.restaurantId },
        select: { timeZone: true },
      }),
    ]);
    const maxLength = settings.get('orders.specialInstructionsMaxLength');
    // ORD-016: staff may hold lines for later, where the restaurant allows it.
    if (request.lines.some((line) => line.hold === true)) {
      if (initialOrderItemState(request.source) !== 'SENT') {
        throw new AppError(422, 'HOLD_NOT_ALLOWED', 'Only staff orders can hold items.');
      }
      if (!settings.get('orders.holdAndFire')) {
        throw new AppError(422, 'HOLD_NOT_ALLOWED', 'Holding items is turned off here.');
      }
    }
    if ((request.orderNote?.length ?? 0) > maxLength) {
      throw new AppError(
        422,
        'NOTE_TOO_LONG',
        `Order notes are limited to ${String(maxLength)} characters.`,
      );
    }

    return this.prisma.transaction(async (tx) => {
      // Same key at once: the second waits here, then finds the first one's result.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${request.idempotencyKey}, 0))`;
      const previous = await tx.idempotencyRecord.findUnique({
        where: {
          restaurantId_scope_key: {
            restaurantId: actor.restaurantId,
            scope: IDEMPOTENCY_SCOPE,
            key: request.idempotencyKey,
          },
        },
      });
      if (previous !== null) {
        if (previous.requestHash !== requestHash) {
          throw new AppError(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'This idempotency key was used for a different order. Use a new key for a new order.',
          );
        }
        return { ...(previous.response as Accepted), replayed: true };
      }

      const now = new Date();
      const rejected: RejectedLine[] = [];
      const lines: ResolvedLine[] = [];
      for (const line of request.lines) {
        const resolved = resolveOrderLine(menu, line, {
          channel: CHANNEL_OF[request.source],
          instructionMaxLength: maxLength,
          now,
          timeZone: restaurant.timeZone,
        });
        if (isRejectedLine(resolved)) rejected.push(resolved);
        else lines.push(resolved);
      }
      const itemState = initialOrderItemState(request.source);
      const stockProblems = await this.checkStock(tx, actor.restaurantId, lines);
      for (const line of lines) {
        const ids = [line.item.id, ...line.components.map((component) => component.item.id)];
        if (ids.some((id) => stockProblems.has(id))) {
          rejected.push(
            rejectLine(line.request, 'OUT_OF_STOCK', `${line.item.name} is out of stock.`),
          );
        }
      }
      if (rejected.length > 0) return { status: 'PARTIALLY_REJECTED', rejectedLines: rejected };

      const businessDate = await currentBusinessDate(tx, actor.restaurantId, now);
      const table = await this.prepareTable(tx, actor.restaurantId, request, itemState, options);
      const response = await this.create(tx, actor, request, lines, {
        businessDate,
        itemState,
        menu,
        tableId: table?.tableId ?? null,
        externalRef: options.externalRef ?? null,
      });

      if (table?.newState !== undefined) {
        await this.emit(tx, actor.restaurantId, businessDate, 'table', table.tableId, {
          type: 'TableStateChanged',
          payload: { tableId: table.tableId, state: table.newState },
        });
      }
      await tx.idempotencyRecord.create({
        data: {
          restaurantId: actor.restaurantId,
          scope: IDEMPOTENCY_SCOPE,
          key: request.idempotencyKey,
          requestHash,
          statusCode: 200,
          response,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_DAYS * 86_400_000),
        },
      });
      return response;
    });
  }

  async get(restaurantId: string, orderId: string): Promise<OrderView> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId },
      include: ORDER_VIEW_INCLUDE,
    });
    if (order === null) throw new AppError(404, 'ORDER_NOT_FOUND', 'There is no such order.');
    return orderView(order);
  }

  /** The orders of a table session, oldest first, for the POS and the waiter app (TBL-007). */
  async listForSession(restaurantId: string, sessionId: string): Promise<OrderListResponse> {
    const session = await this.prisma.tableSession.findFirst({
      where: { id: sessionId, restaurantId },
      select: { id: true },
    });
    if (session === null) {
      throw new AppError(404, 'TABLE_SESSION_NOT_FOUND', 'There is no such table session.');
    }
    const orders = await this.prisma.order.findMany({
      where: { restaurantId, tableSessionId: sessionId },
      include: ORDER_VIEW_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { orderNumber: 'asc' }],
    });
    return { orders: orders.map(orderView) };
  }

  /** Today's open takeaway orders, oldest first, with their tokens (TBL-008). */
  async listOpenTakeaway(restaurantId: string): Promise<OrderListResponse> {
    const businessDate = await currentBusinessDate(this.prisma, restaurantId);
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId,
        orderType: 'TAKEAWAY',
        status: 'OPEN',
        businessDate: dbDate(businessDate),
      },
      include: ORDER_VIEW_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { orderNumber: 'asc' }],
    });
    return { orders: orders.map(orderView) };
  }

  /** Items whose counted stock is short, checked under the item row locks (MENU-006). */
  private async checkStock(
    tx: TransactionClient,
    restaurantId: string,
    lines: readonly ResolvedLine[],
  ): Promise<Set<string>> {
    const needs = new Map<string, number>();
    for (const line of lines) {
      const add = (id: string, quantity: number) => needs.set(id, (needs.get(id) ?? 0) + quantity);
      if (line.components.length === 0) add(line.item.id, line.request.quantity);
      for (const component of line.components) {
        add(component.item.id, component.quantity * line.request.quantity);
      }
    }
    const short = new Set<string>();
    for (const itemId of [...needs.keys()].sort()) {
      const stock = await this.menu.lockAvailability(tx, restaurantId, itemId);
      const need = needs.get(itemId) ?? 0;
      if (!stock.available || (stock.stockCount !== null && stock.stockCount < need))
        short.add(itemId);
    }
    return short;
  }

  /**
   * Dine-in orders need an open table session; the table row is locked so a move or close cannot
   * race the order. More items on a table waiting for its bill bring it back to OCCUPIED.
   */
  private async prepareTable(
    tx: TransactionClient,
    restaurantId: string,
    request: SubmitOrderRequest,
    itemState: OrderItemState,
    options: SubmitOptions,
  ): Promise<{ tableId: string; newState?: 'OCCUPIED' } | null> {
    if (request.orderType !== 'DINE_IN') return null;
    if (request.tableSessionId === undefined) {
      if (options.tableId === undefined) return null;
      // QR-010: a diner's order for a table that is not open waits for a waiter to approve it,
      // which opens the table.
      const table = await tx.diningTable.findFirst({
        where: { id: options.tableId, restaurantId, archivedAt: null },
        select: { id: true },
      });
      if (table === null) throw new AppError(404, 'TABLE_NOT_FOUND', 'There is no such table.');
      await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${table.id}::uuid FOR UPDATE`;
      return { tableId: table.id };
    }
    const found = await tx.tableSession.findFirst({
      where: { id: request.tableSessionId, restaurantId },
      select: { tableId: true },
    });
    if (found === null) {
      throw new AppError(404, 'TABLE_SESSION_NOT_FOUND', 'There is no such open table.');
    }
    await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${found.tableId}::uuid FOR UPDATE`;
    const session = await tx.tableSession.findUniqueOrThrow({
      where: { id: request.tableSessionId },
      include: { table: true },
    });
    if (session.status !== 'OPEN') {
      throw new AppError(
        409,
        'TABLE_SESSION_CLOSED',
        'This table has been closed. Open it again first.',
      );
    }
    const state = session.table.state;
    if (itemState === 'SENT' && (state === 'BILL_REQUESTED' || state === 'BILL_PRINTED')) {
      const to = transition(tableMachine, state, 'ADD_ITEMS').to;
      await tx.diningTable.update({ where: { id: session.tableId }, data: { state: to } });
      return { tableId: session.tableId, newState: 'OCCUPIED' };
    }
    return { tableId: session.tableId };
  }

  private async create(
    tx: TransactionClient,
    actor: OrderActor,
    request: SubmitOrderRequest,
    lines: readonly ResolvedLine[],
    context: {
      businessDate: string;
      itemState: OrderItemState;
      menu: MenuSnapshot;
      tableId: string | null;
      externalRef: string | null;
    },
  ): Promise<Accepted> {
    const { businessDate, itemState, menu } = context;
    const { restaurantId } = actor;
    const date = dbDate(businessDate);
    const orderNumber = await allocateDailyNumber(tx, {
      restaurantId,
      businessDate,
      kind: 'ORDER',
    });
    const takeaway = request.orderType === 'TAKEAWAY';
    const order = await tx.order.create({
      data: {
        id: newId(),
        restaurantId,
        businessDate: date,
        orderNumber,
        orderType: request.orderType,
        source: request.source,
        tableSessionId: takeaway ? null : (request.tableSessionId ?? null),
        tableId: context.tableId,
        takeawayToken: takeaway
          ? await allocateDailyNumber(tx, { restaurantId, businessDate, kind: 'TAKEAWAY_TOKEN' })
          : null,
        createdById: actor.staffId,
        deviceId: actor.deviceId,
        customerName: request.customerName ?? null,
        customerPhone: request.customerPhone ?? null,
        notes: request.orderNote ?? null,
        externalRef: context.externalRef,
      },
    });

    const taxRates = new Map(menu.taxGroups.map((group) => [group.id, group.components]));
    const sentAt = itemState === 'SENT' ? new Date() : null;
    const kotInputs: KotItemInput[] = [];
    const partIds = new Map<string, string>();
    for (const line of lines) {
      const { item, request: lineRequest } = line;
      // ORD-016: a held line waits for the waiter to fire it; it gets no ticket yet.
      const held = itemState === 'SENT' && lineRequest.hold === true;
      const base = {
        restaurantId,
        orderId: order.id,
        businessDate: date,
        taxGroupId: item.taxGroupId,
        taxRates: taxRates.get(item.taxGroupId) ?? [],
        state: held ? ('HELD' as const) : itemState,
        createdById: actor.staffId,
        sentAt: held ? null : sentAt,
      };
      const parent = await tx.orderItem.create({
        data: {
          ...base,
          id: newId(),
          itemId: item.id,
          variantId: lineRequest.variantId ?? null,
          clientLineId: lineRequest.clientLineId,
          name: item.name,
          variantName: line.variantName,
          quantity: lineRequest.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.unitPrice * lineRequest.quantity,
          stationId: item.stationId,
          instructions: lineRequest.instructions ?? null,
          recommendationLayer: lineRequest.recommendation?.layer ?? null,
          recommendationRuleId: lineRequest.recommendation?.ruleId ?? null,
          modifiers: {
            create: line.modifiers.map((modifier) => ({
              restaurantId,
              modifierOptionId: modifier.optionId,
              name: modifier.name,
              priceDelta: modifier.priceDelta,
            })),
          },
        },
      });
      // Combo parts are their own items for the kitchen; the combo line carries the price.
      for (const component of line.components) {
        const part = await tx.orderItem.create({
          data: {
            ...base,
            id: newId(),
            itemId: component.item.id,
            parentOrderItemId: parent.id,
            name: component.item.name,
            quantity: component.quantity * lineRequest.quantity,
            unitPrice: 0,
            lineTotal: 0,
            stationId: component.item.stationId,
          },
        });
        partIds.set(`${parent.id}:${component.item.id}`, part.id);
      }
      if (held) continue;
      kotInputs.push({
        orderItemId: parent.id,
        itemId: item.id,
        name: item.name,
        quantity: lineRequest.quantity,
        stationId: item.stationId,
        ...(line.variantName !== null && { variantName: line.variantName }),
        modifiers: line.modifiers.map((modifier) => modifier.name),
        ...(lineRequest.instructions !== undefined && { instructions: lineRequest.instructions }),
        comboComponents: line.components.map((component) => ({
          itemId: component.item.id,
          name: component.item.name,
          quantity: component.quantity,
          stationId: component.item.stationId,
        })),
      });
    }

    await tx.orderEvent.create({
      data: {
        restaurantId,
        orderId: order.id,
        businessDate: date,
        type: 'SUBMITTED',
        toState: itemState,
        actorId: actor.staffId,
        deviceId: actor.deviceId,
        payload: { lines: lines.length, source: request.source },
      },
    });
    await this.audit.record(tx, {
      action: 'ORDER_SUBMITTED',
      entityType: 'order',
      entityId: order.id,
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      restaurantId,
      businessDate,
      after: {
        orderNumber,
        source: request.source,
        orderType: request.orderType,
        lines: lines.map((line) => ({
          itemId: line.item.id,
          quantity: line.request.quantity,
          unitPrice: line.unitPrice,
        })),
      },
    });
    const audience: EventAudience = context.tableId === null ? {} : { tableIds: [context.tableId] };
    await this.emit(
      tx,
      restaurantId,
      businessDate,
      'order',
      order.id,
      {
        type: 'OrderSubmitted',
        payload: {
          orderId: order.id,
          orderNumber,
          source: request.source,
          ...(order.tableSessionId !== null && { tableSessionId: order.tableSessionId }),
          ...(order.tableSessionId === null &&
            order.tableId !== null && { tableId: order.tableId }),
          needsApproval: itemState === 'PENDING_APPROVAL',
        },
      },
      audience,
    );

    // Staff orders go to the kitchen now: one ticket per station, stock taken off (ORD-007).
    // Held lines take their stock now too (they are ordered), but no ticket until fired.
    if (itemState === 'SENT') {
      if (kotInputs.length > 0) {
        await this.sendToKitchen(
          tx,
          restaurantId,
          businessDate,
          order.id,
          kotInputs,
          partIds,
          menu,
        );
      }
      for (const line of lines) {
        if (line.components.length === 0) {
          await this.menu.decrementStock(tx, restaurantId, line.item.id, line.request.quantity);
        }
        for (const component of line.components) {
          await this.menu.decrementStock(
            tx,
            restaurantId,
            component.item.id,
            component.quantity * line.request.quantity,
          );
        }
      }
    }
    const allHeld = itemState === 'SENT' && kotInputs.length === 0;
    return {
      status: 'ACCEPTED',
      orderId: order.id,
      orderNumber,
      replayed: false,
      itemState: allHeld ? 'HELD' : itemState,
    };
  }

  /**
   * Per-station KOTs with their day numbers (ORD-007, ORD-008); combos exploded into parts. Also
   * used when a diner's order is approved (P3-03a).
   */
  async sendToKitchen(
    tx: TransactionClient,
    restaurantId: string,
    businessDate: string,
    orderId: string,
    inputs: readonly KotItemInput[],
    partIds: ReadonlyMap<string, string>,
    menu: MenuSnapshot,
  ): Promise<void> {
    const modes = new Map(menu.stations.map((station) => [station.id, station.mode]));
    for (const draft of splitIntoKots(inputs)) {
      const kotNumber = await allocateDailyNumber(tx, { restaurantId, businessDate, kind: 'KOT' });
      const mode = modes.get(draft.stationId) ?? 'SCREEN';
      const kot = await tx.kot.create({
        data: {
          id: newId(),
          restaurantId,
          businessDate: dbDate(businessDate),
          kotNumber,
          orderId,
          stationId: draft.stationId,
          kind: 'NEW',
          printStatus: mode === 'SCREEN' ? 'NOT_REQUIRED' : 'PENDING',
          lines: {
            create: draft.lines.map((line) => ({
              restaurantId,
              orderItemId:
                line.comboName === undefined
                  ? line.orderItemId
                  : (partIds.get(`${line.orderItemId}:${line.itemId}`) ?? line.orderItemId),
              quantity: line.quantity,
            })),
          },
        },
      });
      await this.emit(tx, restaurantId, businessDate, 'kot', kot.id, {
        type: 'KotCreated',
        payload: { kotId: kot.id, kotNumber, stationId: draft.stationId, orderId, kind: 'NEW' },
      });
    }
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
