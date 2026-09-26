import { businessDateOf } from '@rp/domain';
import { newId } from '../common/ids.js';
import { ADVISORY_LOCKS } from '../database/advisory-locks.js';
import type { TransactionClient } from '../database/prisma.service.js';
import { appendEvent } from '../events/outbox.js';

export type SetupPart =
  'PROFILE' | 'LEGAL' | 'TAX_GROUPS' | 'INVOICE_SERIES' | 'FLOOR' | 'WAITER_ASSIGNMENTS';

/**
 * Serialises changes to the restaurant's setup for the rest of the transaction, so checks such as
 * "no other active tax group has this name" or "exactly one default series" cannot race.
 */
export async function lockSetup(tx: TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADVISORY_LOCKS.restaurantSetup})`;
}

/** Tells every screen that part of the setup changed (`RestaurantChanged`, in the transaction). */
export async function announceSetupChange(
  tx: TransactionClient,
  restaurantId: string,
  part: SetupPart,
  aggregate: { readonly type: string; readonly id: string },
): Promise<void> {
  const restaurant = await tx.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { timeZone: true, businessDayCutoff: true },
  });
  const now = new Date();
  await appendEvent(
    tx,
    {
      eventId: newId(),
      type: 'RestaurantChanged',
      version: 1,
      occurredAt: now.toISOString(),
      restaurantId,
      businessDate: businessDateOf(now, {
        cutoff: restaurant.businessDayCutoff,
        timeZone: restaurant.timeZone,
      }),
      payload: { part },
    },
    { aggregate },
  );
}
