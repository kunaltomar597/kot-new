import { eventFrame } from '@rp/mobile-core/testing';
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import { PAGER_REFRESH_MS } from '../src/PagerCard';
import { mayMove } from '../src/MoveSheet';
import { KIRAN, PAGER_ID, RAVI, Restaurant, signedInApp } from './restaurant';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const tile = (name: RegExp | string) => screen.findByRole('button', { name });

describe('[WTR-002] my tables', () => {
  it('shows the waiter’s section with state, guests, time seated, waiter and requests', async () => {
    await signedInApp();
    expect(await tile('T1, Free')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'T2, Occupied, 3 guests, 25 min, Ravi, 1 request' }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^T3, Bill asked/ })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Hall' })).toBeOnTheScreen();
    // Terrace is someone else's today.
    expect(screen.queryByRole('button', { name: /^T4/ })).toBeNull();
    expect(screen.getByRole('tab', { name: 'My tables' })).toBeSelected();

    await fireEvent.press(screen.getByRole('tab', { name: 'All tables' }));
    expect(await tile(/^T5, Occupied, 4 guests, 25 min, Kiran/)).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Terrace' })).toBeOnTheScreen();
  });

  it('adds a table given to the waiter directly, and says when nothing is theirs', async () => {
    const restaurant = new Restaurant();
    restaurant.assignments = [
      { staffId: RAVI, staffName: 'Ravi', sectionIds: [], tableIds: [restaurant.table('T4').id] },
    ];
    await signedInApp(restaurant);
    // T4 is given to Ravi; T2 and T3 are still his because he is their responsible waiter.
    expect(await tile('T4, Free')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^T2/ })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^T1/ })).toBeNull();

    const empty = new Restaurant();
    empty.assignments = [];
    for (const table of empty.tables) {
      if (table.session?.waiterId === RAVI) table.session = { ...table.session, waiterId: KIRAN };
    }
    await signedInApp(empty);
    expect(
      await screen.findByText(
        'No tables are assigned to you today. Show all tables, or ask a manager.',
      ),
    ).toBeOnTheScreen();
  });
});

