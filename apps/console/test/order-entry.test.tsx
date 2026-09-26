import type { SubmitOrderRequest } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { RESTAURANT_ID } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { IDS, MENU, sentOrder } from './menu-fixture.js';

const TABLE_PATH = `/pos/table/${IDS.session}?label=T1`;

function orderServer(): FakeServer {
  return signsInAs(server(), 'CASHIER')
    .on('GET', '/api/v1/menu', () => ({ status: 200, body: MENU }))
    .on('GET', `/api/v1/table-sessions/${IDS.session}/orders`, () => ({
      status: 200,
      body: { orders: [sentOrder('SENT')] },
    }));
}

const accepted = {
  status: 200,
  body: {
    status: 'ACCEPTED',
    orderId: IDS.order,
    orderNumber: 8,
    replayed: false,
    itemState: 'SENT',
  },
};

const bodyOf = (fake: FakeServer, index = 0) =>
  fake.callsTo('POST', '/api/v1/orders')[index]?.body as SubmitOrderRequest | undefined;

const card = (name: RegExp) => screen.findByRole('button', { name });
const cartPanel = () => screen.getByRole('complementary', { name: t('pos.cart.title') });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[ORD-001] [MENU-012] taking an order at a table', () => {
  it('browses categories, searches, and shows what cannot be ordered', async () => {
    const { user, container } = await renderConsole({
      fake: orderServer(),
      signedIn: 'CASHIER',
      path: TABLE_PATH,
    });
    expect(
      await screen.findByRole('heading', { name: t('pos.table.title', { table: 'T1' }) }),
    ).toBeInTheDocument();
    expect(await card(/^Paneer Tikka, ₹180.00, Veg, Choose options$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Dal Makhani/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Main Course' }));
    expect(await card(/^Dal Makhani, ₹240.00, Veg$/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Veg Thali Combo, .*, Combo$/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Gulab Jamun, .*, Sold out$/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Rasmalai/ })).toBeNull();

    await user.type(screen.getByLabelText(t('pos.menu.search')), 'tikka');
    expect(await card(/^Paneer Tikka/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Dal Makhani/ })).toBeNull();
    await user.clear(screen.getByLabelText(t('pos.menu.search')));
    await user.type(screen.getByLabelText(t('pos.menu.search')), 'pizza');
    expect(
      await screen.findByText(t('pos.menu.noResults', { query: 'pizza' })),
    ).toBeInTheDocument();

    // What was sent before shows with its live state.
    const sent = screen.getByRole('region', { name: t('pos.sent.title') });
    expect(within(sent).getByText(t('pos.itemState.SENT'))).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it(
    'adds a dish with a variant and modifiers, a combo with its choice, and sends once',
    { timeout: 20_000 },
    async () => {
      const fake = orderServer().on(
        'POST',
        '/api/v1/orders',
        () => {
          throw new TypeError('Failed to fetch');
        },
        () => accepted,
      );
      const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: TABLE_PATH });
      await user.click(await card(/^Paneer Tikka/));
      const dialog = await screen.findByRole('dialog', { name: 'Paneer Tikka' });
      await user.click(within(dialog).getByRole('button', { name: t('pos.item.add') }));
      expect(within(dialog).getByText(t('pos.item.issue.VARIANT_REQUIRED'))).toBeInTheDocument();
      await user.click(within(dialog).getByRole('radio', { name: /Full/ }));
      await user.click(within(dialog).getByRole('checkbox', { name: /Cheese/ }));
      await user.click(within(dialog).getByRole('button', { name: t('pos.item.more') }));
      await user.type(within(dialog).getByLabelText(t('pos.item.instructions')), 'extra crisp');
      expect(within(dialog).getByText('₹640.00')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: t('pos.item.add') }));

      await user.click(screen.getByRole('button', { name: 'Main Course' }));
      await user.click(await card(/^Veg Thali Combo/));
      const combo = await screen.findByRole('dialog', { name: 'Veg Thali Combo' });
      await user.click(within(combo).getByRole('button', { name: t('pos.item.add') }));
      expect(within(combo).getByText(t('pos.item.comboMissing'))).toBeInTheDocument();
      await user.click(within(combo).getByRole('radio', { name: 'Rasmalai' }));
      await user.click(within(combo).getByRole('button', { name: t('pos.item.add') }));

      await user.click(await card(/^Dal Makhani/));
      await user.click(await card(/^Dal Makhani/));

      const cart = cartPanel();
      expect(within(cart).getByText('Full · Cheese')).toBeInTheDocument();
      expect(within(cart).getByText('Dessert: Rasmalai')).toBeInTheDocument();
      expect(
        within(cart).getByRole('group', {
          name: t('pos.item.quantityOf', { name: 'Dal Makhani' }),
        }),
      ).toHaveTextContent('2');
      expect(within(cart).getByText('₹1,469.00')).toBeInTheDocument();

      // The first attempt fails on the network: nothing is lost, and the retry reuses the key.
      await user.click(within(cart).getByRole('button', { name: t('pos.cart.send') }));
      expect(await within(cart).findByRole('alert')).toHaveTextContent(t('errors.network'));
      await user.click(within(cart).getByRole('button', { name: t('pos.cart.send') }));
      expect(await screen.findByText(t('pos.result.sent', { number: 8 }))).toBeInTheDocument();

      const [first, second] = [bodyOf(fake, 0), bodyOf(fake, 1)];
      expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
      expect(second).toMatchObject({
        source: 'POS',
        orderType: 'DINE_IN',
        tableSessionId: IDS.session,
      });
      expect(
        second?.lines.map((line) => [
          line.itemId,
          line.quantity,
          line.variantId,
          line.comboChoices,
          line.instructions,
        ]),
      ).toEqual([
        [IDS.tikka, 2, IDS.full, undefined, 'extra crisp'],
        [IDS.thali, 1, undefined, [IDS.rasmalai], undefined],
        [IDS.dal, 2, undefined, undefined, undefined],
      ]);
      expect(JSON.stringify(second)).not.toMatch(/price/i);
      await waitFor(() => {
        expect(within(cartPanel()).getByText(t('pos.cart.empty'))).toBeInTheDocument();
      });
    },
  );

  it('marks the lines the server refused and sends nothing (ORD-017)', async () => {
    const fake = orderServer().on('POST', '/api/v1/orders', (call) => {
      const body = call.body as SubmitOrderRequest;
      return {
        status: 200,
        body: {
          status: 'PARTIALLY_REJECTED',
          rejectedLines: [
            {
              clientLineId: body.lines[0]?.clientLineId,
              code: 'OUT_OF_STOCK',
              message: 'Dal Makhani is out of stock.',
            },
          ],
        },
      };
    });
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: TABLE_PATH });
    await user.click(await screen.findByRole('button', { name: 'Main Course' }));
    await user.click(await card(/^Dal Makhani/));
    await user.click(within(cartPanel()).getByRole('button', { name: t('pos.cart.send') }));
    expect(
      await within(cartPanel()).findByText('Dal Makhani is out of stock.'),
    ).toBeInTheDocument();
    expect(within(cartPanel()).getByRole('alert')).toHaveTextContent(t('pos.result.rejected'));
    // A fixed cart is a new order attempt, with a new key.
    await user.click(
      within(cartPanel()).getByRole('button', {
        name: t('pos.cart.remove', { name: 'Dal Makhani' }),
      }),
    );
    expect(within(cartPanel()).getByRole('button', { name: t('pos.cart.send') })).toBeDisabled();
  });

  it('updates item states live from kitchen events (ORD-010)', async () => {
    const fake = signsInAs(server(), 'CASHIER')
      .on('GET', '/api/v1/menu', () => ({ status: 200, body: MENU }))
      .on(
        'GET',
        `/api/v1/table-sessions/${IDS.session}/orders`,
        () => ({ status: 200, body: { orders: [sentOrder('SENT')] } }),
        () => ({ status: 200, body: { orders: [sentOrder('READY')] } }),
      );
    const { sockets } = await renderConsole({ fake, signedIn: 'CASHIER', path: TABLE_PATH });
    const sent = await screen.findByRole('region', { name: t('pos.sent.title') });
    expect(await within(sent).findByText(t('pos.itemState.SENT'))).toBeInTheDocument();
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', {
        sequence: 1,
        event: {
          eventId: '0199a0e0-0000-7000-8000-0000000000f1',
          type: 'ItemStatusChanged',
          version: 1,
          occurredAt: '2026-09-26T08:40:00.000Z',
          restaurantId: RESTAURANT_ID,
          businessDate: '2026-09-26',
          payload: {
            orderId: IDS.order,
            orderItemId: IDS.orderItem,
            from: 'SENT',
            to: 'READY',
            actorId: IDS.order,
            deviceId: IDS.order,
          },
        },
      });
    });
    expect(await within(sent).findByText(t('pos.itemState.READY'))).toBeInTheDocument();
  });
});

