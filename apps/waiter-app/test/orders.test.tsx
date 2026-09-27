import type { OrderView, SubmitOrderRequest } from '@rp/contracts';
import { eventFrame, type SocketFactory } from '@rp/mobile-core/testing';
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { IDS, KIRAN, Restaurant, signedInApp, T2_SESSION } from './restaurant';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const id = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const button = (name: RegExp | string) => screen.getByRole('button', { name });
const QUEUED = 'No connection. The order is kept on this phone and sent when it reconnects.';

async function openTable(label: string) {
  await fireEvent.press(await screen.findByRole('button', { name: new RegExp(`^${label}, `) }));
  expect(await screen.findByRole('header', { name: `Table ${label}` })).toBeOnTheScreen();
}

async function showMenu() {
  await fireEvent.press(screen.getByRole('tab', { name: 'Menu' }));
}

async function addDal() {
  await showMenu();
  await fireEvent.press(button('Main Course'));
  await fireEvent.press(button(/^Dal Makhani,/));
}

/** The server accepts the connection: the phone is online and sends what it kept. */
async function goOnline(sockets: SocketFactory) {
  await act(async () => {
    sockets.sync(0);
    await Promise.resolve();
  });
}

/** The order bodies the phone sent, in order. */
function orderPosts(server: { callsTo: (method: string, path: string) => { body: unknown }[] }) {
  return server.callsTo('POST', '/api/v1/orders').map((call) => call.body as SubmitOrderRequest);
}

/** T2 already has an order: a Full Paneer Tikka with cheese, and a Gulab Jamun. */
function withSentOrder(restaurant: Restaurant, kots: OrderView['kots'] = []): OrderView {
  const line = (n: number, itemId: string, name: string): OrderView['items'][number] => ({
    id: id(6000 + n),
    itemId,
    parentOrderItemId: null,
    name,
    variantId: null,
    variantName: null,
    modifiers: [],
    quantity: 1,
    unitPrice: 9_000,
    lineTotal: 9_000,
    stationId: IDS.kitchen,
    state: 'READY',
    instructions: null,
  });
  const order: OrderView = {
    id: id(6100),
    orderNumber: 12,
    orderType: 'DINE_IN',
    source: 'WAITER_APP',
    status: 'OPEN',
    tableSessionId: T2_SESSION,
    tableId: null,
    takeawayToken: null,
    customerName: null,
    businessDate: '2026-09-26',
    createdAt: '2026-09-26T08:10:00.000Z',
    note: null,
    items: [
      {
        ...line(1, IDS.tikka, 'Paneer Tikka'),
        variantId: IDS.full,
        variantName: 'Full',
        modifiers: [{ optionId: IDS.cheese, name: 'Cheese', priceDelta: 4_000 }],
        quantity: 2,
        instructions: 'Less spicy',
      },
      line(2, IDS.jamun, 'Gulab Jamun'),
    ],
    kots,
  };
  restaurant.orders.set(T2_SESSION, [order]);
  return order;
}

