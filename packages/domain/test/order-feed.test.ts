import { describe, expect, it } from 'vitest';
import {
  type DelayThresholds,
  type FeedItem,
  type FeedOrder,
  filterOrderFeed,
  isLiveItem,
  itemDelay,
  LIVE_ITEM_STATES,
  minutesSince,
  ORDER_ITEM_STATES,
  summarizeOrderFeed,
} from '../src/index.js';

const NOW = Date.parse('2026-10-02T14:00:00.000Z');
const ago = (minutes: number, seconds = 0) =>
  new Date(NOW - minutes * 60_000 - seconds * 1000).toISOString();
const thresholds: DelayThresholds = { ageRedMinutes: 20, readyNotCollectedMinutes: 3 };

const item = (changes: Partial<FeedItem> = {}): FeedItem => ({
  state: 'SENT',
  sentAt: ago(1),
  readyAt: null,
  prepTimeMinutes: null,
  stationId: 'kitchen',
  ...changes,
});

describe('[MGR-003] which items are late', () => {
  it('counts whole minutes, never below zero', () => {
    expect(minutesSince(ago(4, 59), NOW)).toBe(4);
    expect(minutesSince(ago(5), NOW)).toBe(5);
    expect(minutesSince(new Date(NOW + 30_000).toISOString(), NOW)).toBe(0);
  });

  it('marks a dish late once it has been in the kitchen for its prep time', () => {
    const tikka = item({ prepTimeMinutes: 12, sentAt: ago(11, 59) });
    expect(itemDelay(tikka, NOW, thresholds)).toBeNull();
    expect(itemDelay({ ...tikka, sentAt: ago(12) }, NOW, thresholds)).toEqual({
      kind: 'KITCHEN',
      minutes: 12,
      allowedMinutes: 12,
    });
    // Waiting to be started counts the same as cooking: the clock runs from when it was sent.
    expect(itemDelay({ ...tikka, state: 'PREPARING', sentAt: ago(15) }, NOW, thresholds)).toEqual({
      kind: 'KITCHEN',
      minutes: 15,
      allowedMinutes: 12,
    });
  });

  it('uses the kitchen display’s red age for a dish with no prep time', () => {
    for (const prepTimeMinutes of [null, 0]) {
      const naan = item({ prepTimeMinutes, sentAt: ago(19) });
      expect(itemDelay(naan, NOW, thresholds)).toBeNull();
      expect(itemDelay({ ...naan, sentAt: ago(20) }, NOW, thresholds)).toEqual({
        kind: 'KITCHEN',
        minutes: 20,
        allowedMinutes: 20,
      });
    }
  });

  it('marks ready food late when it waits at the pass, whatever its prep time', () => {
    const ready = item({ state: 'READY', sentAt: ago(40), readyAt: ago(2), prepTimeMinutes: 10 });
    expect(itemDelay(ready, NOW, thresholds)).toBeNull();
    expect(itemDelay({ ...ready, readyAt: ago(3) }, NOW, thresholds)).toEqual({
      kind: 'PASS',
      minutes: 3,
      allowedMinutes: 3,
    });
  });

  it('never marks what is out of the kitchen’s hands, or not sent yet', () => {
    for (const state of [
      'PENDING_APPROVAL',
      'PICKED_UP',
      'SERVED',
      'CANCELLED',
      'VOIDED',
    ] as const) {
      expect(itemDelay(item({ state, sentAt: ago(90), readyAt: ago(60) }), NOW, thresholds)).toBe(
        null,
      );
    }
    expect(itemDelay(item({ sentAt: null }), NOW, thresholds)).toBeNull();
    expect(itemDelay(item({ state: 'READY', readyAt: null }), NOW, thresholds)).toBeNull();
  });
});

