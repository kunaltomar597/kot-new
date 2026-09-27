import type { AlertView } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alertEvent,
  alertView,
  billForCashier,
  diskForOwner,
  escalatedFood,
  kitchenFlag,
  nudgeToRavi,
  waterForRavi,
} from './alerts-fixture.js';
import type { FakeServer } from './fake-server.js';
import { STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

/** A server whose alert list answers each read in turn (the last one again after that). */
function alertsServer(role: keyof typeof STAFF, ...reads: AlertView[][]): FakeServer {
  return signsInAs(server(), role).on(
    'GET',
    '/api/v1/alerts',
    ...reads.map((alerts) => () => ({ status: 200, body: { alerts } })),
  );
}

const group = (name: string) => screen.findByRole('region', { name });
const toasts = () => screen.getByRole('region', { name: t('ui.toast.region') });
const alertsButton = (count: number) =>
  screen.findByRole('button', { name: t('alerts.centre.button', { count }) });
const acknowledgeOf = (title: string) =>
  screen.findByRole('button', { name: t('alerts.acknowledgeOf', { title }) });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MGR-008] the alert centre on the manager dashboard', () => {
  it('[KDS-006] shows every open alert in groups, what asks for the manager first', async () => {
    const fake = alertsServer('MANAGER', [
      diskForOwner,
      nudgeToRavi,
      waterForRavi,
      kitchenFlag,
      escalatedFood,
    ]);
    const { container } = await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });

    const mine = await group(
      t('alerts.centre.groupHeading', { group: t('alerts.centre.groups.mine'), count: 2 }),
    );
    const rows = within(mine).getAllByRole('listitem');
    // Escalated first; the kitchen's flag for the manager (KDS-006) with its KOT and dishes.
    expect(rows[0]).toHaveTextContent('Table 5 · Food ready');
    expect(rows[0]).toHaveTextContent(t('alerts.centre.escalated'));
    expect(rows[0]).toHaveTextContent(t('alerts.reminded', { count: 2 }));
    expect(rows[1]).toHaveTextContent('Table 4 · Food waiting at the pass');
    expect(rows[1]).toHaveTextContent('KOT 12: Dal Makhani');

    const tables = await group(
      t('alerts.centre.groupHeading', { group: t('alerts.centre.groups.tables'), count: 1 }),
    );
    expect(tables).toHaveTextContent('Table 7 · Water requested');
    expect(tables).toHaveTextContent(t('alerts.for', { name: 'Ravi' }));
    const staff = await group(
      t('alerts.centre.groupHeading', { group: t('alerts.centre.groups.staff'), count: 1 }),
    );
    expect(staff).toHaveTextContent('Come to counter');
    expect(staff).toHaveTextContent(t('alerts.from', { name: 'Meera' }));
    const system = await group(
      t('alerts.centre.groupHeading', { group: t('alerts.centre.groups.system'), count: 1 }),
    );
    expect(system).toHaveTextContent(t('alerts.type.DISK_OR_BACKUP'));
    expect(system).toHaveTextContent(t('alerts.for', { name: 'Kunal' }));

    // The header counts what asks for the manager, not everything they look over.
    expect(await alertsButton(2)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('[NTF-004] acknowledges an alert for everyone and takes it off', async () => {
    const fake = alertsServer('MANAGER', [kitchenFlag, waterForRavi], [waterForRavi]).on(
      'POST',
      `/api/v1/alerts/${kitchenFlag.id}/acknowledge`,
      () => ({
        status: 200,
        body: { ...kitchenFlag, status: 'ACKNOWLEDGED', acknowledgedAt: kitchenFlag.createdAt },
      }),
    );
    const { user } = await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });

    await user.click(await acknowledgeOf('Table 4 · Food waiting at the pass'));
    await waitFor(() => {
      expect(screen.queryByText('Table 4 · Food waiting at the pass')).toBeNull();
    });
    expect(fake.callsTo('POST', `/api/v1/alerts/${kitchenFlag.id}/acknowledge`)).toHaveLength(1);
    // A manager may acknowledge a waiter's alert too; it is still there until someone does.
    expect(screen.getByText('Table 7 · Water requested')).toBeInTheDocument();
    expect(await alertsButton(0)).toBeInTheDocument();
  });

  it('[NTF-004] says why an alert was not acknowledged and keeps it', async () => {
    const fake = alertsServer('MANAGER', [kitchenFlag]).on(
      'POST',
      `/api/v1/alerts/${kitchenFlag.id}/acknowledge`,
      () => ({
        status: 404,
        body: { code: 'ALERT_NOT_FOUND', message: 'There is no such alert for you.' },
      }),
    );
    const { user } = await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });

    await user.click(await acknowledgeOf('Table 4 · Food waiting at the pass'));
    expect(
      await screen.findByText(
        t('alerts.acknowledgeFailed', { message: 'There is no such alert for you.' }),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Table 4 · Food waiting at the pass')).toBeInTheDocument();
    expect(await acknowledgeOf('Table 4 · Food waiting at the pass')).toBeEnabled();
  });

  it('says when there is nothing open', async () => {
    await renderConsole({
      fake: signsInAs(server(), 'MANAGER'),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    expect(await screen.findByText(t('alerts.centre.none'))).toBeInTheDocument();
    expect(await alertsButton(0)).toBeInTheDocument();
  });

  it('offers to try again when the alerts cannot be read', async () => {
    const fake = signsInAs(server(), 'MANAGER').on(
      'GET',
      '/api/v1/alerts',
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'The server is starting.' } }),
      () => ({ status: 200, body: { alerts: [kitchenFlag] } }),
    );
    const { user } = await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });
    expect(await screen.findByText(t('alerts.centre.loadFailed'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    expect(await screen.findByText('Table 4 · Food waiting at the pass')).toBeInTheDocument();
  });
});

