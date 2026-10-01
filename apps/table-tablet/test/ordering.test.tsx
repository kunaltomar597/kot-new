import type {
  DeviceHealthRequest,
  MenuItem,
  MenuSnapshot,
  OrderView,
  TabletOrderRequest,
  TabletTableView,
} from '@rp/contracts';
import { createTranslator } from '@rp/i18n';
import {
  type DeviceHealthReading,
  DeviceSession,
  type Kiosk,
  type KioskMode,
  MemoryStore,
} from '@rp/mobile-core';
import {
  FakeKeys,
  fakeLocalServer,
  RESTAURANT_ID,
  SocketFactory,
  STAFF,
} from '@rp/mobile-core/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { App } from '../src/App';
import type { TabletDevice } from '../src/TabletHome';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const t = createTranslator();
const ID = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TABLE_ID = ID(7101);
const SESSION_ID = ID(7102);
const CATEGORY = ID(7103);
const TAX = ID(7104);
const STATION = ID(7105);
const DISH = {
  tikka: ID(7201),
  dal: ID(7202),
  omelette: ID(7203),
  lassi: ID(7204),
};

function dish(id: string, name: string, overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id,
    categoryId: CATEGORY,
    name,
    basePrice: 20_000,
    taxGroupId: TAX,
    foodType: 'VEG',
    spiceLevel: 0,
    tags: [],
    stationId: STATION,
    available: true,
    stockCount: null,
    displayOrder: 1,
    channels: ['TABLE_TABLET'],
    variants: [],
    modifierGroupIds: [],
    synonyms: [],
    repeatable: true,
    archived: false,
    ...overrides,
  };
}

const MENU: MenuSnapshot = {
  version: 1,
  publishedAt: '2026-10-02T08:00:00.000Z',
  categories: [{ id: CATEGORY, name: 'Mains', parentId: null, displayOrder: 1 }],
  items: [
    dish(DISH.tikka, 'Paneer Tikka', { spiceLevel: 2, tags: ['Starter'], basePrice: 28_000 }),
    dish(DISH.dal, 'Dal Makhani', { basePrice: 24_000, displayOrder: 2 }),
    dish(DISH.omelette, 'Masala Omelette', { foodType: 'EGG', displayOrder: 3 }),
    dish(DISH.lassi, 'Mango Lassi', { available: false, stockCount: 0, displayOrder: 4 }),
  ],
  modifierGroups: [],
  combos: [],
  taxGroups: [
    {
      id: TAX,
      name: 'GST 5 %',
      components: [
        { code: 'CGST', rateBp: 250 },
        { code: 'SGST', rateBp: 250 },
      ],
    },
  ],
  stations: [{ id: STATION, name: 'Kitchen', mode: 'SCREEN' }],
};

const TABLE: TabletTableView = {
  tableId: TABLE_ID,
  label: 'T4',
  state: 'OCCUPIED',
  session: { id: SESSION_ID, openedAt: '2026-10-02T08:30:00.000Z', covers: 2 },
  promotions: { show: false, itemIds: [] },
  priceMode: 'TAX_EXCLUSIVE',
};

class FakeKiosk implements Kiosk {
  mode: KioskMode = 'NONE';
  state() {
    return { mode: this.mode, deviceOwner: true, permitted: true };
  }
  enter(): Promise<KioskMode> {
    this.mode = 'LOCKED';
    return Promise.resolve(this.mode);
  }
  exit(): Promise<KioskMode> {
    this.mode = 'NONE';
    return Promise.resolve(this.mode);
  }
  keepScreenOn(): Promise<void> {
    return Promise.resolve();
  }
  locateTone(): Promise<void> {
    return Promise.resolve();
  }
  readHealth(): DeviceHealthReading {
    return { batteryPercent: 80, charging: true, network: 'WIFI', rssi: -50 } satisfies Omit<
      DeviceHealthRequest,
      'appVersion'
    >;
  }
}

