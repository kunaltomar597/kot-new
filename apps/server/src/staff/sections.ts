import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import type { TransactionClient } from '../database/prisma.service.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';

/**
 * Takes people off today's (and later) waiter assignments, when they are deactivated or no longer
 * take orders, so their tables and alerts go to others; returns how many assignments went.
 */
export async function takeOffSections(
  tx: TransactionClient,
  restaurantId: string,
  staffIds: readonly string[],
): Promise<number> {
  if (staffIds.length === 0) return 0;
  await lockSetup(tx);
  const today = await currentBusinessDate(tx, restaurantId);
  const removed = await tx.shiftAssignment.deleteMany({
    where: { restaurantId, staffId: { in: [...staffIds] }, businessDate: { gte: dbDate(today) } },
  });
  if (removed.count > 0) {
    await announceSetupChange(tx, restaurantId, 'WAITER_ASSIGNMENTS', {
      type: 'waiter_assignments',
      id: restaurantId,
    });
  }
  return removed.count;
}
