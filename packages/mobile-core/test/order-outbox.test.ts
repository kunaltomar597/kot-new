import { randomUUID } from 'node:crypto';
import { ApiClient } from '@rp/api-client';
import type { MenuSnapshot } from '@rp/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceSession,
  MemoryStore,
  MenuCache,
  type OrderDraft,
  OrderOutbox,
  PersistentOutbox,
  type SentOrder,
} from '../src/index.js';
import {
  DEVICE_ID,
  eventFrame,
  FakeKeys,
  FakeServer,
  fakeLocalServer,
  inMinutes,
  login,
  SocketFactory,
  STAFF,
} from '../src/testing/index.js';

const SESSION_ID = '0199a0e0-0000-7000-8000-00000000c001';
const ITEM_ID = '0199a0e0-0000-7000-8000-00000000c002';
const ORDER_ID = '0199a0e0-0000-7000-8000-00000000c003';
const RAVI = STAFF.WAITER.staffId;
const MEERA = STAFF.MANAGER.staffId;

function draft(staffId: string | null, tableLabel = 'T2'): OrderDraft {
  const clientLineId = randomUUID();
  return {
    staffId,
    tableLabel,
    request: {
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: SESSION_ID,
      lines: [{ clientLineId, itemId: ITEM_ID, quantity: 1, modifiers: [] }],
    },
    lines: [
      {
        clientLineId,
        itemId: ITEM_ID,
        name: 'Dal Makhani',
        summary: '',
        quantity: 1,
        selection: {},
        instructions: '',
        unitPrice: 24_000,
      },
    ],
  };
}

const accepted = (orderNumber: number, replayed = false) => ({
  status: 200,
  body: { status: 'ACCEPTED', orderId: ORDER_ID, orderNumber, replayed, itemState: 'SENT' },
});

/**
 * The local server behind a phone whose Wi-Fi can drop: `offline` fails every request before it
 * leaves; `loseAnswers` lets the server take requests but loses its answers.
 */
function network(server: FakeServer) {
  const state = { offline: false, loseAnswers: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (state.offline) throw new TypeError('Network request failed');
    const response = await server.fetch(input, init);
    if (state.loseAnswers > 0) {
      state.loseAnswers -= 1;
      throw new TypeError('Network request failed');
    }
    return response;
  };
  return { state, fetch };
}

/** A paired phone with Ravi signed in, talking to `fetch`. */
function clientFor(fetch: typeof globalThis.fetch): ApiClient {
  return new ApiClient({
    baseUrl: 'http://pos.test:3000',
    fetch,
    credentials: {
      device: {
        deviceId: DEVICE_ID,
        deviceToken: 'device-token-1',
        deviceTokenExpiresAt: inMinutes(60),
      },
      session: login('WAITER'),
    },
  });
}

function outboxFor(server: FakeServer, person: { id: string | null } = { id: RAVI }) {
  const net = network(server);
  const store = new MemoryStore();
  const client = clientFor(net.fetch);
  const outbox = new OrderOutbox({ store, api: () => client.api, staffId: () => person.id });
  const sent: SentOrder[] = [];
  outbox.onSent((order) => sent.push(order));
  return { outbox, net, store, person, sent };
}

const submits = (server: FakeServer) => server.callsTo('POST', '/api/v1/orders');

