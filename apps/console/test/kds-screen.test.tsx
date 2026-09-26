import type { KdsTicketsResponse } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { RESTAURANT_ID } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, t } from './harness.js';
import { board, line, minutesAgo, NOW, ticket } from './kds-fixture.js';

/** Records the notes the kitchen sounds play (Web Audio is not in jsdom). */
class FakeAudioContext {
  static played: { frequency: number; type: string }[] = [];
  currentTime = 0;
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createOscillator() {
    const oscillator = {
      type: 'sine',
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      start: () => {
        FakeAudioContext.played.push({
          frequency: oscillator.frequency.value,
          type: oscillator.type,
        });
      },
      stop: () => undefined,
    };
    return oscillator;
  }
  createGain() {
    return {
      gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: (node: unknown) => node,
    };
  }
}

function kdsServer(...boards: KdsTicketsResponse[]): FakeServer {
  return server('KDS').on(
    'GET',
    '/api/v1/kds/tickets',
    ...boards.map((body) => () => ({ status: 200, body })),
  );
}

async function renderKds(fake: FakeServer) {
  const rendered = await renderConsole({ fake, path: '/kds' });
  await screen.findByRole('heading', { level: 2, name: 'Kitchen' });
  return rendered;
}

function kotEvent(sequence: number, kind: 'NEW' | 'CANCELLED') {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000001${String(sequence).padStart(2, '0')}`,
      type: 'KotCreated',
      version: 1,
      occurredAt: NOW,
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-26',
      payload: {
        kotId: ticket(sequence).kotId,
        kotNumber: sequence,
        stationId: ticket(1).stationId,
        orderId: ticket(1).orderId,
        kind,
      },
    },
  };
}

const card = (name: RegExp) => screen.findByRole('article', { name });
const postsTo = (fake: FakeServer, path: string) => fake.callsTo('POST', path);

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  FakeAudioContext.played = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[KDS-001] [KDS-002] [KDS-003] [KDS-004] the station board', () => {
  it('shows each ticket with table, waiter, source, age, badges, combo parts and notes', async () => {
    const view = board([
      ticket(1, {
        createdAt: minutesAgo(12),
        movedFrom: 'T2',
        lines: [
          line(11, {
            name: 'Dal Makhani',
            quantity: 2,
            modifiers: ['Extra butter'],
            instructions: 'less oil',
          }),
          line(12, { name: 'Dal Makhani', comboName: 'Veg Thali' }),
          line(13, { name: 'Rasmalai', comboName: 'Veg Thali', state: 'PREPARING' }),
        ],
      }),
      ticket(2, {
        kind: 'CANCELLED',
        createdAt: minutesAgo(25),
        tableLabel: null,
        takeawayToken: 7,
        lines: [line(21, { state: 'CANCELLED' })],
      }),
    ]);
    const { container } = await renderKds(kdsServer(view));
    const first = await card(/^KOT 1, Table T4$/);
    expect(first).toHaveAttribute('data-age', 'amber');
    expect(
      within(first).getByText(t('kds.ageMinutes', { minutes: 12 }), { exact: false }),
    ).toHaveTextContent(`${t('kds.ageMinutes', { minutes: 12 })} · ${t('kds.age.amber')}`);
    expect(within(first).getByText(`Ravi · ${t('kds.source.WAITER_APP')}`)).toBeInTheDocument();
    expect(within(first).getByText(t('kds.badge.moved', { table: 'T2' }))).toBeInTheDocument();
    expect(within(first).getByText('Veg Thali')).toBeInTheDocument();
    expect(within(first).getByText('Extra butter')).toBeInTheDocument();
    expect(within(first).getByText('less oil')).toBeInTheDocument();
    expect(
      within(first).getByRole('button', { name: t('kds.bumpFor', { number: 1 }) }),
    ).toBeDisabled();

    const slip = await card(/^KOT 2, Token 7$/);
    expect(slip).toHaveAttribute('data-age', 'red');
    // The slip's badge and the item's own state chip both say so.
    expect(within(slip).getAllByText(t('kds.badge.CANCELLED'))).toHaveLength(2);
    expect(within(slip).queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(
      within(slip).getByRole('button', { name: t('kds.bumpFor', { number: 2 }) }),
    ).toBeEnabled();

    const summary = screen.getByRole('complementary', { name: t('kds.summary') });
    expect(summary).toHaveTextContent('3 × Dal Makhani');
    expect(summary).toHaveTextContent('1 × Rasmalai');
    await expectNoAxeViolations(container);
  });

  it('says so when there is nothing to cook', async () => {
    await renderKds(kdsServer(board([])));
    expect(screen.getByText(t('kds.noTickets'))).toBeInTheDocument();
    expect(screen.getByText(t('kds.summaryNone'))).toBeInTheDocument();
  });
});

describe('[KDS-005] [KDS-007] kitchen steps, bump and recall', () => {
  it('moves one item or the whole ticket along, then reads the board again', async () => {
    const view = board([ticket(1, { lines: [line(11), line(12)] })]);
    const fake = kdsServer(view)
      .on('POST', `/api/v1/order-items/${line(11).orderItemId}/status`, () => ({
        status: 409,
        body: { code: 'ITEM_STATE', message: 'Already started on another screen.' },
      }))
      .on('POST', `/api/v1/order-items/${line(12).orderItemId}/status`, () => ({
        status: 200,
        body: {},
      }));
    const { user } = await renderKds(fake);
    const first = await card(/^KOT 1/);
    await user.click(
      within(first).getByRole('button', {
        name: t('kds.stepFor', { step: t('kds.step.START_PREPARING'), item: 'Dish 11' }),
      }),
    );
    expect(await screen.findByText('Already started on another screen.')).toBeInTheDocument();
    expect(postsTo(fake, `/api/v1/order-items/${line(11).orderItemId}/status`)[0]?.body).toEqual({
      event: 'START_PREPARING',
    });

    await user.click(within(first).getByRole('button', { name: t('kds.allPreparing') }));
    await waitFor(() => {
      expect(postsTo(fake, `/api/v1/order-items/${line(12).orderItemId}/status`)).toHaveLength(1);
    });
    expect(fake.callsTo('GET', '/api/v1/kds/tickets').length).toBeGreaterThanOrEqual(3);
  });

  it('bumps a ready ticket and recalls it from the recently bumped list', async () => {
    const ready = ticket(1, { lines: [line(11, { state: 'READY', readyAt: minutesAgo(1) })] });
    const fake = kdsServer(
      board([ready], { recentlyBumped: [ticket(5, { bumpedAt: minutesAgo(3) })] }),
    )
      .on('POST', `/api/v1/kds/tickets/${ready.kotId}/bump`, () => ({
        status: 200,
        body: { ...ready, bumpedAt: NOW },
      }))
      .on('POST', `/api/v1/kds/tickets/${ticket(5).kotId}/recall`, () => ({
        status: 200,
        body: ticket(5),
      }))
      .on('POST', `/api/v1/order-items/${line(11).orderItemId}/status`, () => ({
        status: 200,
        body: {},
      }));
    const { user } = await renderKds(fake);
    const first = await card(/^KOT 1/);
    await user.click(
      within(first).getByRole('button', {
        name: t('kds.stepFor', { step: t('kds.step.PICK_UP'), item: 'Dish 11' }),
      }),
    );
    expect(postsTo(fake, `/api/v1/order-items/${line(11).orderItemId}/status`)[0]?.body).toEqual({
      event: 'PICK_UP',
    });
    await user.click(within(first).getByRole('button', { name: t('kds.bumpFor', { number: 1 }) }));
    await waitFor(() => {
      expect(postsTo(fake, `/api/v1/kds/tickets/${ready.kotId}/bump`)).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: t('kds.recall') }));
    const sheet = await screen.findByRole('dialog', { name: t('kds.recallTitle') });
    await user.click(
      within(sheet).getByRole('button', { name: t('kds.recallFor', { number: 5 }) }),
    );
    await waitFor(() => {
      expect(postsTo(fake, `/api/v1/kds/tickets/${ticket(5).kotId}/recall`)).toHaveLength(1);
    });
  });
});

describe('[KDS-006] ready food not collected', () => {
  it('flashes the ticket and notifies the manager once', async () => {
    const waiting = ticket(1, { lines: [line(11, { state: 'READY', readyAt: minutesAgo(4) })] });
    const fake = kdsServer(board([waiting]), board([{ ...waiting, managerNotified: true }])).on(
      'POST',
      `/api/v1/kds/tickets/${waiting.kotId}/notify-manager`,
      () => ({
        status: 200,
        body: { alertId: waiting.orderId, alreadyOpen: false },
      }),
    );
    const { user } = await renderKds(fake);
    const first = await card(/^KOT 1/);
    expect(first).toHaveAttribute('data-alert', 'true');
    expect(within(first).getByText(t('kds.notCollected'))).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: t('kds.notifyManager') }));
    expect(
      await within(await card(/^KOT 1/)).findByText(t('kds.managerNotified')),
    ).toBeInTheDocument();
    expect(
      within(await card(/^KOT 1/)).queryByRole('button', { name: t('kds.notifyManager') }),
    ).toBeNull();
    expect(postsTo(fake, `/api/v1/kds/tickets/${waiting.kotId}/notify-manager`)).toHaveLength(1);
  });
});

describe('[KDS-009] [KDS-012] sounds and reconnecting', () => {
  it('chimes for a new ticket and buzzes for a cancellation, once the sound is on', async () => {
    const fake = kdsServer(
      board([ticket(1)]),
      board([ticket(1), ticket(2)]),
      board([ticket(1), ticket(2), ticket(3, { kind: 'CANCELLED' })]),
    );
    const { user, sockets } = await renderKds(fake);
    await card(/^KOT 1/);
    await user.click(screen.getByRole('button', { name: t('kds.enableSound') }));
    expect(screen.queryByRole('button', { name: t('kds.enableSound') })).toBeNull();
    expect(FakeAudioContext.played).toEqual([]);

    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', kotEvent(1, 'NEW'));
    });
    await card(/^KOT 2/);
    expect(FakeAudioContext.played.map((note) => note.frequency)).toEqual([880, 1320]);

    act(() => {
      sockets.last.fire('event', kotEvent(2, 'CANCELLED'));
    });
    await card(/^KOT 3/);
    expect(FakeAudioContext.played.slice(2)).toEqual([
      { frequency: 330, type: 'square' },
      { frequency: 330, type: 'square' },
    ]);
  });

  it('covers the board while disconnected and reads it again on reconnect', async () => {
    const fake = kdsServer(board([ticket(1)]), board([ticket(1), ticket(2)]));
    const { sockets } = await renderKds(fake);
    await card(/^KOT 1/);
    act(() => {
      sockets.sync(0);
    });
    act(() => {
      sockets.last.fire('disconnect', 'transport close');
    });
    const cover = await screen.findByText(t('kds.disconnectedTitle'));
    expect(cover.closest('[role="alert"]')).toHaveTextContent(t('kds.disconnected'));
    act(() => {
      sockets.sync(0);
    });
    expect(await card(/^KOT 2/)).toBeInTheDocument();
    expect(screen.queryByText(t('kds.disconnectedTitle'))).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });
});