/** The restaurant server as the tablet sees it, with the table's orders kept as they change. */
function setup() {
  const orders: OrderView[] = [];
  let nextOrder = 40;
  const server = fakeLocalServer({ type: 'TABLE_TABLET', name: 'Tablet T4', tableId: TABLE_ID })
    .on('GET', '/api/v1/menu', () => ({ status: 200, body: MENU }))
    .on('GET', '/api/v1/devices/current/table', () => ({ status: 200, body: TABLE }))
    .on('POST', '/api/v1/devices/current/health', () => ({ status: 204 }))
    .on('GET', '/api/v1/menu/bestsellers', () => ({
      status: 200,
      body: { itemIds: [DISH.dal] },
    }))
    .on('GET', '/api/v1/devices/current/service-requests', () => ({
      status: 200,
      body: { tableSessionId: SESSION_ID, requests: [] },
    }))
    .on('GET', '/api/v1/devices/current/orders', () => ({
      status: 200,
      body: {
        tableSessionId: SESSION_ID,
        orders,
        runningTotal: orders
          .flatMap((order) => order.items)
          .filter((item) => item.state !== 'PENDING_APPROVAL' && item.state !== 'REJECTED')
          .reduce((total, item) => total + item.lineTotal, 0),
        pendingTotal: orders
          .flatMap((order) => order.items)
          .filter((item) => item.state === 'PENDING_APPROVAL')
          .reduce((total, item) => total + item.lineTotal, 0),
      },
    }))
    .on('POST', '/api/v1/devices/current/orders', (call) => {
      const request = call.body as TabletOrderRequest;
      nextOrder += 1;
      const orderId = ID(7300 + nextOrder);
      orders.push({
        id: orderId,
        orderNumber: nextOrder,
        orderType: 'DINE_IN',
        source: 'TABLE_TABLET',
        status: 'OPEN',
        tableSessionId: SESSION_ID,
        tableId: TABLE_ID,
        takeawayToken: null,
        customerName: null,
        businessDate: '2026-10-02',
        createdAt: new Date().toISOString(),
        note: null,
        items: request.lines.map((line, index) => {
          const item = MENU.items.find((candidate) => candidate.id === line.itemId);
          return {
            id: ID(7400 + nextOrder * 10 + index),
            itemId: line.itemId,
            parentOrderItemId: null,
            name: item?.name ?? '',
            variantId: null,
            variantName: null,
            modifiers: [],
            quantity: line.quantity,
            unitPrice: item?.basePrice ?? 0,
            lineTotal: (item?.basePrice ?? 0) * line.quantity,
            stationId: STATION,
            state: 'PENDING_APPROVAL' as const,
            instructions: null,
            endReason: null,
          };
        }),
        kots: [],
      });
      return {
        status: 200,
        body: {
          status: 'ACCEPTED',
          orderId,
          orderNumber: nextOrder,
          replayed: false,
          itemState: 'PENDING_APPROVAL',
        },
      };
    })
    .on('POST', '/api/v1/devices/current/orders/:orderId/approve', (call) => {
      if ((call.body as { pin: string }).pin !== '4444') {
        return {
          status: 401,
          body: {
            code: 'INVALID_CREDENTIALS',
            message: 'That PIN is not right.',
            correlationId: 'c',
          },
        };
      }
      const order = orders.find((candidate) => call.path.includes(candidate.id));
      if (order === undefined) return { status: 404, body: {} };
      order.items = order.items.map((item) => ({ ...item, state: 'SENT' }));
      return { status: 200, body: order };
    })
    .on('GET', '/api/v1/restaurant', () => ({
      status: 200,
      body: {
        id: RESTAURANT_ID,
        displayName: 'Spice Garden',
        legalName: null,
        address: null,
        stateCode: null,
        stateName: null,
        gstin: null,
        fssaiNumber: null,
        contact: { phone: null, email: null },
        businessHours: [],
        logoPhotoId: null,
        accentColor: null,
        timeZone: 'Asia/Kolkata',
        businessDayCutoff: '04:00',
        updatedAt: '2026-10-02T08:00:00.000Z',
      },
    }));
  const sockets = new SocketFactory();
  const store = new MemoryStore();
  const session = new DeviceSession({
    secureStore: new MemoryStore(),
    plainStore: store,
    keys: new FakeKeys(),
    fetch: server.fetch,
    connect: sockets.connect,
  });
  const kiosk = new FakeKiosk();
  const device: TabletDevice = { store, kiosk, health: kiosk };
  return { server, sockets, session, device, orders };
}