describe('[WTR-012] [ORD-013] orders on their way to the kitchen', () => {
  it('sends an order at once when the server answers', async () => {
    const server = new FakeServer().on('POST', '/api/v1/orders', () => accepted(12));
    const { outbox, sent } = outboxFor(server);
    const order = draft(RAVI);
    expect(await outbox.submit(order)).toEqual({
      status: 'SENT',
      order: {
        status: 'ACCEPTED',
        orderId: ORDER_ID,
        orderNumber: 12,
        replayed: false,
        itemState: 'SENT',
      },
    });
    expect(submits(server).map((call) => call.body)).toEqual([order.request]);
    expect(await outbox.list()).toEqual([]);
    expect(sent).toEqual([expect.objectContaining({ background: false })]);
  });

  it('keeps an order made offline across a restart and sends it once on reconnect', async () => {
    const server = new FakeServer().on('POST', '/api/v1/orders', () => accepted(13));
    const { outbox, net, store, sent } = outboxFor(server);
    net.state.offline = true;
    const order = draft(RAVI);
    expect(await outbox.submit(order)).toEqual({ status: 'QUEUED' });
    expect(await outbox.list()).toMatchObject([
      { key: order.request.idempotencyKey, status: 'PENDING', attempts: 1, body: order },
    ]);
    expect(submits(server)).toHaveLength(0);

    // The app restarts, then the Wi-Fi comes back.
    const client = clientFor(server.fetch);
    const restarted = new OrderOutbox({ store, api: () => client.api, staffId: () => RAVI });
    const later: SentOrder[] = [];
    restarted.onSent((order) => later.push(order));
    expect(await restarted.flush()).toEqual({ sent: 1, retry: 0, rejected: 0 });
    expect(submits(server).map((call) => call.body)).toEqual([order.request]);
    expect(later).toMatchObject([{ draft: order, order: { orderNumber: 13 }, background: true }]);
    expect(sent).toEqual([]);
  });

  it('sends again with the same key when the answer was lost, and the server replays it', async () => {
    const server = new FakeServer().on(
      'POST',
      '/api/v1/orders',
      () => accepted(14),
      () => accepted(14, true),
    );
    const { outbox, net } = outboxFor(server);
    net.state.loseAnswers = 1;
    const order = draft(RAVI);
    expect(await outbox.submit(order)).toEqual({ status: 'QUEUED' });
    expect(await outbox.flush()).toEqual({ sent: 1, retry: 0, rejected: 0 });
    const keys = submits(server).map(
      (call) => (call.body as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual([order.request.idempotencyKey, order.request.idempotencyKey]);
  });

  it('keeps a refused order, with its refused lines or the reason, until changed or thrown away', async () => {
    const server = new FakeServer().on(
      'POST',
      '/api/v1/orders',
      (call) => ({
        status: 200,
        body: {
          status: 'PARTIALLY_REJECTED',
          rejectedLines: [
            {
              clientLineId: (call.body as OrderDraft['request']).lines[0]?.clientLineId,
              code: 'OUT_OF_STOCK',
              message: 'Dal Makhani is out of stock.',
            },
          ],
        },
      }),
      () => ({
        status: 409,
        body: {
          code: 'TABLE_SESSION_CLOSED',
          message: 'This table has been closed. Open it again first.',
        },
      }),
    );
    const { outbox } = outboxFor(server);
    const soldOut = draft(RAVI);
    const result = await outbox.submit(soldOut);
    expect(result).toEqual({
      status: 'REJECTED',
      problem: {
        kind: 'LINES',
        lines: [
          {
            clientLineId: soldOut.lines[0]?.clientLineId,
            code: 'OUT_OF_STOCK',
            message: 'Dal Makhani is out of stock.',
          },
        ],
      },
    });
    const closed = draft(RAVI, 'T5');
    expect(await outbox.submit(closed)).toEqual({
      status: 'REJECTED',
      problem: {
        kind: 'REFUSED',
        code: 'TABLE_SESSION_CLOSED',
        message: 'This table has been closed. Open it again first.',
      },
    });
    // Both stay, and flushing again does not send them.
    expect((await outbox.list()).map((entry) => entry.status)).toEqual(['REJECTED', 'REJECTED']);
    await outbox.flush();
    expect(submits(server)).toHaveLength(2);

    // One goes back into the cart to be changed; the other is thrown away.
    expect(await outbox.takeBack(soldOut.request.idempotencyKey)).toMatchObject({
      lines: soldOut.lines,
      problem: { kind: 'LINES' },
    });
    expect(await outbox.takeBack(soldOut.request.idempotencyKey)).toBeUndefined();
    await outbox.dismiss(closed.request.idempotencyKey);
    expect(await outbox.list()).toEqual([]);
  });

  it('sends only the signed-in person’s orders, in their name; the others wait for them', async () => {
    const server = new FakeServer().on('POST', '/api/v1/orders', () => accepted(15));
    const { outbox, net, person } = outboxFor(server);
    net.state.offline = true;
    const ravis = draft(RAVI, 'T2');
    await outbox.submit(ravis);
    person.id = MEERA;
    const meeras = draft(MEERA, 'T7');
    await outbox.submit(meeras);
    net.state.offline = false;

    expect(await outbox.flush()).toEqual({ sent: 1, retry: 0, rejected: 0 });
    expect(submits(server).map((call) => call.body)).toEqual([meeras.request]);
    person.id = null;
    expect(await outbox.flush()).toEqual({ sent: 0, retry: 0, rejected: 0 });
    person.id = RAVI;
    expect(await outbox.flush()).toEqual({ sent: 1, retry: 0, rejected: 0 });
    expect(submits(server)).toHaveLength(2);
  });

  it('waits while the session has ended or the server has a problem; gives up on a broken order', async () => {
    const server = new FakeServer().on(
      'POST',
      '/api/v1/orders',
      () => ({ status: 401, body: { code: 'SESSION_EXPIRED', message: 'Sign in again.' } }),
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'Try again.' } }),
      () => ({ status: 200, body: { status: 'ACCEPTED', orderId: 'not-an-id' } }),
    );
    const { outbox } = outboxFor(server);
    const order = draft(RAVI);
    expect(await outbox.submit(order)).toEqual({ status: 'QUEUED' });
    expect(await outbox.flush()).toEqual({ sent: 0, retry: 1, rejected: 0 });
    expect(await outbox.flush()).toEqual({ sent: 0, retry: 0, rejected: 1 });
    expect((await outbox.list())[0]?.body.problem).toMatchObject({
      kind: 'REFUSED',
      code: 'CONTRACT_ERROR',
    });
  });
});

