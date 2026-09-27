import { createTranslator } from '@rp/i18n';
import { DeviceSession, MemoryStore } from '@rp/mobile-core';
import { FakeKeys, fakeLocalServer, itemReadyFrame, SocketFactory } from '@rp/mobile-core/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { App } from '../src/App';
import { affectsTables } from '../src/WaiterHome';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const translator = createTranslator();
const TABLE_ID = '0199a0e0-0000-7000-8000-0000000071a1';

function overview(state: 'FREE' | 'OCCUPIED') {
  return {
    tables: [
      {
        tableId: TABLE_ID,
        label: 'T1',
        sectionId: '0199a0e0-0000-7000-8000-0000000051a1',
        capacity: 4,
        state,
        session:
          state === 'FREE'
            ? null
            : {
                id: '0199a0e0-0000-7000-8000-0000000061a1',
                openedAt: new Date().toISOString(),
                covers: 3,
                waiterId: '0199a0e0-0000-7000-8000-000000000104',
                waiterName: 'Ravi',
                amountSoFar: 0,
                pendingApprovals: 0,
              },
        activeServiceRequests: 0,
      },
    ],
  };
}

function setup() {
  let state: 'FREE' | 'OCCUPIED' = 'FREE';
  const server = fakeLocalServer().on('GET', '/api/v1/tables/overview', () => ({
    status: 200,
    body: overview(state),
  }));
  const sockets = new SocketFactory();
  const session = new DeviceSession({
    secureStore: new MemoryStore(),
    plainStore: new MemoryStore(),
    keys: new FakeKeys(),
    fetch: server.fetch,
    connect: sockets.connect,
  });
  return {
    session,
    sockets,
    server,
    occupy: () => {
      state = 'OCCUPIED';
    },
  };
}

describe('[WTR-001] waiter app smoke flow', () => {
  it('pairs, signs a waiter in, shows live tables and signs out', async () => {
    const { session, sockets, server, occupy } = setup();
    await session.start();
    await render(<App session={session} translator={translator} />);

    await fireEvent.changeText(screen.getByLabelText('Server address'), 'http://pos.test:3000');
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), 'ABCDEFGH');
    await fireEvent.press(screen.getByTestId('pairing-submit'));

    await fireEvent.press(await screen.findByRole('button', { name: 'Ravi, Waiter' }));
    // Kitchen staff do not sign in on a waiter phone.
    for (const digit of '4444') {
      await fireEvent.press(screen.getByRole('button', { name: digit }));
    }

    expect(await screen.findByLabelText('T1, Free')).toBeOnTheScreen();
    expect(screen.getByText('Signed in as Ravi')).toBeOnTheScreen();

    jest.useFakeTimers();
    occupy();
    await act(async () => {
      sockets.sync(0);
      sockets.last.fire('event', itemReadyFrame(1));
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    jest.useRealTimers();
    expect(await screen.findByLabelText('T1, Occupied · 3 guests · Ravi')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Tap your name')).toBeOnTheScreen();
    expect(server.callsTo('POST', '/api/v1/auth/logout')).toHaveLength(1);
  });

  it('only offers waiters and managers on the login screen', async () => {
    const { session } = setup();
    await session.start();
    await session.pair('http://pos.test:3000', 'ABCD-EFGH');
    await render(<App session={session} translator={translator} />);
    expect(await screen.findByRole('button', { name: 'Meera, Manager' })).toBeOnTheScreen();
    expect(screen.queryByText('Imran')).toBeNull();
    expect(screen.queryByText('Asha')).toBeNull();
  });

  it('says when there are no tables, and offers a retry when they cannot be read', async () => {
    let calls = 0;
    const { session, server } = setup();
    server.on('GET', '/api/v1/tables/overview', () => {
      calls += 1;
      return calls === 1
        ? { status: 500, body: { code: 'INTERNAL', message: 'The server had a problem.' } }
        : { status: 200, body: { tables: [] } };
    });
    await session.start();
    await session.pair('http://pos.test:3000', 'ABCD-EFGH');
    await session.signIn('0199a0e0-0000-7000-8000-000000000104', '4444');
    await render(<App session={session} translator={translator} />);
    expect(await screen.findByText('The server had a problem.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(translator('mobile.tables.empty'))).toBeOnTheScreen();
  });

  it('reloads tables for table, order and bill events only', () => {
    expect(affectsTables('TableSessionOpened')).toBe(true);
    expect(affectsTables('OrderSubmitted')).toBe(true);
    expect(affectsTables('ItemStatusChanged')).toBe(true);
    expect(affectsTables('MenuPublished')).toBe(false);
  });
});
