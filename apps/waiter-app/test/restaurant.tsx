import type {
  FloorResponse,
  MenuSnapshot,
  MyPagerResponse,
  OrderView,
  PagerView,
  SubmitOrderRequest,
  SubmitOrderResponse,
  TableOverviewEntry,
  TableSessionView,
  WaiterAssignmentsResponse,
} from '@rp/contracts';
import { createTranslator } from '@rp/i18n';
import { DeviceSession, MemoryStore } from '@rp/mobile-core';
import {
  FakeKeys,
  fakeLocalServer,
  type FakeServer,
  type RecordedCall,
  SocketFactory,
  STAFF,
} from '@rp/mobile-core/testing';
import { IDS, MENU } from '@rp/ordering/testing';
import { render } from '@testing-library/react-native';
import { App } from '../src/App';

/**
 * A small restaurant behind the fake local server: two sections, five tables, one pager, the
 * shared test menu, and a kitchen that takes orders once per idempotency key.
 */

export const translator = createTranslator();
const id = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-09-26T08:00:00.000Z';

export const HALL = id(8001);
export const TERRACE = id(8002);
export const RAVI = STAFF.WAITER.staffId;
export const KIRAN = id(8003);
export const PAGER_ID = id(8004);
export const T2_SESSION = id(9002);
export { IDS };

interface Table {
  readonly id: string;
  readonly label: string;
  readonly sectionId: string;
  state: TableOverviewEntry['state'];
  session: TableOverviewEntry['session'];
  requests: number;
}

function session(n: number, waiterId: string, covers: number): TableOverviewEntry['session'] {
  return {
    id: id(n),
    openedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
    covers,
    waiterId,
    waiterName: waiterId === RAVI ? 'Ravi' : 'Kiran',
    amountSoFar: 64_000,
    pendingApprovals: 0,
  };
}

export class Restaurant {
  readonly tables: Table[] = [
    { id: id(1), label: 'T1', sectionId: HALL, state: 'FREE', session: null, requests: 0 },
    {
      id: id(2),
      label: 'T2',
      sectionId: HALL,
      state: 'OCCUPIED',
      session: session(9002, RAVI, 3),
      requests: 1,
    },
    {
      id: id(3),
      label: 'T3',
      sectionId: HALL,
      state: 'BILL_REQUESTED',
      session: session(9003, RAVI, 2),
      requests: 0,
    },
    { id: id(4), label: 'T4', sectionId: TERRACE, state: 'FREE', session: null, requests: 0 },
    {
      id: id(5),
      label: 'T5',
      sectionId: TERRACE,
      state: 'OCCUPIED',
      session: session(9005, KIRAN, 4),
      requests: 0,
    },
  ];
  pager: PagerView | null = {
    deviceId: PAGER_ID,
    name: 'Pager 3',
    serial: 'WP-0003',
    staffId: RAVI,
    online: true,
    batteryPercent: 80,
    rssi: -60,
    firmwareVersion: '1.0.3',
    lastSeenAt: AT,
  };
  /** Ravi looks after the hall today. */
  assignments: WaiterAssignmentsResponse['current']['assignments'] = [
    { staffId: RAVI, staffName: 'Ravi', sectionIds: [HALL], tableIds: [] },
  ];

  /** The menu the server hands out; tests change it as the kitchen runs out. */
  menu: MenuSnapshot = MENU;
  /** Orders by table session, as the server has them. */
  readonly orders = new Map<string, OrderView[]>();
  /** Answers already given, by idempotency key (ORD-013). */
  readonly answers = new Map<string, SubmitOrderResponse>();
  /** No answer reaches the phone: `down` fails before the server, `loseAnswers` after it. */
  network: 'up' | 'down' | 'loseAnswers' = 'up';
  private nextOrder = 20;

  table(label: string): Table {
    const found = this.tables.find((table) => table.label === label);
    if (found === undefined) throw new Error(`No table ${label}`);
    return found;
  }

  overview(): { tables: TableOverviewEntry[] } {
    return {
      tables: this.tables.map((table) => ({
        tableId: table.id,
        label: table.label,
        sectionId: table.sectionId,
        capacity: 4,
        state: table.state,
        session: table.session,
        activeServiceRequests: table.requests,
      })),
    };
  }