describe('[WTR-012] the persistent outbox during a send', () => {
  it('sends what is added while it runs, and leaves what it is told to skip', async () => {
    const outbox = new PersistentOutbox<{ n: number; who: string }>(new MemoryStore());
    await outbox.enqueue({ key: 'a', kind: 'order', body: { n: 1, who: 'ravi' } });
    await outbox.enqueue({ key: 'b', kind: 'order', body: { n: 2, who: 'meera' } });
    const sent: string[] = [];
    const result = await outbox.flush(
      async (entry) => {
        sent.push(entry.key);
        if (entry.key === 'a') {
          await outbox.enqueue({ key: 'c', kind: 'order', body: { n: 3, who: 'ravi' } });
        }
        return entry.key === 'c'
          ? { kind: 'REJECTED', reason: 'Refused', body: { n: 30, who: 'ravi' } }
          : { kind: 'SENT' };
      },
      (entry) => entry.body.who === 'ravi',
    );
    expect(result).toEqual({ sent: 1, retry: 0, rejected: 1 });
    expect(sent).toEqual(['a', 'c']);
    expect(await outbox.list()).toMatchObject([
      { key: 'b', status: 'PENDING' },
      { key: 'c', status: 'REJECTED', body: { n: 30 } },
    ]);
  });
});

function menu(version: number): MenuSnapshot {
  return {
    version,
    publishedAt: '2026-09-26T10:00:00.000Z',
    categories: [],
    items: [
      {
        id: ITEM_ID,
        categoryId: ITEM_ID,
        name: 'Dal Makhani',
        basePrice: 24_000,
        taxGroupId: ITEM_ID,
        foodType: 'VEG',
        spiceLevel: 0,
        tags: [],
        stationId: ITEM_ID,
        available: true,
        stockCount: null,
        displayOrder: 1,
        channels: ['WAITER_APP'],
        variants: [],
        modifierGroupIds: [],
        synonyms: [],
        repeatable: true,
        archived: false,
      },
    ],
    modifierGroups: [],
    combos: [],
    taxGroups: [],
    stations: [],
  };
}

describe('[MENU-013] [MENU-006] the menu cache tells the screens', () => {
  it('calls its listeners when the menu is fetched, changed or cleared', async () => {
    const cache = new MenuCache(new MemoryStore());
    const seen: (number | null)[] = [];
    const stop = cache.subscribe((current) => seen.push(current?.items[0]?.stockCount ?? null));
    await cache.refresh(() => Promise.resolve(menu(1)));
    await cache.applyAvailability({ itemId: ITEM_ID, available: true, stockCount: 4 });
    await cache.clear();
    stop();
    await cache.refresh(() => Promise.resolve(menu(2)));
    expect(seen).toEqual([null, 4, null]);
  });
});

describe('[MENU-013] [WTR-012] the device session keeps the menu and orders going', () => {
  async function signedIn(server: FakeServer) {
    const sockets = new SocketFactory();
    const errors: unknown[] = [];
    const net = network(server);
    const session = new DeviceSession({
      secureStore: new MemoryStore(),
      plainStore: new MemoryStore(),
      keys: new FakeKeys(),
      fetch: net.fetch,
      connect: sockets.connect,
      onError: (error) => errors.push(error),
    });
    await session.start();
    await session.pair('http://pos.test:3000', 'ABCD-EFGH');
    await session.signIn(RAVI, '4444');
    return { session, sockets, net, errors };
  }

  it('fetches the menu on connecting and when a newer one is published, and applies availability', async () => {
    const server = fakeLocalServer().on(
      'GET',
      '/api/v1/menu',
      () => ({ status: 200, body: menu(3) }),
      () => ({ status: 200, body: menu(4) }),
    );
    const { session, sockets } = await signedIn(server);
    sockets.sync(0);
    await vi.waitFor(async () => {
      expect((await session.menu.get())?.version).toBe(3);
    });
    sockets.last.fire(
      'event',
      eventFrame(1, 'ItemAvailabilityChanged', {
        itemId: ITEM_ID,
        available: false,
        stockCount: 0,
      }),
    );
    await vi.waitFor(async () => {
      expect((await session.menu.get())?.items[0]).toMatchObject({
        available: false,
        stockCount: 0,
      });
    });
    // An older or the same version is not fetched again.
    sockets.last.fire('event', eventFrame(2, 'MenuPublished', { menuVersion: 3 }));
    sockets.last.fire('event', eventFrame(3, 'MenuPublished', { menuVersion: 4 }));
    await vi.waitFor(async () => {
      expect((await session.menu.get())?.version).toBe(4);
    });
    expect(server.callsTo('GET', '/api/v1/menu')).toHaveLength(2);
  });

  it('sends the orders made offline when the connection comes back', async () => {
    const server = fakeLocalServer().on('POST', '/api/v1/orders', () => accepted(21));
    const { session, sockets, net } = await signedIn(server);
    net.state.offline = true;
    const order = draft(RAVI);
    expect(await session.orders.submit(order)).toEqual({ status: 'QUEUED' });
    net.state.offline = false;
    sockets.last.fire('disconnect', 'transport close');
    sockets.sync(0);
    await vi.waitFor(async () => {
      expect(await session.orders.list()).toEqual([]);
    });
    expect(submits(server).map((call) => call.body)).toEqual([order.request]);
  });
});
