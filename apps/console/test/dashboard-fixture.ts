import type {
  FloorResponse,
  OrderFeedEntry,
  OrderFeedItem,
  OrderFeedResponse,
  TableOverviewEntry,
  TableOverviewResponse,
} from '@rp/contracts';
import { STAFF } from './fakes.js';

/** A restaurant mid-service for the manager dashboard's tests (P4-01). */

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const NOW = '2026-09-26T10:00:00.000Z';
export const minutesAgo = (minutes: number) =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

export const HALL = uuid(901);
export const TERRACE = uuid(902);
export const T1 = uuid(911);
export const T2 = uuid(912);
export const T3 = uuid(913);

export const TANDOOR = { id: uuid(921), name: 'Tandoor' };
export const MAIN_KITCHEN = { id: uuid(922), name: 'Main kitchen' };
export const BAR = { id: uuid(923), name: 'Bar' };
export const RAVI = { id: STAFF.WAITER.staffId, name: 'Ravi' };
export const SUNIL = { id: uuid(931), name: 'Sunil' };

function floorTable(id: string, label: string, sectionId: string, displayOrder: number) {
  return {
    id,
    label,
    capacity: 4,
    sectionId,
    state: 'FREE' as const,
    displayOrder,
    tabletDeviceIds: [],
    archivedAt: null,
    updatedAt: NOW,
  };
}

export const FLOOR: FloorResponse = {
  sections: [
    {
      id: HALL,
      name: 'Hall',
      displayOrder: 0,
      archivedAt: null,
      updatedAt: NOW,
      tables: [floorTable(T1, 'T1', HALL, 0), floorTable(T2, 'T2', HALL, 1)],
    },
    {
      id: TERRACE,
      name: 'Terrace',
      displayOrder: 1,
      archivedAt: null,
      updatedAt: NOW,
      tables: [floorTable(T3, 'T3', TERRACE, 0)],
    },
  ],
};

function tableEntry(
  tableId: string,
  label: string,
  sectionId: string,
  session?: Partial<NonNullable<TableOverviewEntry['session']>>,
): TableOverviewEntry {
  return {
    tableId,
    label,
    sectionId,
    capacity: 4,
    state: session === undefined ? 'FREE' : 'OCCUPIED',
    session:
      session === undefined
        ? null
        : {
            id: uuid(940 + Number(label.slice(1))),
            // Seated times are counted on the screen's clock, like the POS floor's.
            openedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
            covers: 2,
            waiterId: RAVI.id,
            waiterName: RAVI.name,
            amountSoFar: 45_000,
            pendingApprovals: 0,
            readyItems: 0,
            ...session,
          },
    activeServiceRequests: 0,
  };
}

/** T1 and T3 seated (5 guests), T2 free; the tablet order at T3 waits for approval. */
export const OVERVIEW: TableOverviewResponse = {
  tables: [
    tableEntry(T1, 'T1', HALL, { covers: 3 }),
    tableEntry(T2, 'T2', HALL),
    tableEntry(T3, 'T3', TERRACE, {
      waiterId: SUNIL.id,
      waiterName: SUNIL.name,
      pendingApprovals: 1,
    }),
  ],
};

export function feedItem(
  n: number,
  station: { id: string; name: string },
  overrides: Partial<OrderFeedItem>,
): OrderFeedItem {
  return {
    orderItemId: uuid(950 + n),
    name: 'Dish',
    variantName: null,
    quantity: 1,
    comboName: null,
    stationId: station.id,
    stationName: station.name,
    state: 'SENT',
    prepTimeMinutes: null,
    sentAt: minutesAgo(1),
    preparingAt: null,
    readyAt: null,
    ...overrides,
  };
}

/** Order 12 at T1: the tikka is late in the tandoor (25 min, 15 expected), the dal is not. */
export const tikkaAtT1: OrderFeedEntry = {
  orderId: uuid(961),
  orderNumber: 12,
  orderType: 'DINE_IN',
  source: 'WAITER_APP',
  tableId: T1,
  tableLabel: 'T1',
  takeawayToken: null,
  waiterId: RAVI.id,
  waiterName: RAVI.name,
  createdAt: minutesAgo(26),
  items: [
    feedItem(1, TANDOOR, {
      name: 'Paneer Tikka',
      quantity: 2,
      state: 'PREPARING',
      prepTimeMinutes: 15,
      sentAt: minutesAgo(25),
      preparingAt: minutesAgo(20),
    }),
    feedItem(2, MAIN_KITCHEN, {
      name: 'Dal Makhani',
      prepTimeMinutes: 20,
      sentAt: minutesAgo(5),
    }),
  ],
};

/** Takeaway token 7: its naan has waited at the pass 5 min (3 allowed). */
export const naanToken7: OrderFeedEntry = {
  orderId: uuid(962),
  orderNumber: 13,
  orderType: 'TAKEAWAY',
  source: 'POS',
  tableId: null,
  tableLabel: null,
  takeawayToken: 7,
  waiterId: null,
  waiterName: null,
  createdAt: minutesAgo(15),
  items: [
    feedItem(3, TANDOOR, {
      name: 'Butter Naan',
      quantity: 3,
      state: 'READY',
      prepTimeMinutes: 8,
      sentAt: minutesAgo(14),
      readyAt: minutesAgo(5),
    }),
  ],
};

/** Order 14 from the T3 tablet: a combo's lassi, waiting for the waiter's approval. */
export const lassiAtT3: OrderFeedEntry = {
  orderId: uuid(963),
  orderNumber: 14,
  orderType: 'DINE_IN',
  source: 'TABLE_TABLET',
  tableId: T3,
  tableLabel: 'T3',
  takeawayToken: null,
  waiterId: SUNIL.id,
  waiterName: SUNIL.name,
  createdAt: minutesAgo(1),
  items: [
    feedItem(4, BAR, {
      name: 'Lassi',
      variantName: 'Sweet',
      comboName: 'Thali Combo',
      state: 'PENDING_APPROVAL',
      sentAt: null,
    }),
  ],
};

export function feed(...orders: OrderFeedEntry[]): OrderFeedResponse {
  return {
    orders,
    stations: [BAR, MAIN_KITCHEN, TANDOOR],
    waiters: [RAVI, SUNIL],
    settings: { ageRedMinutes: 20, readyNotCollectedMinutes: 3 },
    serverTime: NOW,
  };
}

export const SERVICE = feed(tikkaAtT1, naanToken7, lassiAtT3);