  floor(): FloorResponse {
    return {
      sections: [
        [HALL, 'Hall'],
        [TERRACE, 'Terrace'],
      ].map(([sectionId, name], index) => ({
        id: sectionId ?? '',
        name: name ?? '',
        displayOrder: index,
        archivedAt: null,
        updatedAt: AT,
        tables: this.tables
          .filter((table) => table.sectionId === sectionId)
          .map((table, order) => ({
            id: table.id,
            label: table.label,
            capacity: 4,
            sectionId: table.sectionId,
            state: table.state,
            displayOrder: order,
            tabletDeviceIds: [],
            archivedAt: null,
            updatedAt: AT,
          })),
      })),
    };
  }

  sessionView(table: Table): TableSessionView {
    const open = table.session;
    if (open === null) throw new Error(`${table.label} is not open`);
    return {
      id: open.id,
      tableId: table.id,
      tableLabel: table.label,
      state: table.state,
      status: 'OPEN',
      covers: open.covers,
      waiterId: open.waiterId,
      waiterName: open.waiterName,
      businessDate: '2026-09-26',
      openedAt: open.openedAt,
      closedAt: null,
      closeReason: null,
    };
  }

  /** Takes an order like the server: once per key, refusing lines the kitchen cannot make. */
  submitOrder(request: SubmitOrderRequest): SubmitOrderResponse {
    const seen = this.answers.get(request.idempotencyKey);
    if (seen !== undefined) return seen.status === 'ACCEPTED' ? { ...seen, replayed: true } : seen;
    const rejectedLines = request.lines.flatMap((line) => {
      const item = this.menu.items.find((candidate) => candidate.id === line.itemId);
      if (item !== undefined && item.available && item.stockCount !== 0) return [];
      return [
        {
          clientLineId: line.clientLineId,
          code: 'OUT_OF_STOCK' as const,
          message: `${item?.name ?? 'This dish'} is sold out.`,
        },
      ];
    });
    // A refused order is not remembered, as on the server: it can be changed and sent again.
    if (rejectedLines.length > 0) return { status: 'PARTIALLY_REJECTED', rejectedLines };
    const sessionId = request.tableSessionId ?? '';
    this.nextOrder += 1;
    const orderId = id(7000 + this.nextOrder);
    const items: OrderView['items'] = request.lines.map((line, index) => {
      const item = this.menu.items.find((candidate) => candidate.id === line.itemId);
      const variant = item?.variants.find((candidate) => candidate.id === line.variantId);
      const options = this.menu.modifierGroups.flatMap((group) => group.options);
      return {
        id: id(7100 + this.nextOrder * 10 + index),
        itemId: line.itemId,
        parentOrderItemId: null,
        name: item?.name ?? '',
        variantId: variant?.id ?? null,
        variantName: variant?.name ?? null,
        modifiers: line.modifiers.flatMap((group) =>
          group.optionIds.map((optionId) => ({
            optionId,
            name: options.find((option) => option.id === optionId)?.name ?? '',
            priceDelta: 0,
          })),
        ),
        quantity: line.quantity,
        unitPrice: item?.basePrice ?? 0,
        lineTotal: (item?.basePrice ?? 0) * line.quantity,
        stationId: IDS.kitchen,
        state: 'SENT',
        instructions: line.instructions ?? null,
      };
    });
    const order: OrderView = {
      id: orderId,
      orderNumber: this.nextOrder,
      orderType: 'DINE_IN',
      source: request.source,
      status: 'OPEN',
      tableSessionId: sessionId,
      tableId: null,
      takeawayToken: null,
      customerName: null,
      businessDate: '2026-09-26',
      createdAt: AT,
      note: null,
      items,
      kots: [
        {
          id: id(7200 + this.nextOrder),
          kotNumber: this.nextOrder,
          stationId: IDS.kitchen,
          stationName: 'Kitchen',
          kind: 'NEW',
          printStatus: 'NOT_REQUIRED',
        },
      ],
    };
    this.orders.set(sessionId, [...(this.orders.get(sessionId) ?? []), order]);
    const answer: SubmitOrderResponse = {
      status: 'ACCEPTED',
      orderId,
      orderNumber: order.orderNumber,
      replayed: false,
      itemState: 'SENT',
    };
    this.answers.set(request.idempotencyKey, answer);
    return answer;
  }

