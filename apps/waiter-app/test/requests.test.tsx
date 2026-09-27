import { eventFrame } from '@rp/mobile-core/testing';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { KIRAN, Restaurant, signedInApp, T2_SESSION } from './restaurant';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const inbox = () => screen.findByTestId('service-requests');
/** T2's water, asked for four minutes before each test. */
const T2_WATER = '0199a0e0-0000-7000-8000-000000009601';

const gone = () =>
  waitFor(() => {
    expect(screen.queryByTestId('service-requests')).toBeNull();
  });

const byKiran = () => ({
  state: 'ACKNOWLEDGED' as const,
  acknowledgedAt: new Date().toISOString(),
  acknowledgedById: KIRAN,
  acknowledgedByName: 'Kiran',
});

describe('[WTR-005] the service request inbox', () => {
  it('lists the requests at the waiter’s tables with table and age, then every table’s', async () => {
    const restaurant = new Restaurant();
    restaurant.ask('T5', 'WAITER', 3, {
      state: 'ESCALATED',
      escalatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    restaurant.ask('T3', 'BILL', 2, byKiran());
    await signedInApp(restaurant);

    const mine = await inbox();
    expect(within(mine).getByRole('header', { name: '2 requests from tables' })).toBeOnTheScreen();
    const water = within(mine).getByTestId(`request-${T2_WATER}`);
    expect(within(water).getByText('Table T2 · Water requested')).toBeOnTheScreen();
    expect(within(water).getByText('4 min ago')).toBeOnTheScreen();
    expect(
      within(water).getByRole('button', { name: 'Acknowledge Table T2 · Water requested' }),
    ).toBeOnTheScreen();
    expect(
      within(water).getByRole('button', { name: 'Resolve Table T2 · Water requested' }),
    ).toBeOnTheScreen();
    // Someone is on the way to T3: only Resolve is left.
    expect(within(mine).getByText('2 min ago · Kiran is on the way')).toBeOnTheScreen();
    expect(within(mine).queryByRole('button', { name: /^Acknowledge Table T3/ })).toBeNull();
    expect(
      within(mine).getByRole('button', { name: 'Resolve Table T3 · Bill requested' }),
    ).toBeOnTheScreen();
    // T5 is Kiran's, on the terrace.
    expect(within(mine).queryByText(/Table T5/)).toBeNull();

    await fireEvent.press(screen.getByRole('tab', { name: 'All tables' }));
    const all = await inbox();
    expect(within(all).getByRole('header', { name: '3 requests from tables' })).toBeOnTheScreen();
    expect(within(all).getByText('3 min ago · Managers were alerted too')).toBeOnTheScreen();
    // Oldest first.
    const [first, second, third] = within(all).getAllByText(/^Table T/);
    expect(first).toHaveTextContent('Table T2 · Water requested');
    expect(second).toHaveTextContent('Table T5 · Waiter called');
    expect(third).toHaveTextContent('Table T3 · Bill requested');
  });

  it('acknowledges ("on my way") and resolves in one tap each', async () => {
    const { server } = await signedInApp();
    await inbox();
    await fireEvent.press(screen.getByTestId(`request-${T2_WATER}-acknowledge`));
    expect(await screen.findByText('4 min ago · Ravi is on the way')).toBeOnTheScreen();
    expect(screen.queryByTestId(`request-${T2_WATER}-acknowledge`)).toBeNull();
    expect(server.callsTo('POST', `/api/v1/service-requests/${T2_WATER}/acknowledge`)).toHaveLength(
      1,
    );

    await fireEvent.press(screen.getByTestId(`request-${T2_WATER}-resolve`));
    await gone();
    expect(server.callsTo('POST', `/api/v1/service-requests/${T2_WATER}/resolve`)).toHaveLength(1);
  });

  it('resolves an unanswered request at once, as Cancel on the tablet does', async () => {
    const { restaurant } = await signedInApp();
    await inbox();
    await fireEvent.press(screen.getByTestId(`request-${T2_WATER}-resolve`));
    await gone();
    expect(restaurant.serviceRequests[0]).toMatchObject({
      state: 'RESOLVED',
      acknowledgedByName: 'Ravi',
    });
    expect(restaurant.openRequests(T2_SESSION)).toEqual([]);
  });

  it('reads the requests again when a table asks', async () => {
    const restaurant = new Restaurant();
    const { sockets } = await signedInApp(restaurant);
    await inbox();
    const bill = restaurant.ask('T3', 'BILL', 0);
    await act(async () => {
      sockets.sync(0);
      sockets.last.fire(
        'event',
        eventFrame(1, 'ServiceRequestRaised', {
          serviceRequestId: bill.id,
          tableId: bill.tableId,
          type: 'BILL',
        }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText('Table T3 · Bill requested')).toBeOnTheScreen();
    expect(screen.getByText('Just now')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: '2 requests from tables' })).toBeOnTheScreen();
  });

  it('shows who got there first, and what is left when another device dealt with it', async () => {
    const restaurant = new Restaurant();
    await signedInApp(restaurant);
    await inbox();
    // Kiran acknowledged on his phone meanwhile: his stands.
    restaurant.update(T2_WATER, byKiran());
    await fireEvent.press(screen.getByTestId(`request-${T2_WATER}-acknowledge`));
    expect(await screen.findByText('4 min ago · Kiran is on the way')).toBeOnTheScreen();

    // The diner pressed Cancel on the tablet meanwhile.
    restaurant.update(T2_WATER, { state: 'CANCELLED', closedAt: new Date().toISOString() });
    await fireEvent.press(screen.getByTestId(`request-${T2_WATER}-resolve`));
    await gone();
    expect(restaurant.serviceRequests[0]).toMatchObject({ state: 'CANCELLED' });
  });

  it('says why an action failed, and keeps the request', async () => {
    const restaurant = new Restaurant();
    const server = restaurant
      .server()
      .on('POST', '/api/v1/service-requests/:requestId/acknowledge', () => ({
        status: 500,
        body: { code: 'INTERNAL', message: 'The server had a problem.' },
      }));
    await signedInApp(restaurant, server);
    await inbox();
    await fireEvent.press(screen.getByTestId(`request-${T2_WATER}-acknowledge`));
    expect(
      await screen.findByText('Not acknowledged: The server had a problem.'),
    ).toBeOnTheScreen();
    expect(screen.getByTestId(`request-${T2_WATER}-acknowledge`)).toBeOnTheScreen();
  });

  it('shows a table’s own requests on its screen', async () => {
    const restaurant = new Restaurant();
    restaurant.ask('T3', 'WAITER', 1);
    await signedInApp(restaurant);
    await fireEvent.press(await screen.findByRole('button', { name: /^T2, Occupied/ }));
    expect(await screen.findByRole('header', { name: 'Table T2' })).toBeOnTheScreen();
    const own = await inbox();
    expect(within(own).getByRole('header', { name: '1 request from a table' })).toBeOnTheScreen();
    expect(within(own).getByText('Table T2 · Water requested')).toBeOnTheScreen();
    expect(within(own).queryByText(/Table T3/)).toBeNull();
    await fireEvent.press(within(own).getByTestId(`request-${T2_WATER}-resolve`));
    await gone();
  });

  it('says when the requests cannot be read, with a retry', async () => {
    const restaurant = new Restaurant();
    let broken = true;
    const server = restaurant
      .server()
      .on('GET', '/api/v1/service-requests', () =>
        broken
          ? { status: 500, body: { code: 'INTERNAL', message: 'The server had a problem.' } }
          : { status: 200, body: { requests: restaurant.requestViews() } },
      );
    await signedInApp(restaurant, server);
    const failed = await screen.findByTestId('service-requests-failed');
    expect(
      within(failed).getByText('The requests from tables could not be read.'),
    ).toBeOnTheScreen();
    broken = false;
    await fireEvent.press(within(failed).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Table T2 · Water requested')).toBeOnTheScreen();
  });
});
