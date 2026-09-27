import type { OrderFeedEntry, OrderFeedItem, OrderFeedResponse } from '@rp/contracts';
import {
  type DelayThresholds,
  type ItemDelay,
  itemDelay,
  minutesSince,
  ORDER_SOURCES,
  type OrderFeedFilter,
  type OrderSource,
} from '@rp/domain';
import type { Translator } from '@rp/i18n';

/** Events after which the live order feed is read again (MGR-003). */
const FEED_EVENTS: ReadonlySet<string> = new Set([
  'OrderSubmitted',
  'OrderApproved',
  'OrderRejected',
  'KotCreated',
  'ItemStatusChanged',
  'TableMoved',
  'TableClosed',
  'TableWaiterChanged',
  'MenuPublished',
  'SettingsChanged',
]);

export function affectsOrderFeed(eventType: string): boolean {
  return FEED_EVENTS.has(eventType);
}

/**
 * The feed's filters live in the page's address (`?station=…&waiter=…&source=…&table=…&delayed=1`)
 * so a filtered view survives a reload and the overview can link to a table's orders.
 */
export const FILTER_PARAMS = {
  station: 'station',
  waiter: 'waiter',
  source: 'source',
  table: 'table',
  /** The table's label, carried with its id so it can be named while it has no orders. */
  tableLabel: 'label',
  delayed: 'delayed',
} as const;

function isSource(value: string | null): value is OrderSource {
  return value !== null && (ORDER_SOURCES as readonly string[]).includes(value);
}

/**
 * The filter the address asks for. A station or waiter the feed does not offer (a station
 * archived, a waiter gone home) is dropped rather than applied unseen.
 */
export function filterFromSearch(search: URLSearchParams, feed: OrderFeedResponse): OrderFeedFilter {
  const station = search.get(FILTER_PARAMS.station);
  const waiter = search.get(FILTER_PARAMS.waiter);
  const source = search.get(FILTER_PARAMS.source);
  const table = search.get(FILTER_PARAMS.table);
  return {
    stationId: feed.stations.some((option) => option.id === station)
      ? (station ?? undefined)
      : undefined,
    waiterId: feed.waiters.some((option) => option.id === waiter) ? (waiter ?? undefined) : undefined,
    source: isSource(source) ? source : undefined,
    tableId: table === null || table === '' ? undefined : table,
    delayedOnly: search.get(FILTER_PARAMS.delayed) === '1',
  };
}

export function isFiltered(filter: OrderFeedFilter): boolean {
  return (
    filter.stationId !== undefined ||
    filter.waiterId !== undefined ||
    filter.source !== undefined ||
    filter.tableId !== undefined ||
    filter.delayedOnly === true
  );
}

/** The table's label for "Showing table T4": from the address, else from its orders. */
export function tableLabelOf(
  search: URLSearchParams,
  tableId: string,
  orders: readonly OrderFeedEntry[],
): string {
  const given = search.get(FILTER_PARAMS.tableLabel);
  if (given !== null && given !== '') return given;
  return orders.find((order) => order.tableId === tableId)?.tableLabel ?? '';
}

/** Where the food goes: "Table T4", or "Token 12" for a takeaway. */
export function orderPlace(order: OrderFeedEntry, t: Translator): string {
  if (order.tableLabel !== null) return t('dashboard.orders.atTable', { table: order.tableLabel });
  if (order.takeawayToken !== null) {
    return t('dashboard.orders.token', { token: order.takeawayToken });
  }
  return t('dashboard.orders.takeaway');
}

/** "2 × Chicken Tikka (Full)". */
export function lineName(item: OrderFeedItem, t: Translator): string {
  const name = item.variantName === null ? item.name : `${item.name} (${item.variantName})`;
  return t('dashboard.orders.line', { quantity: item.quantity, name });
}

export interface LineTiming {
  /** What to say about the dish's time, or null when there is nothing to say. */
  readonly text: string | null;
  readonly delay: ItemDelay | null;
}

/**
 * A dish's time in words: late (and why), else how long since it was sent or has been ready.
 * Waiting for approval, picked up and served dishes need no clock.
 */
export function lineTiming(
  item: OrderFeedItem,
  nowMs: number,
  thresholds: DelayThresholds,
  t: Translator,
): LineTiming {
  const delay = itemDelay(item, nowMs, thresholds);
  if (delay !== null) {
    return {
      delay,
      text: t(`dashboard.orders.late.${delay.kind}`, {
        minutes: delay.minutes,
        allowed: delay.allowedMinutes,
      }),
    };
  }
  if ((item.state === 'SENT' || item.state === 'PREPARING') && item.sentAt !== null) {
    return {
      delay,
      text: t('dashboard.orders.sinceSent', { minutes: minutesSince(item.sentAt, nowMs) }),
    };
  }
  if (item.state === 'READY' && item.readyAt !== null) {
    return {
      delay,
      text: t('dashboard.orders.readyFor', { minutes: minutesSince(item.readyAt, nowMs) }),
    };
  }
  return { delay, text: null };
}
