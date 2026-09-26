import type { OrderView } from '@rp/contracts';
import type { OrderItemState } from '@rp/domain';

type Item = OrderView['items'][number];

/** How far along the kitchen and floor an item is; ended states are not steps. */
const PROGRESS: Partial<Record<OrderItemState, number>> = {
  PENDING_APPROVAL: 0,
  SENT: 1,
  PREPARING: 2,
  READY: 3,
  PICKED_UP: 4,
  SERVED: 5,
};

/**
 * The state to show for a line (ORD-010). The kitchen moves a combo's parts, which are what its
 * tickets list, so a combo line shows its least advanced part that is still going; a line
 * without parts shows its own state.
 */
export function displayState(item: Item, items: readonly Item[]): OrderItemState {
  const parts = items.filter(
    (part) => part.parentOrderItemId === item.id && PROGRESS[part.state] !== undefined,
  );
  if (parts.length === 0 || PROGRESS[item.state] === undefined) return item.state;
  return parts.reduce((least, part) =>
    (PROGRESS[part.state] ?? 0) < (PROGRESS[least.state] ?? 0) ? part : least,
  ).state;
}
