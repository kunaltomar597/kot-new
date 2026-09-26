import { businessDateOf } from '@rp/domain';
import type { TransactionClient } from '../database/prisma.service.js';

/** A `@db.Date` column value for an ISO date ('2026-09-26'). */
export function dbDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** The ISO date of a `@db.Date` column value. */
export function isoDateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The restaurant's business date at `now` (its cut-off and time zone, BRD §9.4). */
export async function currentBusinessDate(
  client: Pick<TransactionClient, 'restaurant'>,
  restaurantId: string,
  now: Date = new Date(),
): Promise<string> {
  const restaurant = await client.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { timeZone: true, businessDayCutoff: true },
  });
  return businessDateOf(now, {
    cutoff: restaurant.businessDayCutoff,
    timeZone: restaurant.timeZone,
  });
}
