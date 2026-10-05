import { ApiRequestError, ApiUnavailableError } from '@rp/api-client';
import { InvalidServerAddressError, OtaUpdater, type OtaUpdateSource } from '@rp/mobile-core';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import {
  ConnectionBanner,
  formatPairingCode,
  LoginScreen,
  messageOf,
  PairingScreen,
  Screen,
  ShellProvider,
  UpdateRequiredScreen,
  useLive,
  useMenu,
  useAppUpdateWhenFree,
  useNow,
  useUnsentOrders,
} from '../src/index.js';
import { ADDRESS, fakeServer, newSession, renderShell, translator } from './harness.js';
import { fakeLocalServer, itemReadyFrame, STAFF } from '@rp/mobile-core/testing';
import { IDS, MENU } from '@rp/ordering/testing';

async function pressDigits(pin: string) {
  for (const digit of pin) {
    await fireEvent.press(screen.getByRole('button', { name: digit }));
  }
}

describe('[AUTH-007] pairing screen', () => {
  it('pairs with the typed server address and code', async () => {
    const server = fakeServer();
    const { session } = newSession(server);
    await session.start();
    await renderShell(session, <PairingScreen />);

    const submit = screen.getByTestId('pairing-submit');
    expect(submit).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Server address'), ADDRESS);
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), 'abcd efgh');
    expect(screen.getByLabelText('Pairing code')).toHaveDisplayValue('ABCD-EFGH');
    await fireEvent.press(submit);

    await screen.findByRole('button', { name: 'Pair device' });
    expect(session.getSnapshot().phase).toBe('paired');
    expect(server.callsTo('POST', '/api/v1/devices/pair')).toHaveLength(1);
  });

  it('says what went wrong and tells an unpaired device why', async () => {
    const server = fakeServer().on('POST', '/api/v1/devices/pair', () => ({
      status: 400,
      body: { code: 'PAIRING_CODE_INVALID', message: 'That code has expired. Ask for a new one.' },
    }));
    const { session } = newSession(server);
    await session.start();
    await renderShell(session, <PairingScreen />);
    await fireEvent.changeText(screen.getByLabelText('Server address'), 'ftp://nope');
    await fireEvent.changeText(screen.getByLabelText('Pairing code'), 'ABCDEFGH');
    await fireEvent.press(screen.getByTestId('pairing-submit'));
    expect(await screen.findByTestId('pairing-error')).toHaveTextContent(
      translator('mobile.invalidServer'),
    );

    await fireEvent.changeText(screen.getByLabelText('Server address'), ADDRESS);
    await fireEvent.press(screen.getByTestId('pairing-submit'));
    expect(await screen.findByText('That code has expired. Ask for a new one.')).toBeOnTheScreen();
  });
});

describe('[UPD-006] an app the server no longer serves', () => {
  const tooOld = () => ({
    status: 426,
    body: { code: 'CLIENT_TOO_OLD', message: 'Update the app.' },
  });

  it('asks staff to have the app updated', async () => {
    const { session } = newSession(fakeServer().on('GET', '/api/v1/auth/staff-tiles', tooOld));
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    await session.staffTiles().catch(() => undefined);
    expect(session.getSnapshot().clientTooOld).toBe(true);
    await renderShell(session, <UpdateRequiredScreen />);
    expect(screen.getByRole('header')).toHaveTextContent(translator('mobile.update.title'));
    expect(screen.getByTestId('update-required')).toHaveTextContent(
      translator('mobile.update.staff'),
    );
  });

  it('asks a table’s guests to call a waiter', async () => {
    const server = fakeLocalServer({ type: 'TABLE_TABLET', name: 'Table 4 tablet' });
    const { session } = newSession(server.on('GET', '/api/v1/auth/staff-tiles', tooOld));
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    await session.staffTiles().catch(() => undefined);
    await renderShell(session, <UpdateRequiredScreen />);
    expect(screen.getByTestId('update-required')).toHaveTextContent(
      translator('mobile.update.guests'),
    );
  });
});

