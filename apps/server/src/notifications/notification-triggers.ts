import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@rp/contracts';
import type { TransactionClient } from '../database/prisma.service.js';
import { EventBus } from '../events/event-bus.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Turns domain events into alerts and clears them when their cause goes away (P2-03, NTF-003):
 * - an order waiting for approval (ORD-005), until approved or rejected;
 * - food ready for a table, until nothing of that table is waiting at the pass;
 * - a bill request, until the table closes;
 * - "ready, not collected" from the kitchen, until that ticket is collected or bumped.
 * It runs as a durable event-bus consumer, so every alert is raised once, even after a restart.
 */
@Injectable()
export class NotificationTriggers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe({
      name: 'notifications.triggers',
      types: [
        'OrderSubmitted',
        'OrderApproved',
        'OrderRejected',
        'ItemStatusChanged',
        'BillRequested',
        'TableClosed',
        'KotBumped',
      ],
      handle: (event, context) => this.handle(event, context.tx),
    });
  }

  async handle(event: DomainEvent, tx: TransactionClient): Promise<void> {
    const restaurantId = event.restaurantId;
    switch (event.type) {
      case 'OrderSubmitted': {
        if (!event.payload.needsApproval || event.payload.tableSessionId === undefined) return;
        const session = await tx.tableSession.findUnique({
          where: { id: event.payload.tableSessionId },
          select: { tableId: true },
        });
        await this.notifications.raise(tx, {
          restaurantId,
          type: 'ORDER_PENDING_APPROVAL',
          tableId: session?.tableId ?? null,
          tableSessionId: event.payload.tableSessionId,
          orderId: event.payload.orderId,
          dedupeKey: `approval:${event.payload.orderId}`,
          payload: { orderNumber: event.payload.orderNumber, source: event.payload.source },
        });
        return;
      }
      case 'OrderApproved':
      case 'OrderRejected':
        await this.notifications.clear(tx, {
          restaurantId,
          dedupeKey: `approval:${event.payload.orderId}`,
        });
        return;
      case 'BillRequested': {
        const session = await tx.tableSession.findUnique({
          where: { id: event.payload.tableSessionId },
          select: { tableId: true },
        });
        await this.notifications.raise(tx, {
          restaurantId,
          type: 'BILL_REQUEST',
          tableId: session?.tableId ?? null,
          tableSessionId: event.payload.tableSessionId,
          dedupeKey: `bill:${event.payload.tableSessionId}`,
          payload: { requestedFrom: event.payload.requestedFrom },
        });
        return;
      }
      case 'TableClosed':
        await this.notifications.clear(tx, {
          restaurantId,
          tableSessionId: event.payload.tableSessionId,
        });
        return;
      case 'ItemStatusChanged':
        await this.itemChanged(tx, restaurantId, event.payload);
        return;
      case 'KotBumped': {
        if (!event.payload.bumped) return;
        const alerts = await tx.alert.findMany({
          where: { restaurantId, status: 'OPEN', kotId: event.payload.kotId },
          select: { id: true },
        });
        await this.notifications.clear(tx, { restaurantId, ids: alerts.map((alert) => alert.id) });
        return;
      }
      default:
        return;
    }
  }

  private async itemChanged(
    tx: TransactionClient,
    restaurantId: string,
    change: { orderId: string; orderItemId: string; to: string },
  ): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: change.orderId },
      select: { tableId: true, tableSessionId: true },
    });
    if (order === null) return;
    if (change.to === 'READY') {
      // Takeaway food is called by its token on the counter display, not by a waiter's pager.
      if (order.tableSessionId === null) return;
      const item = await tx.orderItem.findUnique({
        where: { id: change.orderItemId },
        select: { name: true, parentOrderItemId: true },
      });
      await this.notifications.raise(tx, {
        restaurantId,
        type: 'ITEM_READY',
        tableId: order.tableId,
        tableSessionId: order.tableSessionId,
        orderId: change.orderId,
        dedupeKey: `ready:${order.tableSessionId}`,
        payload: { items: item === null ? [] : [item.name] },
      });
      return;
    }
    // Something left the pass (picked up, served, cancelled): clear what no longer waits.
    const stillReady = async (where: object) =>
      (await tx.orderItem.count({ where: { ...where, state: 'READY' } })) > 0;
    if (
      order.tableSessionId !== null &&
      !(await stillReady({ order: { tableSessionId: order.tableSessionId } }))
    ) {
      await this.notifications.clear(tx, {
        restaurantId,
        dedupeKey: `ready:${order.tableSessionId}`,
      });
    }
    const waiting = await tx.alert.findMany({
      where: {
        restaurantId,
        status: 'OPEN',
        type: 'READY_NOT_COLLECTED',
        kot: { orderId: change.orderId },
      },
      select: { id: true, kotId: true },
    });
    const done: string[] = [];
    for (const alert of waiting) {
      if (alert.kotId === null) continue;
      if (!(await stillReady({ kotLines: { some: { kotId: alert.kotId } } }))) done.push(alert.id);
    }
    if (done.length > 0) await this.notifications.clear(tx, { restaurantId, ids: done });
  }
}
