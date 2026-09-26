import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/database/prisma.service.js';
import type { EventBus } from '../../src/events/event-bus.js';
import { NotificationTriggers } from '../../src/notifications/notification-triggers.js';
import type { NotificationsService } from '../../src/notifications/notifications.service.js';
import { domainEvent } from '../helpers/events.js';

const rid = randomUUID();
const sessionId = randomUUID();
const tableId = randomUUID();
const orderId = randomUUID();
const kotId = randomUUID();

function setup(options: { readyLeft?: number; tableSessionId?: string | null } = {}) {
  const raise = vi.fn().mockResolvedValue({ alertId: 'a', alreadyOpen: false });
  const clear = vi.fn().mockResolvedValue(1);
  const tx = {
    order: {
      findUnique: vi.fn().mockResolvedValue({
        tableId,
        tableSessionId: options.tableSessionId === undefined ? sessionId : options.tableSessionId,
      }),
    },
    orderItem: {
      findUnique: vi.fn().mockResolvedValue({ name: 'Dal Makhani', parentOrderItemId: null }),
      count: vi.fn().mockResolvedValue(options.readyLeft ?? 0),
    },
    tableSession: { findUnique: vi.fn().mockResolvedValue({ tableId }) },
    alert: { findMany: vi.fn().mockResolvedValue([{ id: 'collect-1', kotId }]) },
  } as unknown as TransactionClient;
  const triggers = new NotificationTriggers(
    { subscribe: vi.fn() } as unknown as EventBus,
    { raise, clear } as unknown as NotificationsService,
  );
  return { triggers, tx, raise, clear };
}

const changed = (to: string) =>
  domainEvent('ItemStatusChanged', rid, {
    orderId,
    orderItemId: randomUUID(),
    from: 'PREPARING',
    to,
  } as never);

describe('[NTF-003] [ORD-005] [KDS-006] what raises and clears alerts', () => {
  it('raises one "ready" alert per table when food is ready, but not for takeaway', async () => {
    const { triggers, tx, raise } = setup();
    await triggers.handle(changed('READY'), tx);
    expect(raise).toHaveBeenCalledWith(tx, {
      restaurantId: rid,
      type: 'ITEM_READY',
      tableId,
      tableSessionId: sessionId,
      orderId,
      dedupeKey: `ready:${sessionId}`,
      payload: { items: ['Dal Makhani'] },
    });
    const takeaway = setup({ tableSessionId: null });
    await takeaway.triggers.handle(changed('READY'), takeaway.tx);
    expect(takeaway.raise).not.toHaveBeenCalled();
  });

  it('clears the ready and "not collected" alerts once nothing waits at the pass', async () => {
    const { triggers, tx, clear } = setup({ readyLeft: 0 });
    await triggers.handle(changed('PICKED_UP'), tx);
    expect(clear).toHaveBeenCalledWith(tx, { restaurantId: rid, dedupeKey: `ready:${sessionId}` });
    expect(clear).toHaveBeenCalledWith(tx, { restaurantId: rid, ids: ['collect-1'] });
    const waiting = setup({ readyLeft: 1 });
    await waiting.triggers.handle(changed('PICKED_UP'), waiting.tx);
    expect(waiting.clear).not.toHaveBeenCalled();
  });

  it('alerts for an order awaiting approval and clears it when decided', async () => {
    const { triggers, tx, raise, clear } = setup();
    await triggers.handle(
      domainEvent('OrderSubmitted', rid, {
        orderId,
        orderNumber: 12,
        source: 'TABLE_TABLET',
        tableSessionId: sessionId,
        needsApproval: true,
      }),
      tx,
    );
    expect(raise).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: 'ORDER_PENDING_APPROVAL', dedupeKey: `approval:${orderId}` }),
    );
    await triggers.handle(
      domainEvent('OrderSubmitted', rid, {
        orderId,
        orderNumber: 13,
        source: 'POS',
        tableSessionId: sessionId,
        needsApproval: false,
      }),
      tx,
    );
    expect(raise).toHaveBeenCalledTimes(1);
    await triggers.handle(
      domainEvent('OrderApproved', rid, { orderId, approvedBy: randomUUID() }),
      tx,
    );
    expect(clear).toHaveBeenCalledWith(tx, { restaurantId: rid, dedupeKey: `approval:${orderId}` });
  });

  it('clears a table’s alerts when it closes, and a ticket’s when it is bumped', async () => {
    const { triggers, tx, clear } = setup();
    await triggers.handle(
      domainEvent('TableClosed', rid, { tableId, tableSessionId: sessionId }),
      tx,
    );
    expect(clear).toHaveBeenCalledWith(tx, { restaurantId: rid, tableSessionId: sessionId });
    await triggers.handle(
      domainEvent('KotBumped', rid, { kotId, stationId: randomUUID(), bumped: true }),
      tx,
    );
    expect(clear).toHaveBeenCalledWith(tx, { restaurantId: rid, ids: ['collect-1'] });
    clear.mockClear();
    await triggers.handle(
      domainEvent('KotBumped', rid, { kotId, stationId: randomUUID(), bumped: false }),
      tx,
    );
    expect(clear).not.toHaveBeenCalled();
  });
});