describe('[WTR-003] [ORD-013] taking an order', () => {
  it('adds dishes with their options, and sends them once as a KOT for the table', async () => {
    const { server } = await signedInApp();
    await openTable('T2');
    expect(await screen.findByText('Nothing sent yet.')).toBeOnTheScreen();
    await fireEvent.press(button('Add from the menu'));
    expect(button('Starters')).toBeSelected();

    await fireEvent.press(button(/^Paneer Tikka, ₹180.00, Veg, Choose options/));
    expect(screen.getByRole('header', { name: 'Paneer Tikka' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('item-add'));
    expect(screen.getByText('Choose a size.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'Full, ₹280.00' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Cheese, +₹40.00' }));
    await fireEvent.press(screen.getByRole('button', { name: 'One more' }));
    await fireEvent.changeText(screen.getByLabelText('Instructions for the kitchen'), 'Less spicy');
    expect(screen.getByText('₹640.00')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('item-add'));
    expect(screen.queryByRole('header', { name: 'Paneer Tikka' })).toBeNull();

    await fireEvent.press(button('Main Course'));
    expect(button(/^Gulab Jamun, ₹90.00, Veg, Sold out/)).toBeDisabled();
    // Rasmalai is sold on the QR menu only.
    expect(screen.queryByRole('button', { name: /^Rasmalai/ })).toBeNull();
    await fireEvent.press(button(/^Dal Makhani,/));
    expect(screen.getByText('3 new items · ₹880.00')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Order (3)' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(await screen.findByText('Order 21 sent to the kitchen')).toBeOnTheScreen();
    const [body, ...more] = orderPosts(server);
    expect(more).toHaveLength(0);
    expect(body).toMatchObject({
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: T2_SESSION,
      lines: [
        {
          itemId: IDS.tikka,
          quantity: 2,
          variantId: IDS.full,
          modifiers: [{ groupId: IDS.extras, optionIds: [IDS.cheese] }],
          instructions: 'Less spicy',
        },
        { itemId: IDS.dal, quantity: 1, modifiers: [] },
      ],
    });
    // Prices are never sent (ORD-014).
    expect(JSON.stringify(body)).not.toContain('Price');

    // What was sent, with its ticket on the kitchen screen and each item's state.
    const order = await screen.findByTestId('order-21');
    expect(
      within(order).getByLabelText('KOT 21 · Kitchen: On the kitchen screen'),
    ).toBeOnTheScreen();
    expect(within(order).getByText('2 × Paneer Tikka')).toBeOnTheScreen();
    expect(within(order).getByText('Full · Cheese · Less spicy')).toBeOnTheScreen();
    expect(within(order).getAllByLabelText('Sent')).toHaveLength(2);
    expect(screen.getByText('No new items yet.')).toBeOnTheScreen();
    expect(screen.queryByTestId('send-kot')).toBeNull();
  });

  it('edits the new items: quantity, note and remove, and keeps them when leaving the table', async () => {
    const { server } = await signedInApp();
    await openTable('T2');
    await addDal();
    await fireEvent.press(button(/^Dal Makhani,/));
    await fireEvent.press(button('Starters'));
    await fireEvent.press(button(/^Paneer Tikka,/));
    await fireEvent.press(screen.getByRole('radio', { name: 'Half, ₹180.00' }));
    await fireEvent.press(screen.getByTestId('item-add'));
    await fireEvent.press(screen.getByRole('tab', { name: 'Order (3)' }));

    const dal = screen.getByTestId(`cart-line-${IDS.dal}`);
    expect(within(dal).getByTestId('stepper-value')).toHaveTextContent('2');
    await fireEvent.press(within(dal).getByRole('button', { name: 'One more' }));
    await fireEvent.changeText(
      within(dal).getByLabelText('Instructions for the kitchen'),
      'No cream',
    );
    await fireEvent.press(button('Remove Paneer Tikka'));
    expect(screen.queryByTestId(`cart-line-${IDS.tikka}`)).toBeNull();
    expect(screen.getByText('Estimated total')).toBeOnTheScreen();

    // Leaving the table keeps its new items.
    await fireEvent.press(button('Back to tables'));
    await openTable('T2');
    expect(await screen.findByText('3 new items · ₹720.00')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(await screen.findByText('Order 21 sent to the kitchen')).toBeOnTheScreen();
    expect(orderPosts(server)[0]?.lines).toEqual([
      expect.objectContaining({ itemId: IDS.dal, quantity: 3, instructions: 'No cream' }),
    ]);
  });

  it('finds dishes by search and chooses a combo’s parts', async () => {
    await signedInApp();
    await openTable('T2');
    await showMenu();
    await fireEvent.changeText(screen.getByTestId('menu-search'), 'dm');
    expect(button(/^Dal Makhani,/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Starters' })).toBeNull();
    await fireEvent.changeText(screen.getByTestId('menu-search'), 'zzz');
    expect(screen.getByText('No dishes match “zzz”.')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('menu-search'), 'thali');
    await fireEvent.press(button(/^Veg Thali Combo, ₹349.00, Veg, Combo/));
    await fireEvent.press(screen.getByTestId('item-add'));
    expect(screen.getByText('Choose one to add the combo.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'Rasmalai' }));
    await fireEvent.press(screen.getByTestId('item-add'));
    await fireEvent.press(screen.getByRole('tab', { name: 'Order (1)' }));
    expect(screen.getByText('Dessert: Rasmalai')).toBeOnTheScreen();
    // Back on the menu the search is cleared. Closing the sheet adds nothing.
    await showMenu();
    await fireEvent.press(button('Main Course'));
    await fireEvent.press(button(/^Veg Thali Combo,/));
    await fireEvent.press(screen.getByTestId('sheet-close'));
    expect(screen.getByRole('tab', { name: 'Order (1)' })).toBeOnTheScreen();
  });

  it('says when the phone has no menu yet', async () => {
    const { session } = await signedInApp();
    await act(async () => {
      await session.menu.clear();
    });
    await openTable('T2');
    await showMenu();
    expect(
      screen.getByText('The menu appears when this phone reaches the restaurant server.'),
    ).toBeOnTheScreen();
  });
});

describe('[WTR-012] [ORD-013] orders without a connection', () => {
  it('keeps an order made offline on the phone and sends it once on reconnect', async () => {
    const restaurant = new Restaurant();
    restaurant.network = 'down';
    const { server, sockets } = await signedInApp(restaurant);
    await openTable('T2');
    await addDal();
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(await screen.findByText(QUEUED)).toBeOnTheScreen();
    const draft = await screen.findByTestId('unsent-orders');
    expect(
      within(draft).getByText('Kept on this phone. It is sent when the phone reconnects.'),
    ).toBeOnTheScreen();
    expect(within(draft).getByText('1 × Dal Makhani')).toBeOnTheScreen();
    expect(restaurant.allOrders()).toHaveLength(0);

    // The home screen shows it too, and opens its table.
    await fireEvent.press(button('Back to tables'));
    expect(await screen.findByText('1 order is not sent yet')).toBeOnTheScreen();
    await fireEvent.press(button('T2 · Waiting to send'));
    expect(await screen.findByRole('header', { name: 'Table T2' })).toBeOnTheScreen();

    restaurant.network = 'up';
    await goOnline(sockets);
    expect(await screen.findByText('Order 21 for T2 sent to the kitchen')).toBeOnTheScreen();
    expect(restaurant.allOrders()).toHaveLength(1);
    expect(await screen.findByTestId('order-21')).toBeOnTheScreen();
    expect(screen.queryByTestId('unsent-orders')).toBeNull();
    const posts = orderPosts(server);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.idempotencyKey).toBe(posts[0]?.idempotencyKey);
  });

  it('resends an order whose answer was lost with the same key: one order, one KOT', async () => {
    const restaurant = new Restaurant();
    const { server, sockets } = await signedInApp(restaurant);
    restaurant.network = 'loseAnswers';
    await openTable('T2');
    await addDal();
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(await screen.findByText(QUEUED)).toBeOnTheScreen();
    // The server made the order; the phone never heard.
    expect(restaurant.allOrders()).toHaveLength(1);

    restaurant.network = 'up';
    await fireEvent.press(await screen.findByRole('button', { name: 'Send now' }));
    expect(await screen.findByText('Order 21 for T2 sent to the kitchen')).toBeOnTheScreen();
    expect(restaurant.allOrders()).toHaveLength(1);
    expect(restaurant.allOrders()[0]?.kots).toHaveLength(1);
    const posts = orderPosts(server);
    expect(posts.map((body) => body.idempotencyKey)).toEqual([
      posts[0]?.idempotencyKey,
      posts[0]?.idempotencyKey,
    ]);
    // Nothing more to send when the connection comes back.
    await goOnline(sockets);
    expect(orderPosts(server)).toHaveLength(2);
  });

  it('keeps another waiter’s order for them, and says so', async () => {
    const restaurant = new Restaurant();
    restaurant.network = 'down';
    const { session, sockets, server } = await signedInApp(restaurant);
    await act(async () => {
      await session.orders.submit({
        staffId: KIRAN,
        tableLabel: 'T2',
        request: {
          idempotencyKey: id(5001),
          source: 'WAITER_APP',
          orderType: 'DINE_IN',
          tableSessionId: T2_SESSION,
          lines: [{ clientLineId: id(5002), itemId: IDS.dal, quantity: 1, modifiers: [] }],
        },
        lines: [
          {
            clientLineId: id(5002),
            itemId: IDS.dal,
            name: 'Dal Makhani',
            summary: '',
            quantity: 1,
            selection: {},
            instructions: '',
            unitPrice: 24_000,
          },
        ],
      });
    });
    expect(await screen.findByText('1 order is not sent yet')).toBeOnTheScreen();
    await openTable('T2');
    expect(
      screen.getByText('Taken by someone else on this phone. It is sent when they sign in.'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    restaurant.network = 'up';
    await goOnline(sockets);
    expect(orderPosts(server)).toHaveLength(0);
  });

  it('shows a closed table, with the order kept for it', async () => {
    const restaurant = new Restaurant();
    restaurant.network = 'down';
    const { session } = await signedInApp(restaurant);
    await act(async () => {
      await session.orders.submit({
        staffId: KIRAN,
        tableLabel: 'T9',
        request: {
          idempotencyKey: id(5101),
          source: 'WAITER_APP',
          orderType: 'DINE_IN',
          tableSessionId: id(5100),
          lines: [{ clientLineId: id(5102), itemId: IDS.dal, quantity: 1, modifiers: [] }],
        },
        lines: [],
      });
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'T9 · Waiting to send' }));
    expect(await screen.findByText('This table has been closed.')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Table T9' })).toBeOnTheScreen();
    expect(screen.queryByRole('tab', { name: 'Menu' })).toBeNull();
  });
});

describe('[ORD-017] [WTR-010] items the kitchen cannot make', () => {
  it('brings refused lines back marked, and sends the rest once they are removed', async () => {
    const restaurant = new Restaurant();
    const { server } = await signedInApp(restaurant);
    await openTable('T2');
    await addDal();
    await fireEvent.press(button('Starters'));
    await fireEvent.press(button(/^Paneer Tikka,/));
    await fireEvent.press(screen.getByRole('radio', { name: 'Full, ₹280.00' }));
    await fireEvent.press(screen.getByTestId('item-add'));
    // The server ran out after the phone last heard.
    restaurant.menu = {
      ...restaurant.menu,
      items: restaurant.menu.items.map((item) =>
        item.id === IDS.dal ? { ...item, stockCount: 0 } : item,
      ),
    };
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(
      await screen.findByText('Nothing was sent. Fix the marked items and send again.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Dal Makhani is sold out.')).toBeOnTheScreen();
    expect(screen.queryByTestId('unsent-orders')).toBeNull();

    await fireEvent.press(button('Remove Dal Makhani'));
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(await screen.findByText('Order 21 sent to the kitchen')).toBeOnTheScreen();
    const posts = orderPosts(server);
    expect(posts).toHaveLength(2);
    // A changed order is a new order with a new key.
    expect(posts[1]?.idempotencyKey).not.toBe(posts[0]?.idempotencyKey);
    expect(posts[1]?.lines.map((line) => line.itemId)).toEqual([IDS.tikka]);
  });

  it('keeps the items when the server refuses the whole order, with its reason', async () => {
    const restaurant = new Restaurant();
    const server = restaurant.server().on('POST', '/api/v1/orders', () => ({
      status: 409,
      body: { code: 'TABLE_SESSION_CLOSED', message: 'This table has been closed.' },
    }));
    await signedInApp(restaurant, server);
    await openTable('T2');
    await addDal();
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(
      await screen.findByText(
        'Not sent: This table has been closed. Your items are kept; send again.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText('1 new item · ₹240.00')).toBeOnTheScreen();
  });

  it('marks a dish sold out live, in the menu and in the new items, and blocks sending', async () => {
    const restaurant = new Restaurant();
    const { sockets } = await signedInApp(restaurant);
    await openTable('T2');
    await addDal();
    restaurant.menu = {
      ...restaurant.menu,
      items: restaurant.menu.items.map((item) =>
        item.id === IDS.dal ? { ...item, stockCount: 0 } : item,
      ),
    };
    await goOnline(sockets);
    await act(async () => {
      sockets.last.fire(
        'event',
        eventFrame(1, 'ItemAvailabilityChanged', {
          itemId: IDS.dal,
          available: true,
          stockCount: 0,
        }),
      );
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('button', { name: /^Dal Makhani, ₹240.00, Veg, Sold out/ }),
    ).toBeDisabled();
    await fireEvent.press(screen.getByRole('tab', { name: 'Order (1)' }));
    expect(screen.getByText('Sold out')).toBeOnTheScreen();
    expect(screen.getByText('Remove or change the marked items to send.')).toBeOnTheScreen();
    expect(screen.getByTestId('send-kot')).toBeDisabled();
  });

  it('refuses an order kept offline once the dish ran out, to change or discard', async () => {
    const restaurant = new Restaurant();
    restaurant.network = 'down';
    const { sockets } = await signedInApp(restaurant);
    await openTable('T2');
    await addDal();
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(await screen.findByText(QUEUED)).toBeOnTheScreen();
    await addDal();
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(await screen.findAllByText('1 × Dal Makhani')).toHaveLength(2);

    restaurant.menu = {
      ...restaurant.menu,
      items: restaurant.menu.items.map((item) =>
        item.id === IDS.dal ? { ...item, stockCount: 0 } : item,
      ),
    };
    restaurant.network = 'up';
    await goOnline(sockets);
    expect(await screen.findAllByText('Not sent: some items cannot be made.')).toHaveLength(2);
    expect(screen.getAllByText('1 × Dal Makhani · Dal Makhani is sold out.')).toHaveLength(2);

    // Discard asks first.
    const [first, second] = screen.getAllByRole('button', { name: 'Discard' });
    if (first === undefined || second === undefined) throw new Error('two drafts');
    await fireEvent.press(first);
    expect(screen.getByRole('header', { name: 'Discard this order?' })).toBeOnTheScreen();
    await fireEvent.press(button('Keep it'));
    expect(screen.getAllByText('Not sent: some items cannot be made.')).toHaveLength(2);
    await fireEvent.press(first);
    await fireEvent.press(screen.getByTestId('discard-confirm'));
    expect(await screen.findAllByText('Not sent: some items cannot be made.')).toHaveLength(1);

    // The other goes back into the new items to be changed.
    await fireEvent.press(button('Change and send'));
    expect(screen.queryByTestId('unsent-orders')).toBeNull();
    expect(screen.getByTestId(`cart-line-${IDS.dal}`)).toBeOnTheScreen();
    expect(
      screen.getByText('Nothing was sent. Fix the marked items and send again.'),
    ).toBeOnTheScreen();
  });
});

describe('[NFR-U03] [WTR-012] what was sent', () => {
  it('orders a sent dish again with the same choices, and sends it: 3 taps from the tables', async () => {
    const restaurant = new Restaurant();
    withSentOrder(restaurant);
    const { server } = await signedInApp(restaurant);
    await fireEvent.press(await screen.findByRole('button', { name: /^T2, Occupied/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Order Paneer Tikka again' }));
    await fireEvent.press(screen.getByTestId('send-kot'));
    expect(await screen.findByText('Order 21 sent to the kitchen')).toBeOnTheScreen();
    expect(orderPosts(server)[0]?.lines).toEqual([
      expect.objectContaining({
        itemId: IDS.tikka,
        quantity: 1,
        variantId: IDS.full,
        modifiers: [{ groupId: IDS.extras, optionIds: [IDS.cheese] }],
        instructions: 'Less spicy',
      }),
    ]);
    // Gulab Jamun is sold out: it cannot be ordered again.
    expect(button('Order Gulab Jamun again')).toBeDisabled();
    expect(screen.getAllByText('Sold out').length).toBeGreaterThan(0);
  });

  it('asks for the choices again when the menu changed how a dish is ordered', async () => {
    const restaurant = new Restaurant();
    const order = withSentOrder(restaurant);
    const tikka = order.items[0];
    if (tikka === undefined) throw new Error('fixture');
    restaurant.orders.set(T2_SESSION, [
      {
        ...order,
        items: [{ ...tikka, modifiers: [{ optionId: id(999), name: 'Gone', priceDelta: 0 }] }],
      },
    ]);
    await signedInApp(restaurant);
    await openTable('T2');
    await fireEvent.press(await screen.findByRole('button', { name: 'Order Paneer Tikka again' }));
    expect(screen.getByRole('header', { name: 'Paneer Tikka' })).toBeOnTheScreen();
  });

  it('says for each ticket whether it reached the kitchen, and updates it live', async () => {
    const bar = id(8100);
    const restaurant = new Restaurant();
    restaurant.menu = {
      ...restaurant.menu,
      stations: [...restaurant.menu.stations, { id: bar, name: 'Bar', mode: 'PRINT' }],
    };
    const order = withSentOrder(restaurant, [
      {
        id: id(6201),
        kotNumber: 5,
        stationId: IDS.kitchen,
        stationName: 'Kitchen',
        kind: 'NEW',
        printStatus: 'NOT_REQUIRED',
      },
      {
        id: id(6202),
        kotNumber: 6,
        stationId: bar,
        stationName: 'Bar',
        kind: 'NEW',
        printStatus: 'FAILED',
      },
    ]);
    const { sockets } = await signedInApp(restaurant);
    await openTable('T2');
    expect(
      await screen.findByLabelText('KOT 5 · Kitchen: On the kitchen screen'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('KOT 6 · Bar: Not printed: printer problem')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Ready')).toHaveLength(2);

    // The bar's printer is back: the ticket prints and the phone hears it.
    restaurant.orders.set(T2_SESSION, [
      {
        ...order,
        kots: order.kots.map((kot) =>
          kot.kotNumber === 6 ? { ...kot, printStatus: 'PRINTED' } : kot,
        ),
      },
    ]);
    await goOnline(sockets);
    await act(async () => {
      sockets.last.fire(
        'event',
        eventFrame(1, 'KotPrintStatusChanged', {
          kotId: id(6202),
          kotNumber: 6,
          orderId: order.id,
          stationId: bar,
          printStatus: 'PRINTED',
        }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByLabelText('KOT 6 · Bar: Printed')).toBeOnTheScreen();
  });

  it('offers a retry when the sent orders cannot be read', async () => {
    const restaurant = new Restaurant();
    const server = restaurant.server();
    let calls = 0;
    server.on('GET', '/api/v1/table-sessions/:sessionId/orders', () => {
      calls += 1;
      return calls === 1
        ? { status: 500, body: { code: 'INTERNAL', message: 'The server had a problem.' } }
        : { status: 200, body: { orders: [] } };
    });
    await signedInApp(restaurant, server);
    await openTable('T2');
    expect(await screen.findByText('The server had a problem.')).toBeOnTheScreen();
    await fireEvent.press(button('Try again'));
    expect(await screen.findByText('Nothing sent yet.')).toBeOnTheScreen();
  });
});
