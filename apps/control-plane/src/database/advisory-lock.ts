import type { TransactionClient } from './prisma.service.js';

/**
 * Holds a lock on `key` until the transaction ends, so a count and the row it allows are one step
 * (a daily limit, a number in sequence). Transactions with other keys are not held up.
 */
export async function lockFor(tx: TransactionClient, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
