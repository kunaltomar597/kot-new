import type { AlertView, OrderFeedResponse } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kitchenFlag, waterForRavi } from './alerts-fixture.js';
import {
  FLOOR,
  NOW,
  OVERVIEW,
  SERVICE,
  T1,
  feed,
  lassiAtT3,
  naanToken7,
  tikkaAtT1,
} from './dashboard-fixture.js';
import type { FakeServer } from './fake-server.js';
import { RESTAURANT_ID } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

function managerServer(
  feeds: OrderFeedResponse[] = [SERVICE],
  alerts: AlertView[] = [kitchenFlag, waterForRavi],
): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/floor', () => ({ status: 200, body: FLOOR }))
    .on('GET', '/api/v1/tables/overview', () => ({ status: 200, body: OVERVIEW }))
    .on('GET', '/api/v1/order-feed', ...feeds.map((body) => () => ({ status: 200, body })))
    .on('GET', '/api/v1/alerts', () => ({ status: 200, body: { alerts } }));
}

const nav = () => screen.getByRole('navigation', { name: t('dashboard.navigation') });
const navLink = (section: 'overview' | 'orders' | 'alerts') =>
  within(nav()).getByRole('link', { name: t(`dashboard.section.${section}`) });
const ordersRegion = () => screen.findByRole('region', { name: t('dashboard.orders.title') });
const orderCards = async () => within(await ordersRegion()).queryAllByRole('article');
const cardTitles = async () =>
  (await orderCards()).map((card) => within(card).getByRole('heading').textContent);
const filters = () => screen.getByRole('group', { name: t('dashboard.orders.filters') });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MGR-001] [MGR-011] the dashboard’s navigation', () => {
  it('opens on the overview and moves between overview, orders and alerts', async () => {
    const { user, container } = await renderConsole({
      fake: managerServer(),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    await screen.findByRole('region', { name: t('dashboard.overview.glance') });
    expect(navLink('overview')).toHaveAttribute('aria-current', 'page');
    expect(navLink('orders')).not.toHaveAttribute('aria-current');
    await expectNoAxeViolations(container);

    await user.click(navLink('orders'));
    expect(await ordersRegion()).toBeInTheDocument();
    expect(navLink('orders')).toHaveAttribute('aria-current', 'page');
    expect(navLink('overview')).not.toHaveAttribute('aria-current');

    await user.click(navLink('alerts'));
    expect(await screen.findByRole('region', { name: t('alerts.title') })).toHaveTextContent(
      'Table 4 · Food waiting at the pass',
    );
    expect(navLink('alerts')).toHaveAttribute('aria-current', 'page');
    await expectNoAxeViolations(container);
  });

  it('goes back to the overview from an address it does not know', async () => {
    await renderConsole({ fake: managerServer(), path: '/manage/nowhere', signedIn: 'MANAGER' });
    expect(
      await screen.findByRole('region', { name: t('dashboard.overview.glance') }),
    ).toBeInTheDocument();
    expect(navLink('overview')).toHaveAttribute('aria-current', 'page');
  });
});

