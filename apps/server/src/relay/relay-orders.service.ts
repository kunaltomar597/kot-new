import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { QrPickupOrder, type QrOrderStatus } from '@rp/contracts/relay';
import { canonicalJson } from '@rp/domain';
import { type QrOutcome, qrStatusOf, qrSteps } from '@rp/ordering';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { EventBus } from '../events/event-bus.js';
import { OrdersService } from '../orders/orders.service.js';
import { PacedLoop } from './paced-loop.js';
import { type RelayClient, RelayError } from './relay-client.js';
import { RelaySyncService } from './relay-sync.service.js';

export const RELAY_ORDERS_OPTIONS = Symbol('RELAY_ORDERS_OPTIONS');

export interface RelayOrdersOptions {
  readonly firstDelayMs: number;
  /** How often to look for diners' orders (the fallback to Realtime, QR-009). */
  readonly pollMs: number;
  /** After the restaurant acts on a QR order, tell the relay this soon (QR-007). */
  readonly pushDebounceMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export const DEFAULT_RELAY_ORDERS_OPTIONS: RelayOrdersOptions = {
  firstDelayMs: 12_000,
  pollMs: 5_000,
  pushDebounceMs: 500,
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
};

/** Shown to the diner when the restaurant could not take the order at all. */
const COULD_NOT_TAKE = 'The restaurant could not take this order. Please call a waiter.';
const TABLE_CLOSED = 'This table is not taking orders right now. Please call a waiter.';

const hashOf = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/**
 * The QR relay's sync agent, order side (P5-03b, QR-007, QR-009, QR-010, ORD-013).
 *
 * 1. Pick up: diners' orders waiting at the relay go into the inbox (`relay_orders`), once each.
 * 2. Take: an order past its pickup time is left to expire. Otherwise the relay is told it was
 *    received, then it becomes a normal QR order priced here, waiting for a waiter. A table that
 *    is not open goes to its section's waiter, and approving opens it. Lines the menu can no
 *    longer serve reject it with the reason. A restart between the two steps resumes.
 * 3. Tell: whenever the restaurant acts on it (approved, rejected, each line's state), the relay
 *    is told, in the order it accepts. A durable event consumer marks what changed, so nothing is
 *    lost while offline.
 */
@Injectable()
export class RelayOrdersService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RelayOrdersService.name);
  private readonly loop: PacedLoop;
  private unsubscribe: (() => void) | undefined;
  private lastError: string | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly sync: RelaySyncService,
    private readonly events: EventBus,
    @Inject(RELAY_ORDERS_OPTIONS) private readonly options: RelayOrdersOptions,
  ) {
    this.loop = new PacedLoop(
      () => this.cycle(),
      options,
      (error) => {
        const code = error instanceof RelayError ? error.code : 'INTERNAL';
        if (this.lastError !== code) {
          this.logger.warn({ code, err: error }, 'QR orders not in step with the relay');
        }
        this.lastError = code;
      },
    );
  }

  onModuleInit(): void {
    // Whatever the restaurant does to a QR order is to be told to the relay; marked in the same
    // transaction as the event is handled, so it survives a restart or a long outage.
    this.events.subscribe({
      name: 'relay.qr-orders',
      types: ['OrderApproved', 'OrderRejected', 'ItemStatusChanged'],
      handle: async (event, { tx }) => {
        if (
          event.type !== 'OrderApproved' &&
          event.type !== 'OrderRejected' &&
          event.type !== 'ItemStatusChanged'
        ) {
          return;
        }
        await tx.relayOrder.updateMany({
          where: { orderId: event.payload.orderId, pushedHash: { not: null } },
          data: { pushedHash: null },
        });
      },
    });
  }

  onApplicationBootstrap(): void {
    if (this.config.relayUrl === undefined) return;
    const acts = new Set(['OrderApproved', 'OrderRejected', 'ItemStatusChanged']);
    this.unsubscribe = this.events.onPublished((events) => {
      if (events.some(({ event }) => acts.has(event.type))) {
        this.loop.soon(this.options.pushDebounceMs);
      }
    });
    this.loop.start(this.options.firstDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    await this.loop.stop();
  }

  /** Picks up, takes and tells now (the loop calls it; so do tests). Never throws. */
  async run(): Promise<{ lastError: string | null }> {
    await this.loop.run();
    return { lastError: this.lastError };
  }

  private async cycle(): Promise<number> {
    const client = await this.sync.client();
    if (client === undefined) return this.options.retryMaxMs;
    const restaurant = await this.prisma.restaurant.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (restaurant === null) return this.options.retryMaxMs;
    const { orders } = await client.pickup();
    for (const order of orders) await this.inbox(restaurant.id, order);
    await this.takeWaiting(client, restaurant.id);
    await this.tell(client, restaurant.id);
    this.lastError = null;
    return this.options.pollMs;
  }

  /** The inbox: one row per relay order, whatever happens next (ORD-013). */
  private async inbox(restaurantId: string, order: QrPickupOrder): Promise<void> {
    await this.prisma.relayOrder.createMany({
      data: [
        {
          relayOrderId: order.id,
          restaurantId,
          tableId: order.tableId,
          payload: order,
          expiresAt: new Date(order.expiresAt),
        },
      ],
      skipDuplicates: true,
    });
  }

  /** Takes every inbox order not yet dealt with, oldest first. */
  private async takeWaiting(client: RelayClient, restaurantId: string): Promise<void> {
    const waiting = await this.prisma.relayOrder.findMany({
      where: { restaurantId, outcome: null },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    for (const row of waiting) {
      const order = QrPickupOrder.parse(row.payload);
      const outcome = await this.take(client, restaurantId, order);
      await this.prisma.relayOrder.update({
        where: { relayOrderId: row.relayOrderId },
        data: {
          outcome: outcome.outcome,
          orderId: outcome.orderId,
          rejectionReason: outcome.reason,
          // What the relay was told so far; the telling step takes it from there.
          pushedHash: null,
          ...(outcome.pushed !== undefined && { pushedStatus: outcome.pushed }),
        },
      });
    }
  }

  private async take(
    client: RelayClient,
    restaurantId: string,
    order: QrPickupOrder,
  ): Promise<{
    outcome: QrOutcome;
    orderId: string | null;
    reason: string | null;
    pushed?: QrOrderStatus;
  }> {
    const expired = { outcome: 'EXPIRED' as const, orderId: null, reason: null };
    // Done already, before a restart: just finish the record.
    const existing = await this.prisma.order.findFirst({
      where: { restaurantId, source: 'QR', externalRef: order.id },
      select: { id: true },
    });
    if (existing !== null) return { outcome: 'CREATED', orderId: existing.id, reason: null };

    // QR-007: past its pickup time by the relay's clock, it is left to expire, never made.
    const offset = this.sync.status().clockOffsetMs ?? 0;
    if (Date.now() + offset > Date.parse(order.expiresAt))
      return { ...expired, pushed: 'SUBMITTED' };
    try {
      await client.updateOrder(order.id, { status: 'RECEIVED' });
    } catch (error) {
      if (!(error instanceof RelayError)) throw error;
      // Too late after all, or the relay already closed it: nothing is made.
      if (error.code === 'ORDER_EXPIRED' || error.code === 'INVALID_STATUS_CHANGE') {
        return { ...expired, pushed: 'EXPIRED' };
      }
      if (error.code === 'ORDER_NOT_FOUND') return { ...expired, pushed: 'EXPIRED' };
      throw error;
    }

    const table = await this.prisma.diningTable.findFirst({
      where: { id: order.tableId, restaurantId, archivedAt: null },
      select: { id: true, sessions: { where: { status: 'OPEN' }, select: { id: true } } },
    });
    if (table === null) {
      return { outcome: 'REJECTED', orderId: null, reason: TABLE_CLOSED, pushed: 'RECEIVED' };
    }
    const sessionId = table.sessions[0]?.id;
    try {
      const answer = await this.orders.submit(
        { restaurantId, staffId: null, deviceId: null },
        {
          idempotencyKey: order.idempotencyKey,
          source: 'QR',
          orderType: 'DINE_IN',
          ...(sessionId !== undefined && { tableSessionId: sessionId }),
          lines: order.lines,
          ...(order.orderNote !== null && { orderNote: order.orderNote }),
          ...(order.customerName !== null && { customerName: order.customerName }),
        },
        { tableId: table.id, externalRef: order.id },
      );
      if (answer.status === 'ACCEPTED') {
        this.logger.log({ orderId: answer.orderId, relayOrderId: order.id }, 'QR order taken');
        return { outcome: 'CREATED', orderId: answer.orderId, reason: null, pushed: 'RECEIVED' };
      }
      const reason = answer.rejectedLines.map((line) => line.message).join(' ');
      return { outcome: 'REJECTED', orderId: null, reason, pushed: 'RECEIVED' };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      this.logger.warn({ code: error.code, relayOrderId: order.id }, 'QR order refused');
      return { outcome: 'REJECTED', orderId: null, reason: COULD_NOT_TAKE, pushed: 'RECEIVED' };
    }
  }

  /** Tells the relay what changed since it was last told (QR-007). */
  private async tell(client: RelayClient, restaurantId: string): Promise<void> {
    const rows = await this.prisma.relayOrder.findMany({
      where: { restaurantId, outcome: { not: null }, pushedHash: null },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: {
        order: {
          select: {
            id: true,
            items: {
              where: { parentOrderItemId: null },
              orderBy: { createdAt: 'asc' },
              select: { clientLineId: true, state: true, endReason: true },
            },
          },
        },
      },
    });
    for (const row of rows) {
      const target = qrStatusOf({
        outcome: row.outcome as QrOutcome,
        rejectionReason: row.rejectionReason,
        lines: row.order?.items ?? [],
      });
      const localOrderId = row.order?.id;
      const hash = hashOf({ target, localOrderId });
      let pushed = (row.pushedStatus ?? null) as QrOrderStatus | null;
      for (const status of qrSteps(pushed, target.status)) {
        try {
          await client.updateOrder(row.relayOrderId, {
            status,
            ...(status === target.status && { detail: target.detail }),
            ...(localOrderId !== undefined && { localOrderId }),
          });
          pushed = status;
        } catch (error) {
          // The relay is past this already, or the order is gone: there is nothing more to tell.
          if (
            error instanceof RelayError &&
            ['INVALID_STATUS_CHANGE', 'ORDER_EXPIRED', 'ORDER_NOT_FOUND'].includes(error.code)
          ) {
            this.logger.warn(
              { code: error.code, relayOrderId: row.relayOrderId },
              'QR order status not taken',
            );
            break;
          }
          throw error;
        }
      }
      await this.prisma.relayOrder.update({
        where: { relayOrderId: row.relayOrderId },
        data: { pushedHash: hash, ...(pushed !== null && { pushedStatus: pushed }) },
      });
    }
  }
}
