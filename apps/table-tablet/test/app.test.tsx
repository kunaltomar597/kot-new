import type { MenuSnapshot } from '@rp/contracts';
import { createTranslator } from '@rp/i18n';
import { DeviceSession, MemoryStore, MenuCache } from '@rp/mobile-core';
import { FakeKeys, fakeLocalServer, RESTAURANT_ID, SocketFactory } from '@rp/mobile-core/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { App } from '../src/App';
import { orderableCount } from '../src/TabletHome';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const translator = createTranslator();
const ID = '0199a0e0-0000-7000-8000-0000000071a1';
const TABLE_ID = '0199a0e0-0000-7000-8000-0000000071b1';

function item(id: string, overrides: Partial<MenuSnapshot['items'][number]> = {}) {
  return {
    id,
    categoryId: ID,
    name: 'Paneer Tikka',
    basePrice: 28_000,
    taxGroupId: ID,
    foodType: 'VEG' as const,
    spiceLevel: 1,
    tags: [],
    stationId: ID,
    available: true,
    stockCount: null,
    displayOrder: 1,
    channels: ['TABLE_TABLET' as const],
    variants: [],
    modifierGroupIds: [],
    synonyms: [],
    repeatable: false,
    archived: false,
    ...overrides,
  };
}

function menu(version: number): MenuSnapshot {
  return {
    version,
    publishedAt: '2026-09-26T10:00:00.000Z',
    categories: [],
    items: [
      item('0199a0e0-0000-7000-8000-0000000081a1'),
      item('0199a0e0-0000-7000-8000-0000000081a2'),
      ...(version > 1 ? [item('0199a0e0-0000-7000-8000-0000000081a3')] : []),
      item('0199a0e0-0000-7000-8000-0000000081a4', { channels: ['POS'] }),
    ],
    modifierGroups: [],
    combos: [],
    taxGroups: [],
    stations: [],
  };
}

function frame(sequence: number, type: string, payload: object) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000000${String(sequence).padStart(2, '0')}`,
      type,
      version: 1,
      occurredAt: '2026-09-26T08:40:00.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-26',
      payload,
    },
  };
}

function setup() {
  let version = 1;
  const server = fakeLocalServer({ type: 'TABLE_TABLET', name: 'Table T4', tableId: TABLE_ID })
    .on('GET', '/api/v1/menu', () => ({ status: 200, body: menu(version) }))
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
        timeZone: 'Asia/Kolkata',
        businessDayCutoff: '04:00',
        updatedAt: '2026-09-26T08:00:00.000Z',
      },
    }));
  const sockets = new SocketFactory();
  const plainStore = new MemoryStore();
  const session = new DeviceSession({
    secureStore: new MemoryStore(),
    plainStore,
    keys: new FakeKeys(),
    fetch: server.fetch,
    connect: sockets.connect,
  });
  return {
    session,
    sockets,
    server,
    menuCache: new MenuCache(plainStore),
    publish: () => {
      version = 2;
    },
  };
}

describe('[MENU-013] [MENU-006] table tablet smoke flow', () => {
  it('pairs to its table and shows the live menu with no staff login', async () => {
    const { session, sockets, menuCache, publish } = setup();
    await session.start();
    await render(<App session={session} menu={menuCache} translator={translator} />);

    await fireEvent.changeText(screen.getByLabelText('Server address'), 'http://pos.test:3000');
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), 'ABCDEFGH');
    await fireEvent.press(screen.getByTestId('pairing-submit'));

    expect(await screen.findByText('Table T4')).toBeOnTheScreen();
    expect(screen.getByText(translator('mobile.tablet.menuWaiting'))).toBeOnTheScreen();

    await act(async () => {
      sockets.sync(0);
      await Promise.resolve();
    });
    expect(await screen.findByText('Welcome to Spice Garden')).toBeOnTheScreen();
    expect(await screen.findByText('2 dishes on the menu today')).toBeOnTheScreen();

    publish();
    await act(async () => {
      sockets.last.fire('event', frame(1, 'MenuPublished', { menuVersion: 2 }));
      await Promise.resolve();
    });
    expect(await screen.findByText('3 dishes on the menu today')).toBeOnTheScreen();

    await act(async () => {
      sockets.last.fire(
        'event',
        frame(2, 'ItemAvailabilityChanged', {
          itemId: '0199a0e0-0000-7000-8000-0000000081a1',
          available: false,
          stockCount: 0,
        }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText('2 dishes on the menu today')).toBeOnTheScreen();
  });

  it('shows the cached menu straight away after a restart, before the server answers', async () => {
    const { session, menuCache } = setup();
    await session.start();
    await session.pair('http://pos.test:3000', 'ABCD-EFGH');
    await menuCache.refresh(() => Promise.resolve(menu(2)));
    await render(<App session={session} menu={menuCache} translator={translator} />);
    expect(await screen.findByText('3 dishes on the menu today')).toBeOnTheScreen();
  });

  it('counts only dishes a guest can order from the tablet now', () => {
    const snapshot = menu(1);
    expect(orderableCount(snapshot)).toBe(2);
    expect(
      orderableCount({
        ...snapshot,
        items: snapshot.items.map((entry, index) =>
          index === 0 ? { ...entry, archived: true } : entry,
        ),
      }),
    ).toBe(1);
  });
});