describe('[MGR-003] the live order feed and its filters', () => {
  interface Order extends FeedOrder {
    readonly id: string;
  }
  const t1: Order = {
    id: 't1',
    source: 'POS',
    tableId: 'table-1',
    waiterId: 'ravi',
    items: [
      item({ stationId: 'kitchen', state: 'PREPARING', sentAt: ago(25) }),
      item({ stationId: 'bar', state: 'SERVED', sentAt: ago(25), readyAt: ago(20) }),
    ],
  };
  const t2: Order = {
    id: 't2',
    source: 'TABLE_TABLET',
    tableId: 'table-2',
    waiterId: 'meena',
    items: [
      item({ stationId: 'bar', state: 'READY', sentAt: ago(6), readyAt: ago(1) }),
      item({ stationId: 'kitchen', state: 'PENDING_APPROVAL', sentAt: null }),
    ],
  };
  const takeaway: Order = {
    id: 'takeaway',
    source: 'WAITER_APP',
    tableId: null,
    waiterId: 'ravi',
    items: [item({ stationId: 'kitchen', state: 'SENT', sentAt: ago(2) })],
  };
  const feed = [t1, t2, takeaway];
  const ids = (orders: readonly Order[]) => orders.map((order) => order.id);

  it('keeps an order while something on it waits for approval, cooks or waits at the pass', () => {
    expect(LIVE_ITEM_STATES).toEqual(['PENDING_APPROVAL', 'SENT', 'PREPARING', 'READY']);
    expect(ORDER_ITEM_STATES.filter(isLiveItem)).toEqual([...LIVE_ITEM_STATES]);
    expect(ids(filterOrderFeed(feed, {}, NOW, thresholds))).toEqual(['t1', 't2', 'takeaway']);
  });

  it('filters by source, waiter and table, keeping the feed’s order', () => {
    expect(ids(filterOrderFeed(feed, { source: 'TABLE_TABLET' }, NOW, thresholds))).toEqual(['t2']);
    expect(ids(filterOrderFeed(feed, { waiterId: 'ravi' }, NOW, thresholds))).toEqual([
      't1',
      'takeaway',
    ]);
    expect(ids(filterOrderFeed(feed, { tableId: 'table-2' }, NOW, thresholds))).toEqual(['t2']);
    expect(
      filterOrderFeed(feed, { waiterId: 'ravi', source: 'TABLE_TABLET' }, NOW, thresholds),
    ).toEqual([]);
  });

  it('shows a station only its own items, and only orders where it still has something to do', () => {
    const bar = filterOrderFeed(feed, { stationId: 'bar' }, NOW, thresholds);
    // Table 1's drink is served: nothing left for the bar there.
    expect(ids(bar)).toEqual(['t2']);
    expect(bar[0]?.items.map((line) => line.state)).toEqual(['READY']);
    const kitchen = filterOrderFeed(feed, { stationId: 'kitchen' }, NOW, thresholds);
    expect(ids(kitchen)).toEqual(['t1', 't2', 'takeaway']);
    expect(kitchen[0]?.items).toHaveLength(1);
    // The unfiltered order object is reused when nothing is taken out of it.
    expect(kitchen[2]).toBe(takeaway);
  });

  it('shows only the late orders when asked, per station', () => {
    expect(ids(filterOrderFeed(feed, { delayedOnly: true }, NOW, thresholds))).toEqual(['t1']);
    expect(filterOrderFeed(feed, { delayedOnly: true, stationId: 'bar' }, NOW, thresholds)).toEqual(
      [],
    );
    const later = NOW + 3 * 60_000;
    expect(
      ids(filterOrderFeed(feed, { delayedOnly: true, stationId: 'bar' }, later, thresholds)),
    ).toEqual(['t2']);
  });

  it('sums up the feed: approvals, kitchen, pass and late lines', () => {
    expect(summarizeOrderFeed(feed, NOW, thresholds)).toEqual({
      orders: 3,
      awaitingApproval: 1,
      inKitchen: 2,
      ready: 1,
      delayed: 1,
    });
    expect(summarizeOrderFeed([], NOW, thresholds)).toEqual({
      orders: 0,
      awaitingApproval: 0,
      inKitchen: 0,
      ready: 0,
      delayed: 0,
    });
  });
});
