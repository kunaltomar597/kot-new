import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Restaurant, signedInApp, translator as t } from './restaurant';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const inbox = () => screen.findByTestId('approvals');

describe('[WTR-004] [ORD-003] [NFR-U03] approving diners’ orders', () => {
  it('shows a diner’s order with what was chosen, and approves it in one tap', async () => {
    const restaurant = new Restaurant();
    const order = restaurant.dinerOrder('T2', 2);
    await signedInApp(restaurant);

    const card = within(await inbox());
    expect(
      card.getByRole('header', { name: t('approvals.title', { count: 1 }) }),
    ).toBeOnTheScreen();
    expect(card.getByText(`Table T2 · Order ${String(order.orderNumber)}`)).toBeOnTheScreen();
    expect(card.getByText('2 min ago · ₹660.00')).toBeOnTheScreen();
    expect(card.getByText('2 × Paneer Tikka')).toBeOnTheScreen();
    expect(card.getByText('Half · Extra cheese')).toBeOnTheScreen();
    expect(card.getByText('Less spicy')).toBeOnTheScreen();

    await fireEvent.press(card.getByTestId(`approval-${order.id}-approve`));
    expect(
      await screen.findByText(t('approvals.approved', { number: order.orderNumber })),
    ).toBeOnTheScreen();
    expect(restaurant.decisions).toEqual([
      { orderId: order.id, kind: 'approve', body: { changes: [], dinerAgreed: false } },
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId('approvals')).toBeNull();
    });
  });

  it('changes quantities only once the diner agreed, then approves', async () => {
    const restaurant = new Restaurant();
    const order = restaurant.dinerOrder('T2');
    await signedInApp(restaurant);
    const card = within(await inbox());
    await fireEvent.press(card.getByTestId(`approval-${order.id}-change`));
    const dal = card.getByLabelText(t('approvals.quantityOf', { name: 'Dal Makhani' }));
    await fireEvent.press(within(dal).getByLabelText(t('pos.item.fewer')));
    expect(card.getByText('0 × Dal Makhani')).toBeOnTheScreen();
    const approve = card.getByTestId(`approval-${order.id}-approve-changes`);
    expect(approve).toBeDisabled();
    await fireEvent.press(card.getByRole('checkbox', { name: t('approvals.dinerAgreed') }));
    expect(approve).toBeEnabled();
    await fireEvent.press(approve);
    await waitFor(() => {
      expect(restaurant.decisions).toHaveLength(1);
    });
    expect(restaurant.decisions[0]?.body).toEqual({
      changes: [{ orderItemId: order.items[1]?.id, quantity: 0 }],
      dinerAgreed: true,
    });
  });

  it('rejects with the reason the diner sees', async () => {
    const restaurant = new Restaurant();
    const order = restaurant.dinerOrder('T2');
    await signedInApp(restaurant);
    const card = within(await inbox());
    await fireEvent.press(card.getByTestId(`approval-${order.id}-reject`));
    const confirm = card.getByTestId(`approval-${order.id}-reject-confirm`);
    expect(confirm).toBeDisabled();
    await fireEvent.changeText(
      card.getByTestId(`approval-${order.id}-reason`),
      'The kitchen is closing',
    );
    await fireEvent.press(confirm);
    await waitFor(() => {
      expect(restaurant.decisions).toEqual([
        { orderId: order.id, kind: 'reject', body: { reason: 'The kitchen is closing' } },
      ]);
    });
  });
});
