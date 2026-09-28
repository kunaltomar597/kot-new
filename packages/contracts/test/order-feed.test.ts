import { grantFor, ROLES } from '@rp/domain';
import { describe, expect, it } from 'vitest';
import { OrderFeedResponse, ROUTES } from '../src/index.js';

const ORDER = '0199a0e0-0000-7000-8000-000000000001';
const LINE = '0199a0e0-0000-7000-8000-000000000002';
const STATION = '0199a0e0-0000-7000-8000-000000000003';
const TABLE = '0199a0e0-0000-7000-8000-000000000004';
const WAITER = '0199a0e0-0000-7000-8000-000000000005';

const feed = {
  orders: [
    {
      orderId: ORDER,
      orderNumber: 12,
      orderType: 'DINE_IN',
      source: 'WAITER_APP',
      tableId: TABLE,
      tableLabel: 'T4',
      takeawayToken: null,
      waiterId: WAITER,
      waiterName: 'Ravi',
      createdAt: '2026-10-02T13:40:00.000Z',
      items: [
        {
          orderItemId: LINE,
          name: 'Chicken Tikka',
          variantName: 'Full',
          quantity: 2,
          comboName: null,
          stationId: STATION,
          stationName: 'Kitchen',
          state: 'PREPARING',
          prepTimeMinutes: 15,
          sentAt: '2026-10-02T13:40:01.000Z',
          preparingAt: '2026-10-02T13:42:00.000Z',
          readyAt: null,
        },
      ],
    },
  ],
  stations: [{ id: STATION, name: 'Kitchen' }],
  waiters: [{ id: WAITER, name: 'Ravi' }],
  settings: { ageRedMinutes: 20, readyNotCollectedMinutes: 3 },
  serverTime: '2026-10-02T14:00:00.000Z',
};

describe('[MGR-003] the live order feed', () => {
  it('carries each dish’s station, state and kitchen times, and what the filters offer', () => {
    expect(OrderFeedResponse.parse(feed)).toEqual(feed);
    const [order] = feed.orders;
    const takeaway = {
      ...order,
      orderType: 'TAKEAWAY',
      tableId: null,
      tableLabel: null,
      takeawayToken: 7,
      waiterId: null,
      waiterName: null,
    };
    expect(OrderFeedResponse.safeParse({ ...feed, orders: [takeaway] }).success).toBe(true);
  });

  it('refuses a dish without its times or with an unknown state', () => {
    const [order] = feed.orders;
    const [line] = order?.items ?? [];
    for (const wrong of [
      { ...line, sentAt: undefined },
      { ...line, state: 'COOKING' },
      { ...line, prepTimeMinutes: -1 },
      { ...line, quantity: 0 },
    ]) {
      const orders = [{ ...order, items: [wrong] }];
      expect(OrderFeedResponse.safeParse({ ...feed, orders }).success).toBe(false);
    }
  });

  it('[MGR-001] is for the manager and the owner only', () => {
    const route = ROUTES.find((entry) => entry.operationId === 'getOrderFeed');
    expect(route?.capability).toBe('OPERATIONS_CONFIGURE');
    const allowed = ROLES.filter((role) => grantFor(role, 'OPERATIONS_CONFIGURE') !== 'DENY');
    expect(allowed).toEqual(['OWNER', 'MANAGER']);
  });
});
