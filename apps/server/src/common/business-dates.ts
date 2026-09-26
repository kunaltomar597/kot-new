import { addDays, businessDateOf } from '@rp/domain';
import type { TransactionClient } from '../database/prisma.service.js';

/** A `@db.Date` column value for an ISO date ('2026-09-26'). */
export function dbDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** The ISO date of a `@db.Date` column value. */
export function isoDateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The restaurant's business date at `now` (its cut-off and time zone, BRD §9.4). Once a day is
 * closed at day-end (BILL-013) nothing more is recorded on it: until the clock reaches the next
 * cut-off, new orders, bills and payments belong to the following business date.
 */
export async function currentBusinessDate(
  client: Pick<TransactionClient, 'restaurant' | 'businessDay'>,
  restaurantId: string,
  now: Date = new Date(),
): Promise<string> {
  const restaurant = await client.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { timeZone: true, businessDayCutoff: true },
  });
  let date = businessDateOf(now, {
    cutoff: restaurant.businessDayCutoff,
    timeZone: restaurant.timeZone,
  });
  const closed = await client.businessDay.findMany({
    where: { restaurantId, status: 'CLOSED', businessDate: { gte: dbDate(date) } },
    select: { businessDate: true },
  });
  const closedDates = new Set(closed.map((day) => isoDateOf(day.businessDate)));
  while (closedDates.has(date)) date = addDays(date, 1);
  return date;
}