describe('[MGR-008] [NTF-006] alerts on the POS, live', () => {
  it('pops up a new alert for the cashier, counts it and opens the alert centre', async () => {
    const fake = alertsServer('CASHIER', [], [billForCashier]);
    const { user, sockets } = await renderConsole({ fake, path: '/pos', signedIn: 'CASHIER' });
    expect(await alertsButton(0)).toBeInTheDocument();

    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', alertEvent(1, 'AlertRaised', billForCashier));
    });
    const toast = await within(toasts()).findByRole('status');
    expect(toast).toHaveTextContent('Table 7 · Bill requested');
    expect(toast).toHaveTextContent('Asked on the table tablet');
    expect(await alertsButton(1)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t('alerts.centre.show') }));
    const sheet = await screen.findByRole('dialog', { name: t('alerts.title') });
    expect(
      within(sheet).getByRole('button', {
        name: t('alerts.acknowledgeOf', { title: 'Table 7 · Bill requested' }),
      }),
    ).toBeInTheDocument();
    // A cashier cannot nudge waiters (NTF-008 is for managers).
    expect(within(sheet).queryByRole('button', { name: t('alerts.nudge.open') })).toBeNull();
  });

  it('[NTF-005] pops up an escalation to the manager on the POS and keeps it up', async () => {
    const food = alertView(30);
    const escalated: AlertView = {
      ...food,
      escalatedAt: food.createdAt,
      escalatedTo: [STAFF.MANAGER.staffId],
      recipientIds: [...food.recipientIds, STAFF.MANAGER.staffId],
    };
    const fake = alertsServer('MANAGER', [food], [escalated]);
    const { sockets } = await renderConsole({ fake, path: '/pos', signedIn: 'MANAGER' });
    // Ravi's food is Ravi's to take: the manager is not asked, and nothing pops up.
    expect(await alertsButton(0)).toBeInTheDocument();
    expect(within(toasts()).queryByRole('alert')).toBeNull();

    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', alertEvent(1, 'AlertEscalated', escalated));
    });
    const toast = await within(toasts()).findByRole('alert');
    expect(toast).toHaveTextContent('Table 5 · Food ready');
    expect(await alertsButton(1)).toBeInTheDocument();
  });

  it('opens the alert centre from the header on any POS screen', async () => {
    const fake = alertsServer('CASHIER', [billForCashier]);
    const { user } = await renderConsole({ fake, path: '/pos', signedIn: 'CASHIER' });
    await user.click(await alertsButton(1));
    const sheet = await screen.findByRole('dialog', { name: t('alerts.title') });
    expect(within(sheet).getByText('Table 7 · Bill requested')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: t('ui.dialog.close') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('alerts.title') })).toBeNull();
    });
  });

  it('shows no alerts on the kitchen display', async () => {
    await renderConsole({ fake: server('KDS'), path: '/kds' });
    await screen.findByRole('heading', { level: 1, name: t('modes.kds') });
    expect(screen.queryByRole('button', { name: /^Alerts/ })).toBeNull();
  });
});