describe('[TBL-008] takeaway', () => {
  it('sends a takeaway order with the customer’s name and shows the token', async () => {
    const fake = signsInAs(server(), 'CASHIER')
      .on('GET', '/api/v1/menu', () => ({ status: 200, body: MENU }))
      .on('GET', '/api/v1/orders/takeaway', () => ({ status: 200, body: { orders: [] } }))
      .on('POST', '/api/v1/orders', () => accepted)
      .on('GET', `/api/v1/orders/${IDS.order}`, () => ({
        status: 200,
        body: sentOrder('SENT', {
          orderType: 'TAKEAWAY',
          tableSessionId: null,
          takeawayToken: 12,
          customerName: 'Anil',
        }),
      }));
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos/takeaway' });
    expect(await screen.findByRole('heading', { name: t('pos.takeaway') })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Main Course' }));
    await user.click(await card(/^Dal Makhani/));
    await user.type(screen.getByLabelText(t('pos.cart.customer')), 'Anil');
    await user.click(within(cartPanel()).getByRole('button', { name: t('pos.cart.send') }));
    expect(
      await screen.findByText(t('pos.result.takeaway', { token: 12, number: 8 })),
    ).toBeInTheDocument();
    expect(bodyOf(fake)).toMatchObject({
      orderType: 'TAKEAWAY',
      customerName: 'Anil',
      source: 'POS',
    });
    expect(bodyOf(fake)?.tableSessionId).toBeUndefined();
  });

  it('is reached from the floor, and the back button returns there', async () => {
    const fake = signsInAs(server(), 'CASHIER')
      .on('GET', '/api/v1/floor', () => ({ status: 200, body: { sections: [] } }))
      .on('GET', '/api/v1/tables/overview', () => ({
        status: 200,
        body: {
          tables: [
            {
              tableId: IDS.session,
              label: 'T1',
              sectionId: IDS.session,
              capacity: 4,
              state: 'FREE',
              session: null,
              activeServiceRequests: 0,
            },
          ],
        },
      }))
      .on('GET', '/api/v1/menu', () => ({ status: 200, body: MENU }))
      .on('GET', '/api/v1/orders/takeaway', () => ({ status: 200, body: { orders: [] } }));
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos' });
    await user.click(await screen.findByRole('button', { name: t('pos.takeaway') }));
    expect(await screen.findByRole('heading', { name: t('pos.takeaway') })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('pos.backToTables') }));
    expect(await screen.findByRole('button', { name: 'T1, Free' })).toBeInTheDocument();
  });
});