  /** Every order the server has made, whichever table. */
  allOrders(): OrderView[] {
    return [...this.orders.values()].flat();
  }

  /** The local server as the waiter app sees it; table actions change the restaurant. */
  server(): FakeServer {
    return fakeLocalServer()
      .on('GET', '/api/v1/tables/overview', () => ({ status: 200, body: this.overview() }))
      .on('GET', '/api/v1/floor', () => ({ status: 200, body: this.floor() }))
      .on('GET', '/api/v1/waiter-assignments', () => ({
        status: 200,
        body: {
          current: { businessDate: '2026-09-26', assignments: this.assignments },
          previous: null,
        } satisfies WaiterAssignmentsResponse,
      }))
      .on('GET', '/api/v1/menu', () => ({ status: 200, body: this.menu }))
      .on('POST', '/api/v1/orders', (call: RecordedCall) => {
        if (this.network === 'down') throw new TypeError('Network request failed');
        const answer = this.submitOrder(call.body as SubmitOrderRequest);
        if (this.network === 'loseAnswers') throw new TypeError('Network request failed');
        return { status: 200, body: answer };
      })
      .on('GET', '/api/v1/table-sessions/:sessionId/orders', (call: RecordedCall) => {
        const sessionId = call.path.split('/')[4] ?? '';
        return { status: 200, body: { orders: this.orders.get(sessionId) ?? [] } };
      })
      .on('GET', '/api/v1/pagers/mine', () => ({
        status: 200,
        body: { pager: this.pager, lowBatteryPercent: 15 } satisfies MyPagerResponse,
      }))
      .on('POST', '/api/v1/tables/:tableId/open', (call) => {
        const table = this.tables.find((candidate) => call.path.includes(candidate.id));
        if (table?.state !== 'FREE') {
          return {
            status: 409,
            body: { code: 'TABLE_NOT_FREE', message: 'Someone has just opened this table.' },
          };
        }
        const covers = (call.body as { covers: number }).covers;
        table.state = 'OCCUPIED';
        table.session = session(9100 + this.tables.indexOf(table), RAVI, covers);
        return { status: 201, body: this.sessionView(table) };
      })
      .on('POST', '/api/v1/table-sessions/:sessionId/move', (call) => {
        const from = this.tables.find(
          (table) => table.session !== null && call.path.includes(table.session.id),
        );
        const to = this.tables.find(
          (table) => table.id === (call.body as { toTableId: string }).toTableId,
        );
        if (from === undefined || to === undefined) return { status: 404, body: {} };
        to.state = from.state;
        to.session = from.session;
        to.requests = from.requests;
        from.state = 'FREE';
        from.session = null;
        from.requests = 0;
        return { status: 200, body: this.sessionView(to) };
      })
      .on('POST', '/api/v1/table-sessions/:sessionId/request-bill', (call) => {
        const table = this.tables.find(
          (candidate) => candidate.session !== null && call.path.includes(candidate.session.id),
        );
        if (table === undefined) return { status: 404, body: {} };
        table.state = 'BILL_REQUESTED';
        return { status: 200, body: this.sessionView(table) };
      });
  }
}

export interface SignedInApp {
  readonly restaurant: Restaurant;
  readonly server: FakeServer;
  readonly session: DeviceSession;
  readonly sockets: SocketFactory;
}

/** A paired waiter phone with Ravi signed in, showing the app. */
export async function signedInApp(
  restaurant = new Restaurant(),
  server = restaurant.server(),
): Promise<SignedInApp> {
  const sockets = new SocketFactory();
  const session = new DeviceSession({
    secureStore: new MemoryStore(),
    plainStore: new MemoryStore(),
    keys: new FakeKeys(),
    fetch: server.fetch,
    connect: sockets.connect,
  });
  await session.start();
  await session.pair('http://pos.test:3000', 'ABCD-EFGH');
  await session.signIn(RAVI, '4444');
  // The phone keeps the menu from an earlier connection (MENU-013).
  await session.menu.refresh(() => session.api.getMenu());
  await render(<App session={session} translator={translator} />);
  return { restaurant, server, session, sockets };
}
