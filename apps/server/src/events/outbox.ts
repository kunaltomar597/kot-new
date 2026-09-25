import { DomainEvent, Id } from '@rp/contracts';
import { z } from 'zod';
import type { TransactionClient } from '../database/prisma.service.js';

const Ids = z.array(Id).max(100);

/**
 * Who else should see an event on the real-time socket, beyond what the event itself names
 * (P0-12). An item status change, for example, does not carry its table or station, but the tablet
 * at that table and the station's kitchen screen must see it. Stored with the outbox row, not in
 * the event, so event payloads stay the documented contract (INT-004).
 */
export const EventAudience = z.object({
  tableIds: Ids.optional(),
  stationIds: Ids.optional(),
  sectionIds: Ids.optional(),
  staffIds: Ids.optional(),
});
export type EventAudience = z.infer<typeof EventAudience>;

export interface AppendEventOptions {
  /** The record the event is about, e.g. `{ type: 'order', id: orderId }`. */
  readonly aggregate: { readonly type: string; readonly id: string };
  readonly audience?: EventAudience;
}

/**
 * Appends a domain event to the outbox inside the caller's transaction, so the event exists if and
 * only if the change it describes committed (INT-004, BRD §10.1 principle 3). The event dispatcher
 * (`EventBus`) wakes when the transaction commits, gives the event its sequence and delivers it to
 * consumers and to the real-time socket.
 */
export async function appendEvent(
  tx: TransactionClient,
  event: DomainEvent,
  options: AppendEventOptions,
): Promise<void> {
  const parsed = DomainEvent.parse(event);
  const audience =
    options.audience === undefined ? undefined : EventAudience.parse(options.audience);
  await tx.outboxEvent.create({
    data: {
      restaurantId: parsed.restaurantId,
      eventType: parsed.type,
      eventVersion: parsed.version,
      aggregateType: options.aggregate.type,
      aggregateId: options.aggregate.id,
      payload: parsed,
      occurredAt: new Date(parsed.occurredAt),
      ...(audience !== undefined && { audience }),
    },
  });
}