describe('[MGR-002] the overview', () => {
  it('shows the restaurant at a glance: tables, guests, orders, late dishes and alerts', async () => {
    await renderConsole({ fake: managerServer(), path: '/manage', signedIn: 'MANAGER' });
    const glance = await screen.findByRole('region', { name: t('dashboard.overview.glance') });
    await waitFor(() => {
      expect(glance).toHaveTextContent(t('dashboard.overview.orders', { count: 3 }));
    });
    expect(glance).toHaveTextContent(t('dashboard.overview.occupied', { occupied: 2, total: 3 }));
    expect(glance).toHaveTextContent(t('dashboard.overview.guests', { count: 5 }));
    expect(glance).toHaveTextContent(t('dashboard.overview.awaiting', { count: 1 }));
    expect(glance).toHaveTextContent(t('dashboard.overview.inKitchen', { count: 2 }));
    expect(glance).toHaveTextContent(t('dashboard.overview.ready', { count: 1 }));
    expect(glance).toHaveTextContent(t('dashboard.overview.alerts', { count: 2 }));
    // Late dishes carry an icon and words, not colour alone (NFR-U05).
    const delayed = within(glance).getByText(t('dashboard.overview.delayed', { count: 2 }));
    expect(delayed).toHaveAttribute('data-delayed', 'true');
    expect(delayed.querySelector('svg')).not.toBeNull();
    expect(
      within(glance).getByRole('link', { name: t('dashboard.overview.seeAlerts') }),
    ).toBeInTheDocument();
  });

  it('[TBL-007] shows the live floor; an occupied table opens its orders, a free one is not a button that does nothing', async () => {
    const { user, container } = await renderConsole({
      fake: managerServer(),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    const hall = await screen.findByRole('region', { name: 'Hall' });
    const t2 = within(hall).getByRole('button', { name: /^T2, Free/ });
    expect(t2).toBeDisabled();
    const t1 = within(hall).getByRole('button', { name: /^T1, Occupied, 3 guests, 30 min, Ravi/ });
    // The tile opens a page; it is not a toggle.
    expect(t1).not.toHaveAttribute('aria-pressed');
    expect(
      within(await screen.findByRole('region', { name: 'Terrace' })).getByRole('button', {
        name: /^T3, Occupied, .*1 to approve$/,
      }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(t1);
    expect(
      await screen.findByText(t('dashboard.orders.table', { table: 'T1' })),
    ).toBeInTheDocument();
    expect(navLink('orders')).toHaveAttribute('aria-current', 'page');
    expect(await cardTitles()).toEqual(['Table T1 · Order 12']);

    await user.click(
      within(filters()).getByRole('button', { name: t('dashboard.orders.allTables') }),
    );
    await waitFor(async () => {
      expect(await orderCards()).toHaveLength(3);
    });
    expect(screen.queryByText(t('dashboard.orders.table', { table: 'T1' }))).toBeNull();
  });

  it('opens the late dishes from the glance', async () => {
    const { user } = await renderConsole({
      fake: managerServer(),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    await user.click(await screen.findByRole('link', { name: t('dashboard.overview.seeDelayed') }));
    expect(
      await screen.findByRole('checkbox', { name: t('dashboard.orders.delayedOnly') }),
    ).toBeChecked();
    expect(await cardTitles()).toEqual(['Table T1 · Order 12', 'Token 7 · Order 13']);
  });

  it('says when there are no tables, nothing in progress and no alerts', async () => {
    const fake = managerServer([feed()], [])
      .on('GET', '/api/v1/floor', () => ({ status: 200, body: { sections: [] } }))
      .on('GET', '/api/v1/tables/overview', () => ({ status: 200, body: { tables: [] } }));
    await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });
    expect(await screen.findByText(t('dashboard.overview.noTables'))).toBeInTheDocument();
    const glance = screen.getByRole('region', { name: t('dashboard.overview.glance') });
    await waitFor(() => {
      expect(glance).toHaveTextContent(t('dashboard.overview.orders', { count: 0 }));
    });
    expect(glance).toHaveTextContent(t('dashboard.overview.delayed', { count: 0 }));
    expect(glance).toHaveTextContent(t('dashboard.overview.alerts', { count: 0 }));
    expect(
      within(glance).queryByRole('link', { name: t('dashboard.overview.seeDelayed') }),
    ).toBeNull();
  });

  it('says what could not be read, and reads it again on Retry', async () => {
    const down = () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'Try again' } });
    const fake = managerServer()
      .on('GET', '/api/v1/tables/overview', down, () => ({ status: 200, body: OVERVIEW }))
      .on('GET', '/api/v1/order-feed', down, () => ({ status: 200, body: SERVICE }));
    const { user } = await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });
    const glance = await screen.findByRole('region', { name: t('dashboard.overview.glance') });
    await waitFor(() => {
      expect(within(glance).getAllByRole('button', { name: t('states.retry') })).toHaveLength(2);
    });
    for (const retry of within(glance).getAllByRole('button', { name: t('states.retry') })) {
      await user.click(retry);
    }
    await waitFor(() => {
      expect(glance).toHaveTextContent(t('dashboard.overview.orders', { count: 3 }));
    });
    expect(glance).toHaveTextContent(t('dashboard.overview.occupied', { occupied: 2, total: 3 }));
  });
});

