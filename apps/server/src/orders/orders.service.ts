import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  DomainEvent,
  MenuSnapshot,
  OrderLineRequest,
  OrderListResponse,
  OrderView,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from '@rp/contracts';
import {
  calendarDateOf,
  canonicalJson,
  initialOrderItemState,
  type OrderItemState,
  type OrderSource,
  splitIntoKots,
  tableMachine,
  toLocalDateTime,
  transition,
  unitPriceOf,
  validateSelection,
  type KotItemInput,
} from '@rp/domain';
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

type MenuItem = MenuSnapshot['items'][number];
type RejectedLine = Extract<
  SubmitOrderResponse,
  { status: 'PARTIALLY_REJECTED' }
>['rejectedLines'][number];
type Accepted = Extract<SubmitOrderResponse, { status: 'ACCEPTED' }>;

/** Who submits an order: a signed-in person on a device, or (later) a tablet or the QR relay. */
export interface OrderActor {
  readonly restaurantId: string;
  readonly staffId: string | null;
  readonly deviceId: string | null;
}

/** A priced, validated line, ready to be written. */
interface ResolvedLine {
  readonly request: OrderLineRequest;
  readonly item: MenuItem;
  readonly variantName: string | null;
  readonly modifiers: readonly { optionId: string; name: string; priceDelta: number }[];
  readonly unitPrice: number;
  /** Combo parts with their per-combo quantity (MENU-005). */
  readonly components: readonly { item: MenuItem; quantity: number }[];
}

