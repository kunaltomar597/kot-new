import type { AlertView, DeviceAlertsResponse } from '@rp/contracts';
import {
  alertRaisedFrame,
  alertView,
  type FakeServer,
  fakeLocalServer,
  HOLDER,
} from '@rp/mobile-core/testing';
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { Text } from 'react-native';
import { LoginScreen, Screen } from '../src/index.js';
import { ADDRESS, newSession, renderShell } from './harness.js';

const ALERTS = '/api/v1/devices/current/alerts';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const ready = alertView({ createdAt: minutesAgo(4) });
const bill = alertView({
  id: '0199a0e0-0000-7000-8000-0000000a1e02',
  type: 'BILL_REQUEST',
  tableLabel: '7',
  pagerText: 'T7 BILL',
  payload: { requestedFrom: 'TABLE_TABLET' },
  repeatCount: 2,
  escalatedAt: minutesAgo(1),
  createdAt: minutesAgo(2),
});

const held = (...alerts: AlertView[]): DeviceAlertsResponse => ({ holder: HOLDER, alerts });

/** A server listing `alerts` for the waiter; acknowledging answers with `acknowledged` in turn. */
function serverWith(alerts: DeviceAlertsResponse, ...acknowledged: { status: number }[]) {
  const server = fakeLocalServer().on('GET', ALERTS, () => ({ status: 200, body: alerts }));
  return server.on(
    'POST',
    `${ALERTS}/:alertId/acknowledge`,
    ...(acknowledged.length === 0 ? [{ status: 200 }] : acknowledged).map(
      ({ status }) =>
        (call: { path: string }) =>
          status === 200
            ? {
                status,
                body: {
                  ...(call.path.includes(bill.id) ? bill : ready),
                  status: 'ACKNOWLEDGED',
                },
              }
            : { status, body: { code: 'UNAVAILABLE', message: 'The server is busy.' } },
    ),
  );
}

async function phoneShowing(
  server: FakeServer,
  ui: Parameters<typeof renderShell>[1],
  { signIn = true, followAlerts = true } = {},
) {
  const { session, sockets } = newSession(server, undefined, { followAlerts });
  await session.start();
  await session.pair(ADDRESS, 'ABCD-EFGH');
  if (signIn) await session.signIn(HOLDER.staffId, '1234');
  await renderShell(session, ui);
  await act(async () => {
    sockets.sync();
    await Promise.resolve();
  });
  return { session, sockets };
}

const tables = (
  <Screen title="Tables">
    <Text>My tables</Text>
  </Screen>
);

describe('[WTR-006] [NFR-U03] the alert banner on the waiter app', () => {
  it('shows the newest alert over the screen and acknowledges it in one tap', async () => {
    const server = serverWith(held(ready, bill));
    await phoneShowing(server, tables);

    const banner = await screen.findByTestId('alert-banner');
    expect(banner).toHaveTextContent(/Table 7 · Bill requested/);
    expect(banner).toHaveTextContent(/Asked on the table tablet · 2 min ago · \+1 more/);
    expect(screen.getByText('My tables')).toBeOnTheScreen();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Acknowledge Table 7 · Bill requested' }),
    );
    expect(server.callsTo('POST', `${ALERTS}/${bill.id}/acknowledge`)).toHaveLength(1);
    expect(await screen.findByText(/Table 5 · Food ready/)).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('alert-banner')).getByText('Paneer Tikka · 4 min ago'),
    ).toBeOnTheScreen();
  });

  it('lists every open alert, newest first, with its age, reminders and escalation', async () => {
    const server = serverWith(held(ready, bill));
    await phoneShowing(server, tables);
    await fireEvent.press(await screen.findByTestId('alert-banner-open'));

    expect(screen.getByRole('header', { name: 'Alerts' })).toBeOnTheScreen();
    const [first, second, ...others] = screen.getAllByTestId(/^alert-[0-9a-f-]+$/);
    if (first === undefined || second === undefined) throw new Error('Two alerts are listed');
    expect(others).toHaveLength(0);
    expect(first).toHaveProp('testID', `alert-${bill.id}`);
    expect(
      within(first).getByText('2 min ago · Reminded 2 times · Managers were alerted too'),
    ).toBeOnTheScreen();
    expect(second).toHaveProp('testID', `alert-${ready.id}`);
    expect(within(second).getByText('Paneer Tikka')).toBeOnTheScreen();

    await fireEvent.press(within(second).getByRole('button', { name: /^Acknowledge/ }));
    await fireEvent.press(within(first).getByRole('button', { name: /^Acknowledge/ }));
    expect(await screen.findByTestId('alerts-none')).toHaveTextContent(
      'No open alerts. New ones ring here and on the pager.',
    );
    expect(screen.queryByTestId('alert-banner')).toBeNull();
  });

  it('[AUTH-005] keeps showing the holder’s alerts on the sign-in screen', async () => {
    const server = serverWith(held(ready));
    await phoneShowing(server, <LoginScreen roles={['WAITER']} />, { signIn: false });

    const banner = await screen.findByTestId('alert-banner');
    expect(within(banner).getByText('Paneer Tikka · 4 min ago · For Ravi')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Acknowledge Table 5 · Food ready' }));
    expect(server.callsTo('POST', `${ALERTS}/${ready.id}/acknowledge`)).toHaveLength(1);
  });

  it('names whose alerts the list shows when they are not signed in', async () => {
    await phoneShowing(serverWith(held(ready)), <LoginScreen roles={['WAITER']} />, {
      signIn: false,
    });
    await fireEvent.press(await screen.findByTestId('alert-banner-open'));
    expect(screen.getByRole('header', { name: 'Alerts for Ravi' })).toBeOnTheScreen();
    expect(
      screen.getByText('Alerts for Ravi keep coming to this phone until they sign out on it.'),
    ).toBeOnTheScreen();
  });

  it('[NFR-U04] says why an alert was not acknowledged, and keeps it', async () => {
    const server = serverWith(held(ready), { status: 503 });
    await phoneShowing(server, tables);
    await fireEvent.press(await screen.findByTestId('alert-banner-acknowledge'));
    expect(await screen.findByTestId('alert-banner-error')).toHaveTextContent(
      'Not acknowledged: The server is busy.',
    );
    expect(screen.getByTestId('alert-banner')).toHaveTextContent(/Table 5 · Food ready/);
  });

  it('shows a new alert as it rings', async () => {
    let listed = held(ready);
    const server = fakeLocalServer().on('GET', ALERTS, () => ({ status: 200, body: listed }));
    const { sockets } = await phoneShowing(server, tables);
    await screen.findByText(/Table 5 · Food ready/);
    listed = held(ready, bill);
    await act(async () => {
      sockets.last.fire('event', alertRaisedFrame(1, bill));
      await Promise.resolve();
    });
    expect(await screen.findByText(/Table 7 · Bill requested/)).toBeOnTheScreen();
  });

  it('shows nothing on a device that follows no alerts (the table tablet)', async () => {
    const server = serverWith(held(ready));
    await phoneShowing(server, tables, { followAlerts: false });
    expect(screen.getByText('My tables')).toBeOnTheScreen();
    expect(screen.queryByTestId('alert-banner')).toBeNull();
    expect(server.callsTo('GET', ALERTS)).toHaveLength(0);
  });
});
