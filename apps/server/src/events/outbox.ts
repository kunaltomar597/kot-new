import { DomainEvent } from '@rp/contracts';
import type { TransactionClient } from '../database/prisma.service.js';

/**
 * Appends a domain event to the outbox inside the caller's transaction, so the event exists if and
 * only if the change it describes committed (INT-004). Real-time publishing reads the outbox
 * (P0-12).
 */
export async function appendEvent(
  tx: TransactionClient,
  event: DomainEvent,
  aggregate: { readonly type: string; readonly id: string },
): Promise<void> {
  const parsed = DomainEvent.parse(event);
  await tx.outboxEvent.create({
    data: {
      restaurantId: parsed.restaurantId,
      eventType: parsed.type,
      eventVersion: parsed.version,
      aggregateType: aggregate.type,
      aggregateId: aggregate.id,
      payload: parsed,
      occurredAt: new Date(parsed.occurredAt),
    },
  });
}
