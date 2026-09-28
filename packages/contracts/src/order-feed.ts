import { z } from 'zod';
import { Id, OrderItemState, OrderSource, OrderType, Timestamp } from './common.js';

/**
 * The manager dashboard's live order feed (P4-01, MGR-003): every order with something still
 * waiting for approval, in the kitchen or at the pass, oldest first. The dashboard filters it by
 * station, waiter, source and table, and marks late items with `@rp/domain` `itemDelay` from
 * `settings` and the server's clock, so the marks move on between reads.
 */

/** A dish as the feed shows it; combo parts carry their combo's name, the combo line is left out. */
export const OrderFeedItem = z.object({
  orderItemId: Id,
  name: z.string(),
  variantName: z.string().nullable(),
  quantity: z.int().positive(),
  comboName: z.string().nullable(),
  stationId: Id,
  stationName: z.string(),
  state: OrderItemState,
  /** The published menu's estimated prep time, when it gives one. */
  prepTimeMinutes: z.int().nonnegative().nullable(),
  sentAt: Timestamp.nullable(),
  preparingAt: Timestamp.nullable(),
  readyAt: Timestamp.nullable(),
});
export type OrderFeedItem = z.infer<typeof OrderFeedItem>;

export const OrderFeedEntry = z.object({
  orderId: Id,
  orderNumber: z.int().positive(),
  orderType: OrderType,
  source: OrderSource,
  tableId: Id.nullable(),
  tableLabel: z.string().nullable(),
  takeawayToken: z.int().positive().nullable(),
  /** The table's waiter, or for an order without a table the person who took it. */
  waiterId: Id.nullable(),
  waiterName: z.string().nullable(),
  createdAt: Timestamp,
  /** Its items in the order they were added, without cancelled, voided or rejected ones. */
  items: z.array(OrderFeedItem),
});
export type OrderFeedEntry = z.infer<typeof OrderFeedEntry>;

export const OrderFeedResponse = z.object({
  orders: z.array(OrderFeedEntry),
  /** The restaurant's stations, for the station filter. */
  stations: z.array(z.object({ id: Id, name: z.string() })),
  /** The people serving now (open tables and live orders), for the waiter filter. */
  waiters: z.array(z.object({ id: Id, name: z.string() })),
  /** When an item is late: the kitchen display's settings (`kds.*`). */
  settings: z.object({
    ageRedMinutes: z.int().positive(),
    readyNotCollectedMinutes: z.int().positive(),
  }),
  /** The server's clock, so ages are right even when the screen's clock drifts. */
  serverTime: Timestamp,
});
export type OrderFeedResponse = z.infer<typeof OrderFeedResponse>;
