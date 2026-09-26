import type { FloorResponse, TableOverviewEntry, TableOverviewResponse } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { RESTAURANT_ID, STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

const HALL = '0199a0e0-0000-7000-8000-00000000e001';
const TERRACE = '0199a0e0-0000-7000-8000-00000000e002';
const T1 = '0199a0e0-0000-7000-8000-00000000c001';
const T2 = '0199a0e0-0000-7000-8000-00000000c002';
const T3 = '0199a0e0-0000-7000-8000-00000000c003';
const SESSION = '0199a0e0-0000-7000-8000-00000000b001';
const NOW = '2026-09-26T10:00:00.000Z';

function floorTable(id: string, label: string, sectionId: string, order: number) {
  return {
    id,
    label,
    capacity: 4,
    sectionId,
    state: 'FREE' as const,
    displayOrder: order,
    tabletDeviceIds: [],
    archivedAt: null,
    updatedAt: NOW,
  };
}

const FLOOR: FloorResponse = {
  sections: [
    {
      id: HALL,
      name: 'Hall',
      displayOrder: 0,
      archivedAt: null,
      updatedAt: NOW,
      tables: [floorTable(T1, 'T1', HALL, 0), floorTable(T2, 'T2', HALL, 1)],
    },
    {
      id: TERRACE,
      name: 'Terrace',
      displayOrder: 1,
      archivedAt: null,
      updatedAt: NOW,
      tables: [floorTable(T3, 'T3', TERRACE, 0)],
    },
  ],
};

function entry(
  tableId: string,
  label: string,
  sectionId: string,
  session?: Partial<NonNullable<TableOverviewEntry['session']>>,
): TableOverviewEntry {
  return {
    tableId,
    label,
    sectionId,
    capacity: 4,
    state: session === undefined ? 'FREE' : 'OCCUPIED',
    session:
      session === undefined
        ? null
        : {
            id: SESSION,
            openedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
            covers: 3,
            waiterId: STAFF.WAITER.staffId,
            waiterName: 'Ravi',
            amountSoFar: 56_000,
            pendingApprovals: 0,
            ...session,
          },
    activeServiceRequests: 0,
  };
}

function sessionView(tableId: string, label: string) {
  return {
    id: SESSION,
    tableId,
    tableLabel: label,
    state: 'OCCUPIED',
    status: 'OPEN',
    covers: 4,
    waiterId: STAFF.WAITER.staffId,
    waiterName: 'Ravi',
    businessDate: '2026-09-26',
    openedAt: NOW,
    closedAt: null,
    closeReason: null,
  };
}

const overview = (...tables: TableOverviewEntry[]): TableOverviewResponse => ({ tables });

function posServer(...overviews: TableOverviewResponse[]): FakeServer {
  return signsInAs(server(), 'CASHIER')
    .on('GET', '/api/v1/floor', () => ({ status: 200, body: FLOOR }))
    .on(
      'GET',
      '/api/v1/tables/overview',
      ...overviews.map((body) => () => ({ status: 200, body })),
    );
}

const tile = (name: RegExp) => screen.findByRole('button', { name });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[TBL-007] the POS floor', () => {
  it('shows every table by section with state, guests, time seated, waiter and amount', async () => {
    const fake = posServer(
      overview(
        entry(T1, 'T1', HALL, { pendingApprovals: 2 }),
        entry(T2, 'T2', HALL),
        entry(T3, 'T3', TERRACE),
      ),
    );
    const { container } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos' });
    const hall = await screen.findByRole('region', { name: 'Hall' });
    expect(
      within(hall).getByRole('button', {
        name: 'T1, Occupied, 3 guests, 25 min, Ravi, ₹560.00, 2 to approve',
      }),
    ).toBeInTheDocument();
    expect(within(hall).getByRole('button', { name: 'T2, Free' })).toBeInTheDocument();
    const terrace = screen.getByRole('region', { name: 'Terrace' });
    expect(within(terrace).getByRole('button', { name: 'T3, Free' })).toBeInTheDocument();
    expect(screen.getByText(t('pos.summary', { free: 2, total: 3 }))).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('reads the floor again after a table event, so it stays live', async () => {
    const fake = posServer(
      overview(entry(T1, 'T1', HALL), entry(T2, 'T2', HALL), entry(T3, 'T3', TERRACE)),
      overview(entry(T1, 'T1', HALL, {}), entry(T2, 'T2', HALL), entry(T3, 'T3', TERRACE)),
    );
    const { sockets } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos' });
    await tile(/^T1, Free$/);
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', {
        sequence: 1,
        event: {
          eventId: '0199a0e0-0000-7000-8000-0000000000e1',
          type: 'TableStateChanged',
          version: 1,
          occurredAt: NOW,
          restaurantId: RESTAURANT_ID,
          businessDate: '2026-09-26',
          payload: { tableId: T1, state: 'OCCUPIED' },
        },
      });
    });
    expect(await tile(/^T1, Occupied/)).toBeInTheDocument();
    expect(fake.callsTo('GET', '/api/v1/tables/overview')).toHaveLength(2);
  });
});