describe('[UPD-001] over-the-air updates on the screens', () => {
  /** EAS Update with the vendor's rollback on offer: nothing to ask the server. */
  function rollbackSource() {
    const reload = jest.fn(() => Promise.resolve());
    const source: OtaUpdateSource = {
      enabled: true,
      emergencyLaunchReason: null,
      check: () => Promise.resolve({ kind: 'rollback' }),
      fetch: () => Promise.resolve({ kind: 'rollback' }),
      reload,
    };
    return { source, reload };
  }

  it('tells staff a refused app fixes itself when an update is on its way', async () => {
    const { session } = newSession(
      fakeServer().on('GET', '/api/v1/auth/staff-tiles', () => ({
        status: 426,
        body: { code: 'CLIENT_TOO_OLD', message: 'Update the app.' },
      })),
    );
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    await session.staffTiles().catch(() => undefined);
    const { source, reload } = rollbackSource();
    const updater = new OtaUpdater({ session, source });
    await renderShell(session, <UpdateRequiredScreen />, updater);
    expect(screen.getByTestId('update-required')).toHaveTextContent(
      translator('mobile.update.staff'),
    );
    await act(() => updater.check());
    // Refused as it is, the app restarts at once on the update.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('update-required')).toHaveTextContent(
      translator('mobile.update.onItsWay'),
    );
  });

  it('restarts on a downloaded update only while the device is free', async () => {
    const { session } = newSession();
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    const { source, reload } = rollbackSource();
    const updater = new OtaUpdater({ session, source });
    await updater.check();
    expect(updater.getSnapshot().status).toBe('ready');
    function Probe({ inUse }: { inUse: boolean }) {
      useAppUpdateWhenFree(inUse);
      return <Text>{inUse ? 'in use' : 'free'}</Text>;
    }
    // React Native's test double has no state of its own: the app is on screen, then not.
    Object.assign(AppState, { currentState: 'active' });
    const listen = jest.spyOn(AppState, 'addEventListener');
    const view = await renderShell(session, <Probe inUse />, updater);
    expect(reload).not.toHaveBeenCalled();
    const onChange = listen.mock.calls.at(-1)?.[1];
    await act(() => onChange?.('background'));
    const free = (
      <ShellProvider session={session} translator={translator} updater={updater}>
        <Probe inUse={false} />
      </ShellProvider>
    );
    await view.rerender(free);
    expect(reload).not.toHaveBeenCalled();
    await act(() => onChange?.('active'));
    expect(reload).toHaveBeenCalledTimes(1);
    listen.mockRestore();
    Object.assign(AppState, { currentState: undefined });
  });
});