describe('[TBL-003] opening a table', () => {
  it('opens a free table with the guests chosen, then lands on it to take the order', async () => {
    const { server, restaurant } = await signedInApp();
    await fireEvent.press(await tile('T1, Free'));
    expect(screen.getByRole('header', { name: 'Open T1' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'One more' }));
    await fireEvent.press(screen.getByTestId('open-table'));
    expect(await screen.findByText('T1 is open')).toBeOnTheScreen();
    expect(server.callsTo('POST', `/api/v1/tables/${restaurant.table('T1').id}/open`)).toEqual([
      expect.objectContaining({ body: { covers: 3 } }),
    ]);
    expect(await screen.findByRole('header', { name: 'Table T1' })).toBeOnTheScreen();
    expect(await screen.findByText(/^Occupied · 3 guests/)).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Back to tables' }));
    expect(await tile(/^T1, Occupied, 3 guests/)).toBeOnTheScreen();
  });

  it('keeps the sheet open with the server’s answer when another device got there first', async () => {
    const restaurant = new Restaurant();
    const server = restaurant.server();
    await signedInApp(restaurant, server);
    await fireEvent.press(await tile('T1, Free'));
    restaurant.table('T1').state = 'OCCUPIED';
    await fireEvent.press(screen.getByTestId('open-table'));
    expect(await screen.findByText('Someone has just opened this table.')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Open T1' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('sheet-close'));
    expect(screen.queryByRole('header', { name: 'Open T1' })).toBeNull();
  });
});

describe('[TBL-005] [WTR-008] moving a table and asking for the bill', () => {
  it('moves the waiter’s table to a free one and stays on it', async () => {
    const { server, restaurant } = await signedInApp();
    await fireEvent.press(await tile(/^T2, Occupied/));
    expect(await screen.findByRole('header', { name: 'Table T2' })).toBeOnTheScreen();
    await fireEvent.press(await screen.findByRole('button', { name: 'Move table' }));
    expect(screen.getByRole('header', { name: 'Move T2 to' })).toBeOnTheScreen();
    const sheet = screen.getByTestId(`move-to-${restaurant.table('T4').id}`);
    expect(within(sheet).getByText('T4')).toBeOnTheScreen();
    await fireEvent.press(sheet);
    expect(await screen.findByText('T2 moved to T4')).toBeOnTheScreen();
    const [call] = server.callsTo(
      'POST',
      '/api/v1/table-sessions/0199a0e0-0000-7000-8000-000000009002/move',
    );
    expect(call?.body).toEqual({ toTableId: restaurant.table('T4').id });
    // The same guests, now at T4.
    expect(await screen.findByRole('header', { name: 'Table T4' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to tables' }));
    expect(await tile('T2, Free')).toBeOnTheScreen();
  });

  it('goes back from the move list, and says when no table is free', async () => {
    const restaurant = new Restaurant();
    for (const table of restaurant.tables) {
      if (table.state === 'FREE') table.state = 'BILL_PRINTED';
    }
    await signedInApp(restaurant);
    await fireEvent.press(await tile(/^T2, Occupied/));
    await fireEvent.press(await screen.findByRole('button', { name: 'Move table' }));
    expect(screen.getByText('There is no free table to move to.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('header', { name: 'Move T2 to' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request bill' })).toBeOnTheScreen();
  });

  it('asks for the bill once, and not again while it is asked for', async () => {
    const { server } = await signedInApp();
    await fireEvent.press(await tile(/^T2, Occupied/));
    await fireEvent.press(await screen.findByRole('button', { name: 'Request bill' }));
    expect(
      await screen.findByText('The cashier has been asked for the bill for T2.'),
    ).toBeOnTheScreen();
    expect(
      server.callsTo(
        'POST',
        '/api/v1/table-sessions/0199a0e0-0000-7000-8000-000000009002/request-bill',
      ),
    ).toHaveLength(1);
    expect(await screen.findByText(/^Bill asked · 3 guests/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Request bill' })).toBeNull();
  });

  it('offers Move only on the waiter’s own tables; managers move any', async () => {
    const restaurant = new Restaurant();
    const entry = (label: string) => {
      const table = restaurant.overview().tables.find((candidate) => candidate.label === label);
      if (table === undefined) throw new Error(label);
      return table;
    };
    expect(mayMove(entry('T2'), { id: RAVI, role: 'WAITER' })).toBe(true);
    expect(mayMove(entry('T5'), { id: RAVI, role: 'WAITER' })).toBe(false);
    expect(mayMove(entry('T5'), { id: RAVI, role: 'MANAGER' })).toBe(true);
    expect(mayMove(entry('T5'), { id: RAVI, role: 'KITCHEN' })).toBe(false);

    await signedInApp(restaurant);
    await fireEvent.press(await screen.findByRole('tab', { name: 'All tables' }));
    await fireEvent.press(await tile(/^T5, Occupied/));
    expect(await screen.findByRole('header', { name: 'Table T5' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Move table' })).toBeNull();
  });

  it('shows why a bill request was refused, and goes back with the phone’s back button', async () => {
    const restaurant = new Restaurant();
    const server = restaurant
      .server()
      .on('POST', '/api/v1/table-sessions/:sessionId/request-bill', () => ({
        status: 409,
        body: { code: 'NOTHING_TO_BILL', message: 'Nothing to bill yet.' },
      }));
    const back = jest.spyOn(BackHandler, 'addEventListener');
    await signedInApp(restaurant, server);
    await fireEvent.press(await tile(/^T2, Occupied/));
    await fireEvent.press(await screen.findByRole('button', { name: 'Request bill' }));
    expect(await screen.findByText('Nothing to bill yet.')).toBeOnTheScreen();

    const handler = back.mock.calls.at(-1)?.[1];
    await act(async () => {
      expect(handler?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true);
      await Promise.resolve();
    });
    expect(await tile(/^T2, Occupied/)).toBeOnTheScreen();
    back.mockRestore();
  });
});

describe('[WTR-014] the waiter’s pager', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows it connected with its battery', async () => {
    await signedInApp();
    const card = await screen.findByTestId('pager-card');
    expect(card).toHaveProp('accessibilityLabel', 'My pager: Pager 3, Connected, Battery 80%');
  });

  it('warns when the pager is not connected or low, and reads it again when that changes', async () => {
    // Fake time from the start, so the card's minute timer is a fake one too.
    jest.useFakeTimers();
    const restaurant = new Restaurant();
    const { sockets } = await signedInApp(restaurant);
    expect(await screen.findByTestId('pager-card')).toBeOnTheScreen();
    if (restaurant.pager !== null) restaurant.pager = { ...restaurant.pager, online: false };
    await act(async () => {
      sockets.sync(0);
      sockets.last.fire(
        'event',
        eventFrame(1, 'DeviceStatusChanged', {
          deviceId: PAGER_ID,
          deviceType: 'PAGER',
          online: false,
          batteryPercent: 80,
        }),
      );
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(
      await screen.findByText('Your pager is not connected. Alerts still reach this phone.'),
    ).toBeOnTheScreen();

    // Battery levels are not announced: the card reads the pager again every minute.
    if (restaurant.pager !== null) {
      restaurant.pager = { ...restaurant.pager, online: true, batteryPercent: 12 };
    }
    await act(async () => {
      jest.advanceTimersByTime(PAGER_REFRESH_MS);
      await Promise.resolve();
    });
    jest.useRealTimers();
    expect(await screen.findByText('Your pager battery is low. Charge it soon.')).toBeOnTheScreen();
    expect(screen.getByTestId('pager-card')).toHaveProp('accessibilityRole', 'alert');
  });

  it('says when no pager is given, or when its status cannot be read', async () => {
    const restaurant = new Restaurant();
    restaurant.pager = null;
    await signedInApp(restaurant);
    expect(await screen.findByText('No pager is given to you.')).toBeOnTheScreen();

    const broken = new Restaurant();
    const server = broken.server().on('GET', '/api/v1/pagers/mine', () => ({
      status: 500,
      body: { code: 'INTERNAL', message: 'The server had a problem.' },
    }));
    await signedInApp(broken, server);
    expect(await screen.findByText('Your pager status could not be read.')).toBeOnTheScreen();
  });
});
