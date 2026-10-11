import { displayDateTime } from '@rp/domain';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expectNoAxeViolations,
  quietLicence,
  renderConsole,
  server,
  signsInAs,
  t,
} from './harness.js';

const INSTALLATION = '0199a0e0-0000-7000-8000-00000000aa01';

function enforced(overrides: Record<string, unknown>) {
  return quietLicence({ enforced: true, ...overrides });
}

function withLicence(role: 'CASHIER' | 'OWNER' | 'MANAGER', ...bodies: object[]) {
  return signsInAs(server(), role)
    .on('GET', '/api/v1/tables/overview', () => ({ status: 200, body: { tables: [] } }))
    .on('GET', '/api/v1/floor', () => ({ status: 200, body: { sections: [] } }))
    .on('GET', '/api/v1/licence', ...bodies.map((body) => () => ({ status: 200, body })));
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[LIC-005] [LIC-008] the licence on staff screens', () => {
  it('shows the days left in grace on the POS', async () => {
    await renderConsole({
      fake: withLicence('CASHIER', enforced({ state: 'GRACE', recorded: 'GRACE', daysLeft: 3 })),
      signedIn: 'CASHIER',
      path: '/pos',
    });
    expect(await screen.findByText(t('licence.banner.grace', { count: 3 }))).toBeInTheDocument();
  });

  it('says when a restriction will start, and then that new orders are paused', async () => {
    const { container } = await renderConsole({
      fake: withLicence(
        'CASHIER',
        enforced({
          state: 'GRACE',
          recorded: 'RESTRICTED',
          problem: 'EXPIRED',
          restrictedFrom: '2026-10-10T22:30:00.000Z',
          daysLeft: 1,
        }),
      ),
      signedIn: 'CASHIER',
      path: '/pos',
    });
    expect(
      await screen.findByText(
        t('licence.banner.pending', displayDateTime(new Date('2026-10-10T22:30:00.000Z'))),
      ),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('puts the payment reminder off until tomorrow with one tap', async () => {
    const { user } = await renderConsole({
      fake: withLicence('CASHIER', enforced({ state: 'PAYMENT_DUE', recorded: 'PAYMENT_DUE' })),
      signedIn: 'CASHIER',
      path: '/pos',
    });
    const reminder = await screen.findByText(t('licence.banner.paymentDue'));
    await user.click(screen.getByRole('button', { name: t('licence.banner.remindTomorrow') }));
    expect(reminder).not.toBeInTheDocument();
  });

  it('shows nothing where the licence does not apply (development)', async () => {
    await renderConsole({
      fake: withLicence('CASHIER', quietLicence({ state: 'RESTRICTED', recorded: 'RESTRICTED' })),
      signedIn: 'CASHIER',
      path: '/pos',
    });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(screen.queryByText(t('licence.banner.restricted'))).toBeNull();
  });
});

describe('[LIC-008] [LIC-006] the Owner’s licence page', () => {
  const restricted = enforced({
    state: 'RESTRICTED',
    recorded: 'RESTRICTED',
    problem: 'VENDOR',
    restrictedFrom: '2026-10-10T22:30:00.000Z',
    daysLeft: 0,
    validUntil: '2026-11-01T06:00:00.000Z',
    capabilities: { ...quietLicence().capabilities, createOrders: false },
    details: {
      installationId: INSTALLATION,
      plan: 'Standard',
      modules: ['POS', 'KDS'],
      deviceLimits: { TABLE_TABLET: 10, PAGER: 5, WAITER_PHONE: 5, KDS: 2 },
      deviceCounts: { TABLE_TABLET: 4, PAGER: 2, WAITER_PHONE: 3, KDS: 2 },
      reason: 'Invoice 42 overdue',
      issuedAt: '2026-10-01T06:00:00.000Z',
      reactivatedUntil: null,
    },
  });

  it('shows the state, why, the plan and the devices against their limits', async () => {
    const { container } = await renderConsole({
      fake: withLicence('OWNER', restricted),
      signedIn: 'OWNER',
      path: '/manage/licence',
    });
    const page = await screen.findByRole('region', { name: t('licence.page.title') });
    expect(within(page).getByText(t('licence.page.state.RESTRICTED'))).toBeVisible();
    expect(within(page).getByText(t('licence.page.problem.VENDOR'))).toBeVisible();
    expect(
      within(page).getByText(t('licence.page.reason', { reason: 'Invoice 42 overdue' })),
    ).toBeVisible();
    expect(
      within(page).getByText(
        `${t('licence.page.device.TABLE_TABLET')}: ${t('licence.page.deviceUse', { used: 4, limit: 10 })}`,
      ),
    ).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('takes a reactivation code from the Owner, and checks with the vendor now', async () => {
    const active = enforced({ details: restricted.details });
    const fake = withLicence('OWNER', restricted, active)
      .on('POST', '/api/v1/licence/reactivate', () => ({ status: 200, body: active }))
      .on('POST', '/api/v1/licence/check', () => ({ status: 200, body: active }));
    const { user } = await renderConsole({ fake, signedIn: 'OWNER', path: '/manage/licence' });
    const field = await screen.findByLabelText(new RegExp(`^${t('licence.page.code')}`));
    const submit = screen.getByRole('button', { name: t('licence.page.reactivate') });
    expect(submit).toBeDisabled();
    await user.type(field, 'abcd-efgh-jkmn-pqrs');
    await user.click(submit);
    await waitFor(() => {
      expect(fake.callsTo('POST', '/api/v1/licence/reactivate')[0]?.body).toEqual({
        code: 'ABCD-EFGH-JKMN-PQRS',
      });
    });
    expect(await screen.findByText(t('licence.page.reactivated'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('licence.page.check') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', '/api/v1/licence/check')).toHaveLength(1);
    });
  });

  it('is shown to managers without the Owner’s actions', async () => {
    await renderConsole({
      fake: withLicence('MANAGER', restricted),
      signedIn: 'MANAGER',
      path: '/manage/licence',
    });
    expect(await screen.findByText(t('licence.page.state.RESTRICTED'))).toBeVisible();
    expect(screen.queryByRole('button', { name: t('licence.page.check') })).toBeNull();
  });
});
