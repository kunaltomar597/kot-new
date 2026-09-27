import type { OrderView } from '@rp/contracts';
import type { OrderItemState } from '@rp/domain';
import { STAFF } from '@rp/mobile-core/testing';
import { fireEvent, screen, within } from '@testing-library/react-native';
import { IDS, Restaurant, signedInApp, T2_SESSION } from './restaurant';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const id = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const button = (name: RegExp | string) => screen.getByRole('button', { name });
const T5_SESSION = id(9005);
const DAL = id(6201);
const TIKKA = id(6202);

/** A sent order for a table, with a Dal Makhani and a Paneer Tikka in the given states. */
function sent(
  restaurant: Restaurant,
  dal: OrderItemState,
  tikka: OrderItemState,
  sessionId = T2_SESSION,
): OrderView {
  const line = (itemId: string, lineId: string, name: string, state: OrderItemState) => ({
    id: lineId,
    itemId,
    parentOrderItemId: null,
    name,
    variantId: null,
    variantName: null,
    modifiers: [],
    quantity: 1,
    unitPrice: 24_000,
    lineTotal: 24_000,
    stationId: IDS.kitchen,
    state,
    instructions: null,
  });
  const order: OrderView = {
    id: id(6200),
    orderNumber: 14,
    orderType: 'DINE_IN',
    source: 'WAITER_APP',
    status: 'OPEN',
    tableSessionId: sessionId,
    tableId: null,
    takeawayToken: null,
    customerName: null,
    businessDate: '2026-09-26',
    createdAt: '2026-09-26T08:10:00.000Z',
    note: null,
    items: [line(IDS.dal, DAL, 'Dal Makhani', dal), line(IDS.tikka, TIKKA, 'Paneer Tikka', tikka)],
    kots: [],
  };
  restaurant.orders.set(sessionId, [order]);
  return order;
}

async function openTable(label: string) {
  await fireEvent.press(await screen.findByRole('button', { name: new RegExp(`^${label}, `) }));
  expect(await screen.findByRole('header', { name: `Table ${label}` })).toBeOnTheScreen();
}

const line = (lineId: string) => screen.getByTestId(`sent-line-${lineId}`);

async function pressDigits(pin: string) {
  for (const digit of pin) {
    await fireEvent.press(button(digit));
  }
}

