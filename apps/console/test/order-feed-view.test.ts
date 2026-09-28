import { describe, expect, it } from 'vitest';
import {
  affectsOrderFeed,
  filterFromSearch,
  isFiltered,
  lineName,
  lineTiming,
  orderPlace,
  tableLabelOf,
} from '../src/manage/order-feed-view.js';
import { serverNow } from '../src/manage/use-order-feed.js';
import {
  lassiAtT3,
  naanToken7,
  NOW,
  RAVI,
  SERVICE,
  T1,
  T3,
  TANDOOR,
  tikkaAtT1,
} from './dashboard-fixture.js';
import { t } from './harness.js';

const NOW_MS = Date.parse(NOW);
const THRESHOLDS = SERVICE.settings;

describe('[MGR-003] the order feed’s view helpers', () => {
  it('reads the feed again after order, kitchen, table, menu and settings events only', () => {
    for (const type of [
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
    ]) {
      expect(affectsOrderFeed(type)).toBe(true);
    }
    expect(affectsOrderFeed('AlertRaised')).toBe(false);
    expect(affectsOrderFeed('BillPrinted')).toBe(false);
  });

  it('takes its filters from the address, dropping what the feed does not offer', () => {
    expect(
      filterFromSearch(
        new URLSearchParams(
          `station=${TANDOOR.id}&waiter=${RAVI.id}&source=TABLE_TABLET&table=${T1}&delayed=1`,
        ),
        SERVICE,
      ),
    ).toEqual({
      stationId: TANDOOR.id,
      waiterId: RAVI.id,
      source: 'TABLE_TABLET',
      tableId: T1,
      delayedOnly: true,
    });
    const none = filterFromSearch(
      new URLSearchParams('station=gone&waiter=gone&source=FAX&table=&delayed=yes'),
      SERVICE,
    );
    expect(none).toEqual({
      stationId: undefined,
      waiterId: undefined,
      source: undefined,
      tableId: undefined,
      delayedOnly: false,
    });
    expect(isFiltered(none)).toBe(false);
    expect(isFiltered({ delayedOnly: true })).toBe(true);
    expect(isFiltered({ tableId: T1 })).toBe(true);
  });

  it('names the filtered table from the address, else from its orders', () => {
    expect(tableLabelOf(new URLSearchParams('label=T9'), T1, SERVICE.orders)).toBe('T9');
    expect(tableLabelOf(new URLSearchParams(), T3, SERVICE.orders)).toBe('T3');
    expect(tableLabelOf(new URLSearchParams('label='), 'elsewhere', SERVICE.orders)).toBe('');
  });

  it('says where the food goes and what each line is', () => {
    expect(orderPlace(tikkaAtT1, t)).toBe('Table T1');
    expect(orderPlace(naanToken7, t)).toBe('Token 7');
    expect(orderPlace({ ...naanToken7, takeawayToken: null }, t)).toBe(
      t('dashboard.orders.takeaway'),
    );
    expect(lineName(tikkaAtT1.items[0]!, t)).toBe('2 × Paneer Tikka');
    expect(lineName(lassiAtT3.items[0]!, t)).toBe('1 × Lassi (Sweet)');
  });

  it('gives a dish’s time: late and why, time since sent or ready, or nothing', () => {
    const [paneer, dal] = tikkaAtT1.items;
    expect(lineTiming(paneer!, NOW_MS, THRESHOLDS, t)).toEqual({
      delay: { kind: 'KITCHEN', minutes: 25, allowedMinutes: 15 },
      text: t('dashboard.orders.late.KITCHEN', { minutes: 25, allowed: 15 }),
    });
    expect(lineTiming(dal!, NOW_MS, THRESHOLDS, t)).toEqual({
      delay: null,
      text: t('dashboard.orders.sinceSent', { minutes: 5 }),
    });
    const naan = naanToken7.items[0]!;
    expect(lineTiming(naan, NOW_MS, THRESHOLDS, t).delay?.kind).toBe('PASS');
    expect(lineTiming({ ...naan, readyAt: NOW }, NOW_MS, THRESHOLDS, t)).toEqual({
      delay: null,
      text: t('dashboard.orders.readyFor', { minutes: 0 }),
    });
    expect(lineTiming(lassiAtT3.items[0]!, NOW_MS, THRESHOLDS, t)).toEqual({
      delay: null,
      text: null,
    });
  });

  it('moves the server’s clock on by the time since it answered, never back', () => {
    const received = 1_000_000;
    expect(serverNow(SERVICE, received, received + 90_000)).toBe(NOW_MS + 90_000);
    expect(serverNow(SERVICE, received, received - 5_000)).toBe(NOW_MS);
  });
});
