import type { MenuSnapshot, TabletTableView } from '@rp/contracts';
import { createTranslator } from '@rp/i18n';
import {
  type DeviceHealthReading,
  DeviceSession,
  type Kiosk,
  type KioskMode,
  MemoryStore,
  TABLET_GUEST_KEYS,
} from '@rp/mobile-core';
import {
  DEVICE_ID,
  FakeKeys,
  fakeLocalServer,
  RESTAURANT_ID,
  SocketFactory,
  STAFF,
} from '@rp/mobile-core/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { App } from '../src/App';
import { accentColorsOf, STAFF_TAPS } from '../src/branding';
import { locateRequest } from '../src/LocateOverlay';
import { orderableCount, type TabletDevice } from '../src/TabletHome';

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

const SESSION_ID = '0199a0e0-0000-7000-8000-0000000071c1';

function tableView(open: boolean, covers = 2): TabletTableView {
  return {
    tableId: TABLE_ID,
    label: 'T4',
    state: open ? 'OCCUPIED' : 'FREE',
    session: open ? { id: SESSION_ID, openedAt: '2026-09-26T08:30:00.000Z', covers } : null,
    promotions: { show: true, itemIds: ['0199a0e0-0000-7000-8000-0000000081a2'] },
  };
}

/** Lock-task mode as Android keeps it, and a battery that reads 64 %. */
class FakeKiosk implements Kiosk {
  mode: KioskMode = 'NONE';
  readonly calls: string[] = [];
  state() {
    return { mode: this.mode, deviceOwner: true, permitted: true };
  }
  enter(): Promise<KioskMode> {
    this.calls.push('enter');
    this.mode = 'LOCKED';
    return Promise.resolve(this.mode);
  }
  exit(): Promise<KioskMode> {
    this.calls.push('exit');
    this.mode = 'NONE';
    return Promise.resolve(this.mode);
  }
  keepScreenOn(on: boolean): Promise<void> {
    this.calls.push(`screen ${String(on)}`);
    return Promise.resolve();
  }
  readonly tones: number[] = [];
  locateTone(durationMs: number): Promise<void> {
    this.tones.push(durationMs);
    return Promise.resolve();
  }
  readHealth(): DeviceHealthReading {
    return { batteryPercent: 64, charging: true, network: 'WIFI', rssi: -55 };
  }
}

function setup(open = true) {
  let version = 1;
  let tableOpen = open;
  const server = fakeLocalServer({ type: 'TABLE_TABLET', name: 'Table T4', tableId: TABLE_ID })
    .on('GET', '/api/v1/menu', () => ({ status: 200, body: menu(version) }))
    .on('GET', '/api/v1/devices/current/table', () => ({
      status: 200,
      body: tableView(tableOpen),
    }))
    .on('POST', '/api/v1/devices/current/health', () => ({ status: 204 }))
    .on('POST', '/api/v1/devices/current/kiosk-exit', (call) =>
      (call.body as { pin: string }).pin === '2222'
        ? {
            status: 200,
            body: {
              approver: { id: STAFF.MANAGER.staffId, displayName: STAFF.MANAGER.displayName },
              exitedAt: '2026-09-26T09:00:00.000Z',
            },
          }
        : {
            status: 401,
            body: {
              code: 'INVALID_CREDENTIALS',
              message: 'That PIN is not right.',
              correlationId: 'c',
            },
          },
    )
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
  const kiosk = new FakeKiosk();
  const device: TabletDevice = { store: plainStore, kiosk, health: kiosk, appVersion: '0.2.0' };
  return {
    session,
    sockets,
    server,
    plainStore,
    kiosk,
    device,
    publish: () => {
      version = 2;
    },
    setOpen: (value: boolean) => {
      tableOpen = value;
    },
  };
}

async function online(sockets: SocketFactory) {
  await act(async () => {
    sockets.sync(0);
    await Promise.resolve();
  });
}