describe('[WTR-007] [KDS-007] serving', () => {
  it('shows ready dishes on the table tile, and marks one picked up and then served', async () => {
    const restaurant = new Restaurant();
    sent(restaurant, 'READY', 'PREPARING');
    const { server } = await signedInApp(restaurant);
    expect(
      await screen.findByRole('button', {
        name: 'T2, Occupied, 3 guests, 25 min, Ravi, 1 dish ready',
      }),
    ).toBeOnTheScreen();
    await openTable('T2');

    await screen.findByText('1 × Dal Makhani');
    // Still cooking: nothing to serve yet.
    expect(screen.queryByRole('button', { name: 'Mark Paneer Tikka served' })).toBeNull();
    await fireEvent.press(button('Mark Dal Makhani picked up'));
    expect(await within(line(DAL)).findByText('Picked up')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Mark Dal Makhani picked up' })).toBeNull();

    await fireEvent.press(button('Mark Dal Makhani served'));
    expect(await within(line(DAL)).findByText('Served')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Mark Dal Makhani served' })).toBeNull();
    expect(
      server.callsTo('POST', `/api/v1/order-items/${DAL}/status`).map((call) => call.body),
    ).toEqual([{ event: 'PICK_UP' }, { event: 'SERVE' }]);
  });

  it('marks every ready dish served in one tap', async () => {
    const restaurant = new Restaurant();
    sent(restaurant, 'READY', 'PICKED_UP');
    await signedInApp(restaurant);
    await openTable('T2');

    await fireEvent.press(await screen.findByTestId('serve-all'));
    expect(await screen.findByText('2 dishes marked served')).toBeOnTheScreen();
    expect(restaurant.item(DAL)?.state).toBe('SERVED');
    expect(restaurant.item(TIKKA)?.state).toBe('SERVED');
    expect(screen.queryByTestId('serve-all')).toBeNull();
  });

  it("says why a step was refused, and shows the item's state now", async () => {
    const restaurant = new Restaurant();
    sent(restaurant, 'READY', 'PREPARING');
    await signedInApp(restaurant);
    await openTable('T2');
    await screen.findByText('1 × Dal Makhani');
    // Someone served it from another device a moment ago.
    restaurant.setState(DAL, 'SERVED');
    await fireEvent.press(button('Mark Dal Makhani picked up'));
    expect(await screen.findByText('Dal Makhani has moved on already.')).toBeOnTheScreen();
    expect(await within(line(DAL)).findByText('Served')).toBeOnTheScreen();
  });
});

describe('[WTR-009] [ORD-011] cancellations and voids', () => {
  it('cancels a dish the kitchen has not started, with a reason', async () => {
    const restaurant = new Restaurant();
    sent(restaurant, 'SENT', 'PREPARING');
    const { server } = await signedInApp(restaurant);
    await openTable('T2');

    // Started dishes can only be voided.
    await screen.findByText('1 × Paneer Tikka');
    expect(screen.queryByRole('button', { name: 'Cancel Paneer Tikka' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void Dal Makhani' })).toBeNull();

    await fireEvent.press(button('Cancel Dal Makhani'));
    expect(screen.getByRole('header', { name: 'Cancel Dal Makhani?' })).toBeOnTheScreen();
    await fireEvent.press(button('Keep it'));
    expect(screen.queryByRole('header', { name: 'Cancel Dal Makhani?' })).toBeNull();

    await fireEvent.press(button('Cancel Dal Makhani'));
    expect(screen.getByTestId('end-item-confirm')).toBeDisabled();
    await fireEvent.press(button('Guest changed their mind'));
    expect(button('Guest changed their mind')).toBeSelected();
    await fireEvent.press(screen.getByTestId('end-item-confirm'));

    expect(await screen.findByText('Dal Makhani cancelled')).toBeOnTheScreen();
    expect(await within(line(DAL)).findByText('Cancelled')).toBeOnTheScreen();
    expect(server.callsTo('POST', `/api/v1/order-items/${DAL}/cancel`)[0]?.body).toEqual({
      reason: 'Guest changed their mind',
    });
  });

  it("offers no cancel on another waiter's table, and shows a refusal when the kitchen started", async () => {
    const restaurant = new Restaurant();
    sent(restaurant, 'SENT', 'SENT', T5_SESSION);
    sent(restaurant, 'SENT', 'READY');
    await signedInApp(restaurant);
    await fireEvent.press(await screen.findByRole('tab', { name: 'All tables' }));
    await openTable('T5');
    await screen.findByText('1 × Dal Makhani');
    expect(screen.queryByRole('button', { name: 'Cancel Dal Makhani' })).toBeNull();
    await fireEvent.press(button('Back to tables'));

    await openTable('T2');
    await fireEvent.press(await screen.findByRole('button', { name: 'Cancel Dal Makhani' }));
    await fireEvent.changeText(screen.getByTestId('end-item-reason'), 'Wrong table');
    // The kitchen starts it just before the cancel arrives.
    restaurant.setState(DAL, 'PREPARING');
    await fireEvent.press(screen.getByTestId('end-item-confirm'));
    expect(
      await screen.findByText('The kitchen has started this item. Void it instead.'),
    ).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: 'Void Dal Makhani' })).toBeOnTheScreen();
  });

  it('voids a started dish once a manager enters their PIN on the phone', async () => {
    const restaurant = new Restaurant();
    sent(restaurant, 'SENT', 'READY');
    const { server } = await signedInApp(restaurant);
    await openTable('T2');

    await fireEvent.press(await screen.findByRole('button', { name: 'Void Paneer Tikka' }));
    expect(screen.getByRole('header', { name: 'Void Paneer Tikka?' })).toBeOnTheScreen();
    expect(
      screen.getByText('A manager approves it with their PIN on this phone.'),
    ).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('end-item-reason'), 'Too salty');
    await fireEvent.press(screen.getByTestId('end-item-confirm'));

    expect(await screen.findByText('Manager approval')).toBeOnTheScreen();
    await fireEvent.press(await screen.findByRole('button', { name: 'Meera' }));
    await pressDigits('1111');
    expect(await screen.findByText('Wrong PIN. Try again.')).toBeOnTheScreen();
    await pressDigits('2222');

    expect(await screen.findByText('Paneer Tikka voided')).toBeOnTheScreen();
    expect(await within(line(TIKKA)).findByText('Voided')).toBeOnTheScreen();
    expect(restaurant.reasons.get(TIKKA)).toBe('Too salty');
    expect(server.callsTo('POST', '/api/v1/auth/override').at(-1)?.body).toEqual({
      approverStaffId: STAFF.MANAGER.staffId,
      pin: '2222',
      capability: 'ITEM_VOID_AFTER_PREP',
      entityType: 'order_item',
      entityId: TIKKA,
    });
    const voids = server.callsTo('POST', `/api/v1/order-items/${TIKKA}/void`);
    expect(voids.map((call) => call.headers['x-override-token'])).toEqual([
      undefined,
      'approval-1',
    ]);
  });

  it('voids nothing when no manager approves', async () => {
    const restaurant = new Restaurant();
    sent(restaurant, 'SENT', 'SERVED');
    await signedInApp(restaurant);
    await openTable('T2');
    await fireEvent.press(await screen.findByRole('button', { name: 'Void Paneer Tikka' }));
    await fireEvent.press(button('Guest sent it back'));
    await fireEvent.press(screen.getByTestId('end-item-confirm'));
    await screen.findByRole('button', { name: 'Meera' });
    await fireEvent.press(button('Close'));

    expect(
      await screen.findByText('Paneer Tikka was not voided: no manager approved it.'),
    ).toBeOnTheScreen();
    expect(restaurant.item(TIKKA)?.state).toBe('SERVED');
  });
});