describe('[AUTH-001] [AUTH-002] login screen', () => {
  async function pairedSession(server = fakeServer()) {
    const context = newSession(server);
    await context.session.start();
    await context.session.pair(ADDRESS, 'ABCD-EFGH');
    return context;
  }

  it('lists the staff for this app, takes a PIN and signs the person in', async () => {
    const { session } = await pairedSession();
    await renderShell(session, <LoginScreen roles={['WAITER', 'MANAGER']} />);
    await screen.findByRole('button', { name: 'Ravi, Waiter' });
    expect(screen.queryByText('Asha')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Ravi, Waiter' }));
    await pressDigits('4444');
    await act(async () => {
      await Promise.resolve();
    });
    expect(session.getSnapshot().person?.displayName).toBe('Ravi');
  });

  it('shows a wrong PIN and lets another person sign in instead', async () => {
    const server = fakeServer().on('POST', '/api/v1/auth/pin-login', () => ({
      status: 401,
      body: { code: 'PIN_INCORRECT', message: 'That PIN is not right. 4 tries left.' },
    }));
    const { session } = await pairedSession(server);
    await renderShell(session, <LoginScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Ravi, Waiter' }));
    await pressDigits('1234');
    expect(await screen.findByText('That PIN is not right. 4 tries left.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Not you?' }));
    expect(screen.getByRole('button', { name: 'Meera, Manager' })).toBeOnTheScreen();
  });

  it('says why a person was signed out, and when there is nobody to sign in', async () => {
    const server = fakeServer().on('GET', '/api/v1/auth/staff-tiles', () => ({
      status: 200,
      body: { staff: [] },
    }));
    const { session } = await pairedSession(server);
    await session.signIn(STAFF.WAITER.staffId, '4444');
    await session.signOut('signedOutInactive');
    await renderShell(session, <LoginScreen />);
    expect(screen.getByText(translator('login.signedOutInactive'))).toBeOnTheScreen();
    expect(await screen.findByText(translator('login.noStaff'))).toBeOnTheScreen();
  });

  it('offers a retry when the staff list cannot be read', async () => {
    let fail = true;
    const server = fakeServer().on('GET', '/api/v1/auth/staff-tiles', () =>
      fail
        ? { status: 500, body: { code: 'INTERNAL', message: 'The server had a problem.' } }
        : { status: 200, body: { staff: [STAFF.WAITER] } },
    );
    const { session } = await pairedSession(server);
    await session.signIn(STAFF.WAITER.staffId, '4444');
    await session.signOut('signedOut');
    await renderShell(session, <LoginScreen />);
    expect(await screen.findByText('The server had a problem.')).toBeOnTheScreen();
    expect(screen.getByText(translator('login.signedOut'))).toBeOnTheScreen();
    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Ravi, Waiter' })).toBeOnTheScreen();
  });
});

describe('[NFR-A01] connection banner and live data', () => {
  const load = jest.fn(() => Promise.resolve(1));

  function Counter() {
    const { data } = useLive(load, (type) => type === 'ItemStatusChanged');
    return <Text testID="counter">{data.status}</Text>;
  }

  it('shows the banner only while not connected, and reloads after events and reconnects', async () => {
    jest.useFakeTimers();
    const { session, sockets } = newSession();
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    await renderShell(
      session,
      <>
        <ConnectionBanner />
        <Counter />
      </>,
    );
    expect(screen.getByText(translator('connection.connecting'))).toBeOnTheScreen();
    await act(async () => {
      sockets.sync(0);
      await Promise.resolve();
    });
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(screen.getByTestId('counter')).toHaveTextContent('ready');

    await act(async () => {
      sockets.last.fire('event', itemReadyFrame(1));
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      sockets.last.fire('disconnect', 'transport close');
      await Promise.resolve();
    });
    expect(screen.getByText(translator('connection.offline'))).toBeOnTheScreen();
    await act(async () => {
      sockets.sync(1);
      await Promise.resolve();
    });
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });
});

describe('[MENU-013] [WTR-012] the menu and unsent orders on the device', () => {
  function Probe() {
    const menu = useMenu();
    const unsent = useUnsentOrders();
    const shown =
      menu === undefined ? 'reading' : menu === null ? 'none' : `v${String(menu.version)}`;
    return <Text testID="probe">{`${shown} ${String(unsent.length)}`}</Text>;
  }

  it('shows what the device keeps at once, then every change', async () => {
    const server = fakeServer().on('GET', '/api/v1/menu', () => ({ status: 200, body: MENU }));
    const { session } = newSession(server);
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    await session.signIn(STAFF.WAITER.staffId, '4444');
    await renderShell(session, <Probe />);
    expect(await screen.findByText('none 0')).toBeOnTheScreen();

    await act(async () => {
      await session.menu.refresh(() => session.api.getMenu());
    });
    expect(screen.getByText('v1 0')).toBeOnTheScreen();

    // The server has no order route here: the order is refused and kept for the waiter to see.
    const key = '0199a0e0-0000-7000-8000-000000005001';
    await act(async () => {
      await session.orders.submit({
        staffId: STAFF.WAITER.staffId,
        tableLabel: 'T2',
        request: {
          idempotencyKey: key,
          source: 'WAITER_APP',
          orderType: 'DINE_IN',
          tableSessionId: '0199a0e0-0000-7000-8000-000000005002',
          lines: [
            {
              clientLineId: '0199a0e0-0000-7000-8000-000000005003',
              itemId: IDS.dal,
              quantity: 1,
              modifiers: [],
            },
          ],
        },
        lines: [],
      });
    });
    expect(screen.getByText('v1 1')).toBeOnTheScreen();
    await act(async () => {
      await session.orders.dismiss(key);
      await session.menu.clear();
    });
    expect(screen.getByText('none 0')).toBeOnTheScreen();
  });

  it('keeps a footer under the scrolling content', async () => {
    await renderShell(
      newSession().session,
      <Screen title="Table T2" footer={<Text>Send KOT</Text>}>
        <Text>New items</Text>
      </Screen>,
    );
    expect(screen.getByRole('header', { name: 'Table T2' })).toBeOnTheScreen();
    expect(screen.getByText('Send KOT')).toBeOnTheScreen();
  });
});

describe('messages', () => {
  it('turns failures into plain language', () => {
    expect(
      messageOf(new ApiRequestError(400, { code: 'X', message: 'Server said so.' }), translator),
    ).toBe('Server said so.');
    expect(messageOf(new ApiUnavailableError('timeout'), translator)).toBe(
      translator('errors.timeout'),
    );
    expect(messageOf(new ApiUnavailableError('network'), translator)).toBe(
      translator('errors.network'),
    );
    expect(messageOf(new InvalidServerAddressError(), translator)).toBe(
      translator('mobile.invalidServer'),
    );
    expect(messageOf(new Error('boom'), translator)).toBe(translator('errors.generic'));
  });

  it('formats pairing codes as people type them', () => {
    expect(formatPairingCode('ab')).toBe('AB');
    expect(formatPairingCode('abcd-efgh-ij')).toBe('ABCD-EFGH');
  });
});

describe('useNow', () => {
  function Clock() {
    return <Text testID="now">{String(useNow(1_000))}</Text>;
  }

  it('ticks at the interval and stops when unmounted', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-27T10:00:00.000Z'));
    const view = await renderShell(newSession().session, <Clock />);
    const start = Date.parse('2026-09-27T10:00:00.000Z');
    expect(screen.getByTestId('now')).toHaveTextContent(String(start));
    await act(async () => {
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(screen.getByTestId('now')).toHaveTextContent(String(start + 1_000));
    const clear = jest.spyOn(globalThis, 'clearInterval');
    await view.unmount();
    expect(clear).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
