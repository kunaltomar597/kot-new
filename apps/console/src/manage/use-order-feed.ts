import type { OrderFeedResponse } from '@rp/contracts';
import { useConsole } from '../app/console-context.js';
import { type LiveData, useLive } from '../app/use-live.js';
import { affectsOrderFeed } from './order-feed-view.js';

export type OrderFeedData = LiveData<{
  readonly feed: OrderFeedResponse;
  /** When the answer arrived, to move the server's clock on between reads. */
  readonly receivedAt: number;
}>;

/** The live order feed (MGR-003), read again after order, kitchen and table events. */
export function useOrderFeed(): { data: OrderFeedData; reload: () => void } {
  const controller = useConsole();
  return useLive(
    async () => ({ feed: await controller.api.getOrderFeed(), receivedAt: Date.now() }),
    affectsOrderFeed,
  );
}

/** The server's time now: its clock when it answered, moved on by the time since (KDS-004). */
export function serverNow(feed: OrderFeedResponse, receivedAt: number, now: number): number {
  return Date.parse(feed.serverTime) + Math.max(0, now - receivedAt);
}