describe('[MGR-003] the live order feed', () => {
  it('shows every order in progress with each dish’s station, state and time, and marks late ones', async () => {
    const { container } = await renderConsole({
      fake: managerServer(),
      path: '/manage/orders',
      signedIn: 'MANAGER',
    });
    await waitFor(async () => {
      expect(await orderCards()).toHaveLength(3);
    });
    const [tikka, naan, lassi] = await orderCards();
    expect(await cardTitles()).toEqual([
      'Table T1 · Order 12',
      'Token 7 · Order 13',
      'Table T3 · Order 14',
    ]);
    expect(
      screen.getByText(t('dashboard.orders.summary', { orders: 3, ready: 1, delayed: 2 })),
    ).toBeInTheDocument();

    // Late in the kitchen: marked with a badge, an icon and words (NFR-U05).
    expect(tikka).toHaveAttribute('data-delayed', 'true');
    expect(within(tikka!).getByText(t('dashboard.orders.delayed'))).toBeInTheDocument();
    expect(tikka).toHaveTextContent(
      [
        t('kds.source.WAITER_APP'),
        t('dashboard.orders.waiterName', { name: 'Ravi' }),
        t('dashboard.orders.placed', { minutes: 26 }),
      ].join(' · '),
    );
    const [paneer, dal] = within(tikka!).getAllByRole('listitem');
    expect(paneer).toHaveAttribute('data-delayed', 'true');
    expect(paneer).toHaveTextContent('2 × Paneer Tikka');
    expect(paneer).toHaveTextContent('Tandoor');
    expect(paneer).toHaveTextContent(t('pos.itemState.PREPARING'));
    expect(paneer).toHaveTextContent(
      t('dashboard.orders.late.KITCHEN', { minutes: 25, allowed: 15 }),
    );
    expect(dal).not.toHaveAttribute('data-delayed');
    expect(dal).toHaveTextContent('1 × Dal Makhani');
    expect(dal).toHaveTextContent('Main kitchen');
    expect(dal).toHaveTextContent(t('dashboard.orders.sinceSent', { minutes: 5 }));

    // Waiting at the pass too long.
    expect(naan).toHaveAttribute('data-delayed', 'true');
    expect(naan).toHaveTextContent(t('dashboard.orders.late.PASS', { minutes: 5, allowed: 3 }));
    expect(naan).toHaveTextContent(t('kds.source.POS'));
    expect(naan).not.toHaveTextContent(t('dashboard.orders.waiterName', { name: 'Ravi' }));

    // Waiting for approval: no clock, not late.
    expect(lassi).not.toHaveAttribute('data-delayed');
    expect(lassi).toHaveTextContent('1 × Lassi (Sweet)');
    expect(lassi).toHaveTextContent(
      `Bar · ${t('dashboard.orders.inCombo', { combo: 'Thali Combo' })}`,
    );
    expect(lassi).toHaveTextContent(t('pos.itemState.PENDING_APPROVAL'));
    expect(lassi).toHaveTextContent(t('dashboard.orders.placed', { minutes: 1 }));
    await expectNoAxeViolations(container);
  });

  it('filters by station, waiter and source, and shows only late dishes', async () => {
    const { user } = await renderConsole({
      fake: managerServer(),
      path: '/manage/orders',
      signedIn: 'MANAGER',
    });
    await waitFor(async () => {
      expect(await orderCards()).toHaveLength(3);
    });

    // A station keeps only its own dishes.
    await user.selectOptions(
      within(filters()).getByRole('combobox', { name: t('dashboard.orders.station') }),
      'Tandoor',
    );
    expect(await cardTitles()).toEqual(['Table T1 · Order 12', 'Token 7 · Order 13']);
    const [tikka] = await orderCards();
    expect(within(tikka!).getAllByRole('listitem')).toHaveLength(1);
    expect(tikka).not.toHaveTextContent('Dal Makhani');

    // Nothing of Sunil's is in the tandoor.
    await user.selectOptions(
      within(filters()).getByRole('combobox', { name: t('dashboard.orders.waiter') }),
      'Sunil',
    );
    expect(await screen.findByText(t('dashboard.orders.noneMatch'))).toBeInTheDocument();
    await user.click(within(filters()).getByRole('button', { name: t('dashboard.orders.clear') }));
    await waitFor(async () => {
      expect(await orderCards()).toHaveLength(3);
    });
    expect(
      within(filters()).getByRole('combobox', { name: t('dashboard.orders.station') }),
    ).toHaveValue('');

    await user.selectOptions(
      within(filters()).getByRole('combobox', { name: t('dashboard.orders.source') }),
      t('kds.source.TABLE_TABLET'),
    );
    expect(await cardTitles()).toEqual(['Table T3 · Order 14']);
    await user.selectOptions(
      within(filters()).getByRole('combobox', { name: t('dashboard.orders.source') }),
      t('dashboard.orders.allSources'),
    );

    await user.click(
      within(filters()).getByRole('checkbox', { name: t('dashboard.orders.delayedOnly') }),
    );
    expect(await cardTitles()).toEqual(['Table T1 · Order 12', 'Token 7 · Order 13']);
    expect(
      screen.getByText(t('dashboard.orders.summary', { orders: 2, ready: 1, delayed: 2 })),
    ).toBeInTheDocument();
  });

  it('keeps its filters in the address, and ignores a station it no longer has', async () => {
    await renderConsole({
      fake: managerServer(),
      path: `/manage/orders?waiter=${lassiAtT3.waiterId ?? ''}&station=gone&table=${T1}`,
      signedIn: 'MANAGER',
    });
    // Sunil's orders at T1: none. The unknown station is not applied unseen.
    expect(await screen.findByText(t('dashboard.orders.noneMatch'))).toBeInTheDocument();
    expect(
      within(filters()).getByRole('combobox', { name: t('dashboard.orders.station') }),
    ).toHaveValue('');
    expect(
      within(filters()).getByRole('combobox', { name: t('dashboard.orders.waiter') }),
    ).toHaveValue(lassiAtT3.waiterId);
    // Without a label in the address, the table is named from its orders.
    expect(
      within(filters()).getByText(t('dashboard.orders.table', { table: 'T1' })),
    ).toBeInTheDocument();
  });

  it('says when nothing is in progress', async () => {
    await renderConsole({
      fake: managerServer([feed()]),
      path: '/manage/orders',
      signedIn: 'MANAGER',
    });
    expect(await screen.findByText(t('dashboard.orders.none'))).toBeInTheDocument();
    expect(
      within(filters()).queryByRole('button', { name: t('dashboard.orders.clear') }),
    ).toBeNull();
  });

  it('says when the orders could not be read, and reads them again on Retry', async () => {
    const fake = managerServer().on(
      'GET',
      '/api/v1/order-feed',
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'Try again' } }),
      () => ({ status: 200, body: SERVICE }),
    );
    const { user } = await renderConsole({ fake, path: '/manage/orders', signedIn: 'MANAGER' });
    expect(await screen.findByText(t('dashboard.orders.loadFailed'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    await waitFor(async () => {
      expect(await orderCards()).toHaveLength(3);
    });
  });

  it('[ORD-010] reads the feed again after a kitchen event', async () => {
    const ready = {
      ...tikkaAtT1,
      items: tikkaAtT1.items.map((item, index) =>
        index === 1 ? { ...item, state: 'READY' as const, readyAt: NOW } : item,
      ),
    };
    const fake = managerServer([feed(tikkaAtT1, naanToken7), feed(ready, naanToken7)]);
    const { sockets } = await renderConsole({ fake, path: '/manage/orders', signedIn: 'MANAGER' });
    await waitFor(async () => {
      expect(await orderCards()).toHaveLength(2);
    });
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', {
        sequence: 1,
        event: {
          eventId: '0199a0e0-0000-7000-8000-0000000009e1',
          type: 'ItemStatusChanged',
          version: 1,
          occurredAt: NOW,
          restaurantId: RESTAURANT_ID,
          businessDate: '2026-09-26',
          payload: {
            orderId: tikkaAtT1.orderId,
            orderItemId: tikkaAtT1.items[1]!.orderItemId,
            from: 'SENT',
            to: 'READY',
            actorId: tikkaAtT1.orderId,
            deviceId: tikkaAtT1.orderId,
          },
        },
      });
    });
    expect(
      await screen.findByText(t('dashboard.orders.summary', { orders: 2, ready: 2, delayed: 2 })),
    ).toBeInTheDocument();
    expect(fake.callsTo('GET', '/api/v1/order-feed')).toHaveLength(2);
  });
});
