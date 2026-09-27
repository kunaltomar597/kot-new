import type { OrderItemState, OrderSource } from './machines/order-item.js';

/**
 * The live order feed of the manager dashboard (P4-01, MGR-003): every order with something still
 * on its way, each item's kitchen status, and the items that are late. Pure, so the server, the
 * console and any later screen agree on what "late" means.
 */

/**
 * Item states that keep an order in the feed: waiting for staff approval, in the kitchen, or ready
 * at the pass. Picked up, served and ended items are shown with their order but keep nothing in it.
 */
export const LIVE_ITEM_STATES = [
  'PENDING_APPROVAL',
  'SENT',
  'PREPARING',
  'READY',
] as const satisfies readonly OrderItemState[];

const LIVE: ReadonlySet<OrderItemState> = new Set(LIVE_ITEM_STATES);

export function isLiveItem(state: OrderItemState): boolean {
  return LIVE.has(state);
}

/** When an item is late: the kitchen display's own settings, so both screens agree. */
export interface DelayThresholds {
  /** `kds.ageRedMinutes`: how long an item without a prep time may take (its ticket turns red). */
  readonly ageRedMinutes: number;
  /** `kds.readyNotCollectedMinutes`: how long ready food may wait at the pass (KDS-006). */
  readonly readyNotCollectedMinutes: number;
}

/** What tells whether an item is late. Times are ISO 8601 instants. */
export interface FeedItemTiming {
  readonly state: OrderItemState;
  /** When the kitchen got it: at submission for staff orders, at approval for customer orders. */
  readonly sentAt: string | null;
  readonly readyAt: string | null;
  /** The menu's estimated prep time; null (or 0) when the menu gives none. */
  readonly prepTimeMinutes: number | null;
}

/**
 * Why an item is late: in the kitchen (waiting or cooking) for its prep time or longer, or, with
 * no prep time, for the kitchen's red age; or ready at the pass for `readyNotCollectedMinutes`.
 * `minutes` is how long so far, `allowedMinutes` the limit it reached.
 */
export type ItemDelay =
  | { readonly kind: 'KITCHEN'; readonly minutes: number; readonly allowedMinutes: number }
  | { readonly kind: 'PASS'; readonly minutes: number; readonly allowedMinutes: number };

const MINUTE_MS = 60_000;

/** Whole minutes from an instant to now, never negative (a clock a little ahead counts 0). */
export function minutesSince(at: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(at)) / MINUTE_MS));
}

/** How an item is late, or null while it is on time or out of the kitchen's hands. */
export function itemDelay(
  item: FeedItemTiming,
  nowMs: number,
  thresholds: DelayThresholds,
): ItemDelay | null {
  if ((item.state === 'SENT' || item.state === 'PREPARING') && item.sentAt !== null) {
    const allowedMinutes =
      item.prepTimeMinutes !== null && item.prepTimeMinutes > 0
        ? item.prepTimeMinutes
        : thresholds.ageRedMinutes;
    const minutes = minutesSince(item.sentAt, nowMs);
    return minutes >= allowedMinutes ? { kind: 'KITCHEN', minutes, allowedMinutes } : null;
  }
  if (item.state === 'READY' && item.readyAt !== null) {
    const allowedMinutes = thresholds.readyNotCollectedMinutes;
    const minutes = minutesSince(item.readyAt, nowMs);
    return minutes >= allowedMinutes ? { kind: 'PASS', minutes, allowedMinutes } : null;
  }
  return null;
}

export interface FeedItem extends FeedItemTiming {
  readonly stationId: string;
}

export interface FeedOrder {
  readonly source: OrderSource;
  readonly tableId: string | null;
  /** The table's waiter, or for an order without a table the person who took it. */
  readonly waiterId: string | null;
  readonly items: readonly FeedItem[];
}

/** The dashboard's filters (MGR-003), in any combination; one left out means all. */
export interface OrderFeedFilter {
  readonly stationId?: string | undefined;
  readonly waiterId?: string | undefined;
  readonly source?: OrderSource | undefined;
  readonly tableId?: string | undefined;
  /** Only orders with a late item (among the station's items when a station is chosen). */
  readonly delayedOnly?: boolean | undefined;
}

/**
 * The orders a filter keeps, in their order. A station keeps only its own items, so an order
 * shows what that station still has to do; an order stays while one of its kept items is live.
 */
export function filterOrderFeed<O extends FeedOrder>(
  orders: readonly O[],
  filter: OrderFeedFilter,
  nowMs: number,
  thresholds: DelayThresholds,
): O[] {
  const kept: O[] = [];
  for (const order of orders) {
    if (filter.source !== undefined && order.source !== filter.source) continue;
    if (filter.waiterId !== undefined && order.waiterId !== filter.waiterId) continue;
    if (filter.tableId !== undefined && order.tableId !== filter.tableId) continue;
    const items =
      filter.stationId === undefined
        ? order.items
        : order.items.filter((item) => item.stationId === filter.stationId);
    if (!items.some((item) => isLiveItem(item.state))) continue;
    if (
      filter.delayedOnly === true &&
      !items.some((item) => itemDelay(item, nowMs, thresholds) !== null)
    ) {
      continue;
    }
    kept.push(items.length === order.items.length ? order : { ...order, items });
  }
  return kept;
}

/** The feed at a glance. Items are counted as lines: "2 × Butter Naan" is one. */
export interface OrderFeedSummary {
  readonly orders: number;
  /** Tablet and QR lines waiting for a person to approve them (ORD-003). */
  readonly awaitingApproval: number;
  /** Lines the kitchen has: sent, or being prepared. */
  readonly inKitchen: number;
  /** Lines ready at the pass. */
  readonly ready: number;
  /** Late lines, in the kitchen or at the pass. */
  readonly delayed: number;
}

export function summarizeOrderFeed(
  orders: readonly FeedOrder[],
  nowMs: number,
  thresholds: DelayThresholds,
): OrderFeedSummary {
  let awaitingApproval = 0;
  let inKitchen = 0;
  let ready = 0;
  let delayed = 0;
  for (const order of orders) {
    for (const item of order.items) {
      if (item.state === 'PENDING_APPROVAL') awaitingApproval += 1;
      else if (item.state === 'SENT' || item.state === 'PREPARING') inKitchen += 1;
      else if (item.state === 'READY') ready += 1;
      if (itemDelay(item, nowMs, thresholds) !== null) delayed += 1;
    }
  }
  return { orders: orders.length, awaitingApproval, inKitchen, ready, delayed };
}