describe('[MENU-013] [MENU-006] table tablet smoke flow', () => {
  it('pairs to its table and shows the live menu with no staff login', async () => {
    const { session, sockets, publish, device } = setup();
    await session.start();
    await render(<App session={session} translator={translator} device={device} />);

    await fireEvent.changeText(screen.getByLabelText('Server address'), 'http://pos.test:3000');
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), 'ABCDEFGH');
    await fireEvent.press(screen.getByTestId('pairing-submit'));

    expect(await screen.findByText(translator('mobile.tablet.loading'))).toBeOnTheScreen();

    await online(sockets);
    expect(await screen.findByText('Welcome to Spice Garden')).toBeOnTheScreen();
    expect(screen.getByText('Table T4 · 2 guests')).toBeOnTheScreen();
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
    const { session, device, plainStore } = setup();
    await session.start();
    await session.pair('http://pos.test:3000', 'ABCD-EFGH');
    await session.menu.refresh(() => Promise.resolve(menu(2)));
    // The table as it was last read, before the restart (P3-01b).
    await plainStore.setItem('rp.tablet.table.v1', JSON.stringify(tableView(true)));
    await plainStore.setItem('rp.tablet.session.v1', SESSION_ID);
    await render(<App session={session} translator={translator} device={device} />);
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

describe('[TAB-001] [TAB-003] [TAB-015] the tablet at its table', () => {
  async function paired(open: boolean) {
    const context = setup(open);
    await context.session.start();
    await context.session.pair('http://pos.test:3000', 'ABCD-EFGH');
    await render(<App session={context.session} translator={translator} device={context.device} />);
    await online(context.sockets);
    return context;
  }

  it('[TAB-003] waits for guests with the restaurant and a pinned dish, locked as a kiosk', async () => {
    const { kiosk, server } = await paired(false);
    expect(await screen.findByText(translator('mobile.tablet.waitToBeSeated'))).toBeOnTheScreen();
    expect(await screen.findByTestId('promotion')).toBeOnTheScreen();
    expect(screen.getByText(translator('mobile.tablet.todaysSpecial'))).toBeOnTheScreen();
    expect(kiosk.calls).toEqual(expect.arrayContaining(['screen true', 'enter']));
    expect(kiosk.mode).toBe('LOCKED');
    // TAB-015: the battery and connection went to the server.
    expect(server.callsTo('POST', '/api/v1/devices/current/health')[0]?.body).toEqual({
      batteryPercent: 64,
      charging: true,
      network: 'WIFI',
      rssi: -55,
      appVersion: '0.2.0',
    });
  });

  it('[TAB-003] unlocks when the table opens and wipes what guests left when it closes', async () => {
    const { sockets, setOpen, plainStore } = await paired(false);
    expect(await screen.findByTestId('idle-screen')).toBeOnTheScreen();
    setOpen(true);
    await act(async () => {
      sockets.last.fire(
        'event',
        frame(1, 'TableOpened', {
          tableId: TABLE_ID,
          tableSessionId: SESSION_ID,
          covers: 2,
          waiterId: STAFF.WAITER.staffId,
        }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByTestId('open-table')).toBeOnTheScreen();
    for (const key of TABLET_GUEST_KEYS) await plainStore.setItem(key, '{"cart":["Lassi"]}');

    setOpen(false);
    await act(async () => {
      sockets.last.fire(
        'event',
        frame(2, 'TableClosed', { tableId: TABLE_ID, tableSessionId: SESSION_ID }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByTestId('idle-screen')).toBeOnTheScreen();
    for (const key of TABLET_GUEST_KEYS) expect(await plainStore.getItem(key)).toBeNull();
  });

  it('[TAB-001] lets staff out with a manager’s PIN from the hidden corner, and locks again', async () => {
    const { kiosk, server } = await paired(true);
    expect(await screen.findByTestId('open-table')).toBeOnTheScreen();
    for (let tap = 0; tap < STAFF_TAPS - 1; tap += 1) {
      await fireEvent.press(screen.getByTestId('staff-corner', { includeHiddenElements: true }));
    }
    expect(screen.queryByTestId('staff-panel')).toBeNull();
    await fireEvent.press(screen.getByTestId('staff-corner', { includeHiddenElements: true }));
    expect(
      await screen.findByText(translator('mobile.tablet.staff.chooseManager')),
    ).toBeOnTheScreen();
    // Only managers and the Owner can let staff out.
    expect(screen.queryByTestId(`manager-${STAFF.WAITER.staffId}`)).toBeNull();
    await fireEvent.press(screen.getByTestId(`manager-${STAFF.MANAGER.staffId}`));
    for (const digit of ['1', '1', '1', '1']) await fireEvent.press(screen.getByText(digit));
    expect(await screen.findByText('That PIN is not right.')).toBeOnTheScreen();
    expect(kiosk.mode).toBe('LOCKED');
    for (const digit of ['2', '2', '2', '2']) await fireEvent.press(screen.getByText(digit));
    expect(await screen.findByText(translator('mobile.tablet.staff.open'))).toBeOnTheScreen();
    expect(kiosk.mode).toBe('NONE');
    expect(screen.getByText('Table: T4')).toBeOnTheScreen();
    expect(screen.getByText('Battery: 64%, charging')).toBeOnTheScreen();
    expect(server.callsTo('POST', '/api/v1/devices/current/kiosk-exit')).toHaveLength(2);
    await fireEvent.press(screen.getByText(translator('mobile.tablet.staff.lockAgain')));
    expect(screen.queryByTestId('staff-panel')).toBeNull();
    expect(kiosk.mode).toBe('LOCKED');
  });

  it('[AUTH-009] says when no manager has chosen the tablet’s table', async () => {
    const context = setup(false);
    context.server.on('GET', '/api/v1/devices/current/table', () => ({
      status: 409,
      body: { code: 'TABLET_NOT_BOUND', message: 'Not bound', correlationId: 'c' },
    }));
    await context.session.start();
    await context.session.pair('http://pos.test:3000', 'ABCD-EFGH');
    await render(<App session={context.session} translator={translator} device={context.device} />);
    await online(context.sockets);
    expect(await screen.findByText(translator('mobile.tablet.unbound'))).toBeOnTheScreen();
    expect(screen.getByText(translator('mobile.tablet.unboundHint'))).toBeOnTheScreen();
  });

  it('[TAB-003] uses the restaurant’s colour with text that reads on it', () => {
    expect(accentColorsOf('#B4232A')).toEqual({ accent: '#B4232A', onAccent: '#ffffff' });
    expect(accentColorsOf('#F2C94C')).toEqual({ accent: '#F2C94C', onAccent: '#000000' });
    expect(accentColorsOf(null)).toBeUndefined();
    expect(accentColorsOf('red')).toBeUndefined();
  });
});

describe('[MGR-006] locate', () => {
  it('flashes its name and sounds when the manager locates this tablet', async () => {
    const context = setup(false);
    await context.session.start();
    await context.session.pair('http://pos.test:3000', 'ABCD-EFGH');
    await render(<App session={context.session} translator={translator} device={context.device} />);
    await online(context.sockets);
    expect(await screen.findByTestId('idle-screen')).toBeOnTheScreen();
    await act(async () => {
      context.sockets.last.fire('event', {
        ...frame(1, 'DeviceLocateRequested', { deviceId: DEVICE_ID, seconds: 15 }),
        event: {
          ...frame(1, 'DeviceLocateRequested', { deviceId: DEVICE_ID, seconds: 15 }).event,
          occurredAt: new Date().toISOString(),
        },
      });
      await Promise.resolve();
    });
    expect(await screen.findByTestId('locate-overlay')).toBeOnTheScreen();
    expect(screen.getByText('Here I am: Table T4')).toBeOnTheScreen();
    expect(context.kiosk.tones).toEqual([3_000]);
  });

  it('ignores a request for another tablet, or one replayed long after', () => {
    const now = Date.parse('2026-09-26T08:41:00.000Z');
    const event = {
      eventId: '0199a0e0-0000-7000-8000-000000000091',
      type: 'DeviceLocateRequested' as const,
      version: 1 as const,
      occurredAt: '2026-09-26T08:40:30.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-26',
      payload: { deviceId: DEVICE_ID, seconds: 15 },
    };
    expect(locateRequest(event, DEVICE_ID, now)).toEqual({ seconds: 15 });
    expect(locateRequest(event, '0199a0e0-0000-7000-8000-000000000092', now)).toBeUndefined();
    expect(locateRequest(event, DEVICE_ID, now + 120_000)).toBeUndefined();
  });
});
