import { DeviceSession, MemoryStore } from '@rp/mobile-core';
import { FakeKeys, itemReadyFrame, SocketFactory } from '@rp/mobile-core/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { App } from '../src/App';
import { Restaurant, signedInApp, translator } from './restaurant';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

function setup() {
  const restaurant = new Restaurant();
  const server = restaurant.server();
  const sockets = new SocketFactory();
  const session = new DeviceSession({
    secureStore: new MemoryStore(),
    plainStore: new MemoryStore(),
    keys: new FakeKeys(),
    fetch: server.fetch,
    connect: sockets.connect,
  });
  return { restaurant, server, session, sockets };
}

describe('[WTR-001] waiter app smoke flow', () => {
  it('pairs, signs a waiter in, shows live tables and signs out', async () => {
    const { restaurant, session, sockets, server } = setup();
    await session.start();
    await render(<App session={session} translator={translator} />);

    await fireEvent.changeText(screen.getByLabelText('Server address'), 'http://pos.test:3000');
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), 'ABCDEFGH');
    await fireEvent.press(screen.getByTestId('pairing-submit'));

    await fireEvent.press(await screen.findByRole('button', { name: 'Ravi, Waiter' }));
    for (const digit of '4444') {
      await fireEvent.press(screen.getByRole('button', { name: digit }));
    }

    expect(await screen.findByRole('button', { name: 'T1, Free' })).toBeOnTheScreen();
    expect(screen.getByText('Signed in as Ravi')).toBeOnTheScreen();

    // Another device opens T1: the kitchen event makes the screen read the tables again.
    jest.useFakeTimers();
    restaurant.table('T1').state = 'OCCUPIED';
    await act(async () => {
      sockets.sync(0);
      sockets.last.fire('event', itemReadyFrame(1));
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    jest.useRealTimers();
    expect(await screen.findByRole('button', { name: 'T1, Occupied' })).toBeOnTheScreen();

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
    const restaurant = new Restaurant();
    const server = restaurant.server();
    let calls = 0;
    server.on('GET', '/api/v1/tables/overview', () => {
      calls += 1;
      return calls === 1
        ? { status: 500, body: { code: 'INTERNAL', message: 'The server had a problem.' } }
        : { status: 200, body: { tables: [] } };
    });
    await signedInApp(restaurant, server);
    expect(await screen.findByText('The server had a problem.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(translator('mobile.tables.empty'))).toBeOnTheScreen();
  });
});