describe('[TBL-003] opening a table', () => {
  it('seats guests with the assigned waiter unless another is chosen', async () => {
    const fake = posServer(
      overview(entry(T1, 'T1', HALL), entry(T2, 'T2', HALL), entry(T3, 'T3', TERRACE)),
      overview(entry(T1, 'T1', HALL, {}), entry(T2, 'T2', HALL), entry(T3, 'T3', TERRACE)),
    ).on('POST', `/api/v1/tables/${T1}/open`, () => ({
      status: 201,
      body: sessionView(T1, 'T1'),
    }));
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos' });
    await user.click(await tile(/^T1, Free$/));
    const dialog = await screen.findByRole('dialog', {
      name: t('pos.open.title', { table: 'T1' }),
    });

    await user.click(within(dialog).getByRole('button', { name: t('pos.open.submit') }));
    expect(within(dialog).getByText(t('pos.open.invalidGuests'))).toBeInTheDocument();
    expect(fake.callsTo('POST', `/api/v1/tables/${T1}/open`)).toHaveLength(0);

    const pad = within(dialog).getByRole('group', { name: t('pos.open.guestsPad') });
    await user.click(within(pad).getByRole('button', { name: '4' }));
    expect(within(dialog).getByLabelText(t('pos.open.guests'))).toHaveValue('4');
    await user.selectOptions(within(dialog).getByLabelText(t('pos.open.waiter')), 'Ravi');
    await user.click(within(dialog).getByRole('button', { name: t('pos.open.submit') }));

    expect(await screen.findByText(t('pos.open.opened', { table: 'T1' }))).toBeInTheDocument();
    expect(fake.callsTo('POST', `/api/v1/tables/${T1}/open`)[0]?.body).toEqual({
      covers: 4,
      waiterId: STAFF.WAITER.staffId,
    });
    expect(await tile(/^T1, Occupied/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the server’s refusal in the dialog', async () => {
    const fake = posServer(overview(entry(T1, 'T1', HALL))).on(
      'POST',
      `/api/v1/tables/${T1}/open`,
      () => ({
        status: 409,
        body: { code: 'TABLE_NOT_FREE', message: 'T1 was just opened on another device.' },
      }),
    );
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos' });
    await user.click(await tile(/^T1, Free$/));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(t('pos.open.guests')), '2');
    await user.click(within(dialog).getByRole('button', { name: t('pos.open.submit') }));
    expect(
      await within(dialog).findByText('T1 was just opened on another device.'),
    ).toBeInTheDocument();
  });
});

describe('[TBL-005] moving a table', () => {
  it('moves the guests to a free table the cashier picks', async () => {
    const fake = posServer(
      overview(entry(T1, 'T1', HALL, {}), entry(T2, 'T2', HALL), entry(T3, 'T3', TERRACE)),
      overview(entry(T1, 'T1', HALL), entry(T2, 'T2', HALL), entry(T3, 'T3', TERRACE, {})),
    ).on('POST', `/api/v1/table-sessions/${SESSION}/move`, () => ({
      status: 200,
      body: sessionView(T3, 'T3'),
    }));
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos' });
    await user.click(await tile(/^T1, Occupied/));
    const details = await screen.findByRole('dialog', {
      name: t('pos.table.title', { table: 'T1' }),
    });
    expect(within(details).getByText(t('pos.table.waiter', { name: 'Ravi' }))).toBeInTheDocument();
    await user.click(within(details).getByRole('button', { name: t('pos.table.move') }));

    const move = await screen.findByRole('dialog', {
      name: t('pos.move.title', { table: 'T1' }),
    });
    expect(within(move).queryByRole('button', { name: /^T1,/ })).toBeNull();
    await user.click(within(move).getByRole('button', { name: 'T3, Free' }));

    expect(
      await screen.findByText(t('pos.move.moved', { from: 'T1', to: 'T3' })),
    ).toBeInTheDocument();
    expect(fake.callsTo('POST', `/api/v1/table-sessions/${SESSION}/move`)[0]?.body).toEqual({
      toTableId: T3,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await tile(/^T3, Occupied/)).toBeInTheDocument();
  });

  it('keeps roles without the POS off the floor', async () => {
    const fake = signsInAs(server(), 'KITCHEN')
      .on('GET', '/api/v1/floor', () => ({ status: 200, body: FLOOR }))
      .on('GET', '/api/v1/tables/overview', () => ({
        status: 200,
        body: overview(entry(T1, 'T1', HALL, {})),
      }));
    await renderConsole({ fake, signedIn: 'KITCHEN', path: '/pos' });
    expect(
      await screen.findByText(t('modes.notAllowed', { mode: t('modes.pos') })),
    ).toBeInTheDocument();
  });
});

describe('[TBL-007] when the floor cannot be read', () => {
  it('says what went wrong and retries', async () => {
    const fake = signsInAs(server(), 'CASHIER')
      .on('GET', '/api/v1/floor', () => ({ status: 200, body: FLOOR }))
      .on(
        'GET',
        '/api/v1/tables/overview',
        () => ({ status: 500, body: { code: 'INTERNAL', message: 'The server had a problem.' } }),
        () => ({ status: 200, body: overview(entry(T1, 'T1', HALL)) }),
      );
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos' });
    expect(await screen.findByText('The server had a problem.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    expect(await tile(/^T1, Free$/)).toBeInTheDocument();
  });
});