async function atTable() {
  const context = setup();
  await context.session.start();
  await context.session.pair('http://pos.test:3000', 'ABCD-EFGH');
  await render(<App session={context.session} translator={t} device={context.device} />);
  await act(async () => {
    context.sockets.sync(0);
    await Promise.resolve();
  });
  expect(await screen.findByTestId('menu-view')).toBeOnTheScreen();
  return context;
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('[TAB-005] [TAB-006] [TAB-012] the menu on the tablet', () => {
  it('shows the dishes with their marks, a bestseller, a tax note and sold-out dishes', async () => {
    await atTable();
    expect(
      screen.getByText(t('mobile.tablet.ordering.taxNote', { mode: 'TAX_EXCLUSIVE' })),
    ).toBeOnTheScreen();
    const dal = within(screen.getByTestId(`dish-${DISH.dal}`));
    expect(dal.getByText(t('mobile.tablet.ordering.bestseller'))).toBeOnTheScreen();
    const tikka = within(screen.getByTestId(`dish-${DISH.tikka}`));
    expect(tikka.getByText('Veg · Medium spicy · Starter')).toBeOnTheScreen();
    expect(screen.getByTestId(`dish-${DISH.lassi}`)).toBeDisabled();
    expect(
      within(screen.getByTestId(`dish-${DISH.lassi}`)).getByText(
        t('mobile.tablet.ordering.soldOut'),
      ),
    ).toBeOnTheScreen();
  });

  it('finds "something spicy" and filters veg dishes', async () => {
    await atTable();
    await fireEvent.changeText(screen.getByTestId('menu-search'), 'something spicy');
    expect(screen.getByTestId(`dish-${DISH.tikka}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`dish-${DISH.dal}`)).toBeNull();
    await fireEvent.changeText(screen.getByTestId('menu-search'), '');
    await fireEvent.press(
      screen.getByRole('checkbox', { name: t('mobile.tablet.ordering.filter.veg') }),
    );
    expect(screen.queryByTestId(`dish-${DISH.omelette}`)).toBeNull();
    expect(screen.getByTestId(`dish-${DISH.dal}`)).toBeOnTheScreen();
  });
});

describe('[TAB-008] [TAB-009] [TAB-010] ordering from the table', () => {
  it('adds a dish, reviews the estimate, sends it and follows it to the kitchen', async () => {
    const { server, sockets, orders } = await atTable();
    await fireEvent.press(screen.getByTestId(`dish-${DISH.dal}`));
    await fireEvent.press(screen.getByLabelText(t('pos.item.more')));
    await fireEvent.press(screen.getByTestId('item-add'));
    await fireEvent.press(tab(t('mobile.tablet.ordering.cartTab', { count: 2 })));
    expect(await screen.findByTestId('cart-view')).toBeOnTheScreen();
    // ₹480 of dal (the line and the subtotal) and 5 % GST on it.
    expect(screen.getAllByText('₹480.00')).toHaveLength(2);
    expect(screen.getByText('₹24.00')).toBeOnTheScreen();
    expect(screen.getByText('₹504.00')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('cart-send'));
    expect(await screen.findByTestId('my-orders')).toBeOnTheScreen();
    const sent = server.callsTo('POST', '/api/v1/devices/current/orders')[0]
      ?.body as TabletOrderRequest;
    expect(sent.lines).toEqual([expect.objectContaining({ itemId: DISH.dal, quantity: 2 })]);
    expect(await screen.findByText(t('mobile.tablet.ordering.waiting'))).toBeOnTheScreen();
    expect(
      screen.getByText(t('mobile.tablet.ordering.pendingTotal', { total: '₹480.00' })),
    ).toBeOnTheScreen();

    // The waiter approves it; the kitchen starts it.
    const order = orders[0];
    if (order === undefined) throw new Error('No order');
    order.items = order.items.map((item) => ({ ...item, state: 'PREPARING' }));
    await act(async () => {
      sockets.last.fire('event', {
        sequence: 1,
        event: {
          eventId: ID(7900),
          type: 'OrderApproved',
          version: 1,
          occurredAt: new Date().toISOString(),
          restaurantId: RESTAURANT_ID,
          businessDate: '2026-10-02',
          payload: { orderId: order.id, approvedBy: STAFF.WAITER.staffId },
        },
      });
      await Promise.resolve();
    });
    expect(
      await screen.findByText(t('mobile.tablet.ordering.lineState.PREPARING')),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(t('mobile.tablet.ordering.runningTotal', { total: '₹480.00' })),
    ).toBeOnTheScreen();
  });

  it('[ORD-004] lets the waiter confirm at the table with their PIN', async () => {
    const { server } = await atTable();
    await fireEvent.press(screen.getByTestId(`dish-${DISH.tikka}`));
    await fireEvent.press(screen.getByTestId('item-add'));
    await fireEvent.press(tab(t('mobile.tablet.ordering.cartTab', { count: 1 })));
    await fireEvent.press(await screen.findByTestId('cart-send'));
    const confirm = await screen.findByText(t('mobile.tablet.ordering.approveHere'));
    await fireEvent.press(confirm);
    await fireEvent.press(await screen.findByTestId(`approver-${STAFF.WAITER.staffId}`));
    for (const digit of ['4', '4', '4', '4']) await fireEvent.press(screen.getByText(digit));
    await waitFor(() => {
      expect(
        server.calls.filter((call) => call.path.endsWith('/approve') && call.method === 'POST'),
      ).toHaveLength(1);
    });
    expect(await screen.findByText(t('mobile.tablet.ordering.lineState.SENT'))).toBeOnTheScreen();
  });

  it('shows why a dish was not accepted', async () => {
    const { orders } = await atTable();
    orders.push({
      id: ID(7801),
      orderNumber: 7,
      orderType: 'DINE_IN',
      source: 'TABLE_TABLET',
      status: 'CANCELLED',
      tableSessionId: SESSION_ID,
      tableId: TABLE_ID,
      takeawayToken: null,
      customerName: null,
      businessDate: '2026-10-02',
      createdAt: new Date().toISOString(),
      note: null,
      items: [
        {
          id: ID(7802),
          itemId: DISH.dal,
          parentOrderItemId: null,
          name: 'Dal Makhani',
          variantId: null,
          variantName: null,
          modifiers: [],
          quantity: 1,
          unitPrice: 24_000,
          lineTotal: 24_000,
          stationId: STATION,
          state: 'REJECTED',
          instructions: null,
          endReason: 'The kitchen ran out of dal',
        },
      ],
      kots: [],
    });
    await fireEvent.press(tab(t('mobile.tablet.ordering.ordersTab')));
    expect(
      await screen.findByText(
        t('mobile.tablet.ordering.rejected', { reason: 'The kitchen ran out of dal' }),
      ),
    ).toBeOnTheScreen();
  });
});

describe('[TAB-013] without the server', () => {
  it('pauses ordering and the buttons with "Please call a waiter", and recovers', async () => {
    const { sockets } = await atTable();
    await fireEvent.press(screen.getByTestId(`dish-${DISH.dal}`));
    await fireEvent.press(screen.getByTestId('item-add'));
    await act(async () => {
      sockets.last.fire('disconnect', 'transport close');
      await Promise.resolve();
    });
    expect(await screen.findByTestId('call-waiter')).toBeOnTheScreen();
    expect(screen.getByTestId(`dish-${DISH.tikka}`)).toBeDisabled();
    expect(screen.getByTestId('request-WATER')).toBeDisabled();
    await fireEvent.press(tab(t('mobile.tablet.ordering.cartTab', { count: 1 })));
    expect(await screen.findByTestId('cart-send')).toBeDisabled();
    await act(async () => {
      sockets.sync(0);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('call-waiter')).toBeNull();
    });
    expect(screen.getByTestId('cart-send')).toBeEnabled();
  });
});
