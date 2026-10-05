import { currentBusinessDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import type { TransactionClient } from '../database/prisma.service.js';
import { appendEvent } from '../events/outbox.js';

export type DraftPart = 'CATEGORIES' | 'MODIFIER_GROUPS' | 'ITEMS';

/**
 * Tells every open menu editor that the draft changed (`MenuDraftChanged`, in the transaction;
 * P4-02d), so a second manager's editor and its "changes not published" note keep up. The menu
 * import writes many entries and then publishes, so it announces nothing of its own.
 */
export async function announceDraftChange(
  tx: TransactionClient,
  restaurantId: string,
  part: DraftPart,
): Promise<void> {
  await appendEvent(
    tx,
    {
      eventId: newId(),
      type: 'MenuDraftChanged',
      version: 1,
      occurredAt: new Date().toISOString(),
      restaurantId,
      businessDate: await currentBusinessDate(tx, restaurantId),
      payload: { part },
    },
    { aggregate: { type: 'menu_draft', id: restaurantId } },
  );
}
