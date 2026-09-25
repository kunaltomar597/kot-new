import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { DomainEvent, type DomainEventType, type EventOfType } from '@rp/contracts';
import { PrismaService } from '../../src/database/prisma.service.js';
import { appendEvent, type EventAudience } from '../../src/events/outbox.js';

/** A valid domain event of `type` for tests. */
export function domainEvent<T extends DomainEventType>(
  type: T,
  restaurantId: string,
  payload: EventOfType<T>['payload'],
): EventOfType<T> {
  return DomainEvent.parse({
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    restaurantId,
    businessDate: '2026-09-25',
    payload,
  }) as EventOfType<T>;
}

/** Appends events in one committed transaction, as a producer would. */
export async function produce(
  app: INestApplication,
  events: readonly DomainEvent[],
  audience?: EventAudience,
): Promise<void> {
  await app.get(PrismaService).transaction(async (tx) => {
    for (const event of events) {
      await appendEvent(tx, event, {
        aggregate: { type: 'test', id: randomUUID() },
        ...(audience !== undefined && { audience }),
      });
    }
  });
}