const IDEMPOTENCY_SCOPE = 'orders.submit';
const IDEMPOTENCY_DAYS = 7;
const CHANNEL_OF: Readonly<Record<OrderSource, MenuItem['channels'][number]>> = {
  POS: 'POS',
  WAITER_APP: 'WAITER_APP',
  TABLE_TABLET: 'TABLE_TABLET',
  QR: 'QR',
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function reject(line: OrderLineRequest, code: RejectedLine['code'], message: string): RejectedLine {
  return { clientLineId: line.clientLineId, code, message };
}

/** Whether a combo is offered at `now`: its date range and daily time window (MENU-005). */
function comboOnNow(combo: MenuSnapshot['combos'][number], now: Date, timeZone: string): boolean {
  const today = calendarDateOf(now, timeZone);
  if (combo.activeFrom !== undefined && today < combo.activeFrom) return false;
  if (combo.activeUntil !== undefined && today > combo.activeUntil) return false;
  if (combo.timeWindow === undefined) return true;
  const local = toLocalDateTime(now, timeZone);
  const time = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  const { start, end } = combo.timeWindow;
  return start <= end ? time >= start && time < end : time >= start || time < end;
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
const ORDER_VIEW_INCLUDE = {
  items: { orderBy: { id: 'asc' }, include: { modifiers: { orderBy: { id: 'asc' } } } },
  kots: { orderBy: { kotNumber: 'asc' } },
} as const satisfies Prisma.OrderInclude;

function orderView(
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
      variantName: item.variantName,
      modifiers: item.modifiers.map(({ name, priceDelta }) => ({ name, priceDelta })),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      stationId: item.stationId,
      state: item.state,
      instructions: item.instructions,
    })),
    kots: order.kots.map(({ id, kotNumber, stationId, kind }) => ({
      id,
      kotNumber,
      stationId,
      kind,
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

  async submit(actor: OrderActor, request: SubmitOrderRequest): Promise<SubmitOrderResponse> {
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
        const resolved = this.resolve(
          line,
          menu,
          request.source,
          maxLength,
          now,
          restaurant.timeZone,
        );
        if ('code' in resolved) rejected.push(resolved);
        else lines.push(resolved);
      }
      const itemState = initialOrderItemState(request.source);
      const stockProblems = await this.checkStock(tx, actor.restaurantId, lines);
      for (const line of lines) {
        const ids = [line.item.id, ...line.components.map((component) => component.item.id)];
        if (ids.some((id) => stockProblems.has(id))) {
          rejected.push(reject(line.request, 'OUT_OF_STOCK', `${line.item.name} is out of stock.`));
        }
      }
      if (rejected.length > 0) return { status: 'PARTIALLY_REJECTED', rejectedLines: rejected };

      const businessDate = await currentBusinessDate(tx, actor.restaurantId, now);
      const table = await this.prepareTable(tx, actor.restaurantId, request, itemState);
      const response = await this.create(tx, actor, request, lines, {
        businessDate,
        itemState,
        menu,
        tableId: table?.tableId ?? null,
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

  /** Prices and checks one line against the published menu; a rejection says why (ORD-017). */
  private resolve(
    line: OrderLineRequest,
    menu: MenuSnapshot,
    source: OrderSource,
    maxLength: number,
    now: Date,
    timeZone: string,
  ): ResolvedLine | RejectedLine {
    const items = new Map(menu.items.map((item) => [item.id, item]));
    const item = items.get(line.itemId);
    if (item === undefined) return reject(line, 'ARCHIVED', 'This item is no longer on the menu.');
    if (!item.available) {
      return item.stockCount === 0
        ? reject(line, 'OUT_OF_STOCK', `${item.name} is out of stock.`)
        : reject(line, 'NOT_AVAILABLE_NOW', `${item.name} is not available right now.`);
    }
    if (!item.channels.includes(CHANNEL_OF[source])) {
      return reject(line, 'NOT_ON_CHANNEL', `${item.name} cannot be ordered here.`);
    }
    if ((line.instructions?.length ?? 0) > maxLength) {
      return reject(
        line,
        'INVALID_SELECTION',
        `Instructions are limited to ${String(maxLength)} characters.`,
      );
    }

    const groups = new Map(menu.modifierGroups.map((group) => [group.id, group]));
    const definition = {
      id: item.id,
      basePrice: item.basePrice,
      variants: item.variants,
      modifierGroups: item.modifierGroupIds.flatMap((id) => {
        const group = groups.get(id);
        return group === undefined ? [] : [group];
      }),
    };
    const selection = {
      ...(line.variantId !== undefined && { variantId: line.variantId }),
      modifiers: line.modifiers,
    };
    const issues = validateSelection(definition, selection);
    if (issues.length > 0) {
      return reject(line, 'INVALID_SELECTION', issues.map((issue) => issue.message).join('; '));
    }

    const components: { item: MenuItem; quantity: number }[] = [];
    const combo = menu.combos.find((entry) => entry.itemId === item.id);
    if (combo !== undefined) {
      if (!comboOnNow(combo, now, timeZone)) {
        return reject(line, 'NOT_AVAILABLE_NOW', `${item.name} is not offered at this time.`);
      }
      const choices = [...(line.comboChoices ?? [])];
      const slots = combo.components.filter((component) => component.kind === 'CHOICE');
      if (choices.length !== slots.length) {
        return reject(line, 'INVALID_SELECTION', `Choose one item for each part of ${item.name}.`);
      }
      for (const component of combo.components) {
        const chosen = component.kind === 'FIXED' ? component.itemId : choices.shift();
        if (
          component.kind === 'CHOICE' &&
          (chosen === undefined || !component.itemIds.includes(chosen))
        ) {
          return reject(
            line,
            'INVALID_SELECTION',
            `That is not one of the choices for ${component.label}.`,
          );
        }
        const part = items.get(chosen ?? '');
        if (part?.available !== true) {
          return reject(line, 'OUT_OF_STOCK', `Part of ${item.name} is out of stock.`);
        }
        components.push({ item: part, quantity: component.quantity });
      }
    } else if ((line.comboChoices ?? []).length > 0) {
      return reject(line, 'INVALID_SELECTION', `${item.name} is not a combo.`);
    }

    const chosen = new Set(line.modifiers.flatMap((modifier) => modifier.optionIds));
    const modifiers = definition.modifierGroups.flatMap((group) =>
      group.options
        .filter((option) => chosen.has(option.id))
        .map((option) => ({
          optionId: option.id,
          name: option.name,
          priceDelta: option.priceDelta,
        })),
    );
    return {
      request: line,
      item,
      variantName: item.variants.find((variant) => variant.id === line.variantId)?.name ?? null,
      modifiers,
      unitPrice: unitPriceOf(definition, selection),
      components,
    };
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
  ): Promise<{ tableId: string; newState?: 'OCCUPIED' } | null> {
    if (request.orderType !== 'DINE_IN' || request.tableSessionId === undefined) return null;
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
      },
    });

    const taxRates = new Map(menu.taxGroups.map((group) => [group.id, group.components]));
    const sentAt = itemState === 'SENT' ? new Date() : null;
    const kotInputs: KotItemInput[] = [];
    const partIds = new Map<string, string>();
    for (const line of lines) {
      const { item, request: lineRequest } = line;
      const base = {
        restaurantId,
        orderId: order.id,
        businessDate: date,
        taxGroupId: item.taxGroupId,
        taxRates: taxRates.get(item.taxGroupId) ?? [],
        state: itemState,
        createdById: actor.staffId,
        sentAt,
      };
      const parent = await tx.orderItem.create({
        data: {
          ...base,
          id: newId(),
          itemId: item.id,
          variantId: lineRequest.variantId ?? null,
          name: item.name,
          variantName: line.variantName,
          quantity: lineRequest.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.unitPrice * lineRequest.quantity,
          stationId: item.stationId,
          instructions: lineRequest.instructions ?? null,
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
          needsApproval: itemState === 'PENDING_APPROVAL',
        },
      },
      audience,
    );

    // Staff orders go to the kitchen now: one ticket per station, stock taken off (ORD-007).
    if (itemState === 'SENT') {
      await this.sendToKitchen(tx, restaurantId, businessDate, order.id, kotInputs, partIds, menu);
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
    return { status: 'ACCEPTED', orderId: order.id, orderNumber, replayed: false, itemState };
  }

  /** Per-station KOTs with their day numbers (ORD-007, ORD-008); combos exploded into parts. */
  private async sendToKitchen(
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
