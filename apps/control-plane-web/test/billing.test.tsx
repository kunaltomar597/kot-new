import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { cyclesOf } from '../src/billing/SubscriptionPanel.js';
import { planRequestOf, EMPTY_PLAN } from '../src/billing/plan-form.js';
import { FakeRefusal } from './fake-cp.js';
import { INVOICE_ID, invoice, plan, PLAN_ID, TENANT_ID } from './fixtures.js';
import { controlPlane, expectNoAxeViolations, renderApp } from './harness.js';

const SUBSCRIPTION = {
  tenantId: TENANT_ID,
  planId: PLAN_ID,
  planName: 'Standard',
  cycle: 'MONTHLY',
  price: 2_49_900,
  startedOn: '2026-09-01',
  nextInvoiceOn: '2026-11-01',
  cancelledAt: null,
} as const;

function billingPlane(role: Parameters<typeof controlPlane>[0]) {
  return controlPlane(role)
    .on('listPlans', () => ({
      plans: [
        plan(),
        plan({
          id: '0190a1b2-0000-7000-8000-0000000000b2',
          code: 'OLD',
          name: 'Old',
          prices: { MONTHLY: 1_99_900, QUARTERLY: null, YEARLY: null },
          archivedAt: '2026-08-01T00:00:00.000Z',
          subscribers: 0,
        }),
      ],
    }))
    .on('listVendorInvoices', () => ({ invoices: [invoice()] }))
    .on('getSubscription', () => SUBSCRIPTION);
}

describe('[VCP-003] plans', () => {
  it('lets everyone see the catalogue; only Finance changes it', async () => {
    const { container } = renderApp({ cp: billingPlane('SUPPORT'), path: '/plans' });
    expect(await screen.findByText('₹2,499.00')).toBeVisible();
    expect(screen.getByText('₹24,990.00')).toBeVisible();
    expect(screen.getAllByText('12 tablets, 6 phones, 6 pagers, 2 kitchen displays')).toHaveLength(
      2,
    );
    expect(screen.getByText('Archived')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Standard' })).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('adds a plan with prices in rupees, as paise, and archives one with a reason', async () => {
    const cp = billingPlane('FINANCE');
    cp.on('createPlan', ({ body }) => ({
      ...plan(),
      ...(body as object),
      id: '0190a1b2-0000-7000-8000-0000000000b3',
      subscribers: 0,
    })).on('archivePlan', () => plan({ archivedAt: '2026-10-02T04:00:00.000Z' }));
    const { user, container } = renderApp({ cp, path: '/plans' });
    await user.click(await screen.findByRole('button', { name: 'Add plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a plan' });
    await user.type(within(dialog).getByLabelText(/^Code/), 'premium');
    await user.type(within(dialog).getByLabelText('Name'), 'Premium');
    await user.type(within(dialog).getByLabelText(/^Monthly price/), '3,999.50');
    await user.type(within(dialog).getByLabelText(/^Yearly price/), 'forty');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Pagers' }));
    await expectNoAxeViolations(container);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(cp.callsOf('createPlan')).toHaveLength(0);
    await user.clear(within(dialog).getByLabelText(/^Yearly price/));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Plan saved')).toBeVisible();
    expect(cp.callsOf('createPlan')[0]?.body).toEqual({
      code: 'PREMIUM',
      name: 'Premium',
      prices: { MONTHLY: 3_99_950, QUARTERLY: null, YEARLY: null },
      deviceLimits: { TABLE_TABLET: 10, PAGER: 5, WAITER_PHONE: 5, KDS: 2 },
      modules: [
        'POS',
        'KDS',
        'WAITER_APP',
        'TABLE_TABLET',
        'QR_MENU',
        'RECOMMENDATIONS',
        'REPORTS',
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Archive Standard' }));
    const archive = await screen.findByRole('dialog', { name: 'Archive Standard?' });
    await user.type(within(archive).getByLabelText(/^Reason/), 'Replaced by Premium');
    await user.click(within(archive).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Plan archived')).toBeVisible();
    expect(cp.callsOf('archivePlan')[0]).toMatchObject({
      params: { id: PLAN_ID },
      body: { reason: 'Replaced by Premium' },
    });
  });

  it('offers a plan only on the cycles that have a price', () => {
    expect(cyclesOf(plan())).toEqual(['MONTHLY', 'YEARLY']);
    expect(cyclesOf(undefined)).toEqual([]);
    expect(planRequestOf({ ...EMPTY_PLAN, code: 'X1', name: 'X' }).success).toBe(false);
  });
});

describe('[VCP-003] a restaurant’s subscription', () => {
  it('shows the plan to Read-only and lets Finance change it with a reason', async () => {
    const readOnly = renderApp({
      cp: billingPlane('READ_ONLY'),
      path: `/restaurants/${TENANT_ID}`,
    });
    await readOnly.user.click(await screen.findByRole('tab', { name: 'Subscription' }));
    expect(await screen.findByText('Monthly, ₹2,499.00')).toBeVisible();
    expect(screen.getByText('01-11-2026')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
    readOnly.unmount();

    const cp = billingPlane('FINANCE');
    cp.on('setSubscription', ({ body }) => ({
      ...SUBSCRIPTION,
      cycle: (body as { cycle: 'YEARLY' }).cycle,
      price: 24_99_000,
    }));
    const { user } = renderApp({ cp, path: `/restaurants/${TENANT_ID}` });
    await user.click(await screen.findByRole('tab', { name: 'Subscription' }));
    await user.click(await screen.findByRole('button', { name: 'Change plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the plan' });
    const plans = await within(dialog).findByLabelText('Plan');
    // Archived plans cannot be chosen.
    expect(
      within(plans)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a plan', 'Standard']);
    const cycle = within(dialog).getByLabelText('Billing cycle');
    expect(
      within(cycle)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a cycle', 'Monthly, ₹2,499.00', 'Yearly, ₹24,990.00']);
    await user.selectOptions(cycle, 'YEARLY');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Moved to yearly');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Subscription saved')).toBeVisible();
    expect(cp.callsOf('setSubscription')[0]?.body).toMatchObject({
      planId: PLAN_ID,
      cycle: 'YEARLY',
      reason: 'Moved to yearly',
    });
  });

  it('says when a restaurant is not on a plan yet', async () => {
    const cp = billingPlane('FINANCE');
    cp.on('getSubscription', () => {
      throw new FakeRefusal(404, 'NOT_FOUND', 'The subscription was not found.');
    });
    const { user } = renderApp({ cp, path: `/restaurants/${TENANT_ID}` });
    await user.click(await screen.findByRole('tab', { name: 'Subscription' }));
    expect(await screen.findByText('Not on a plan yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Put on a plan' })).toBeVisible();
  });
});

describe('[VCP-003] [LIC-005] [LIC-006] invoices and payments', () => {
  it('filters by restaurant and status in the address; Support sees but cannot record', async () => {
    const cp = billingPlane('SUPPORT');
    const { user, container } = renderApp({ cp, path: `/invoices?tenant=${TENANT_ID}` });
    expect(await screen.findByText('SUB/2026-27/00001')).toBeVisible();
    expect(screen.getByText('24 days overdue')).toBeVisible();
    expect(screen.getByText('01-09-2026 to 30-09-2026')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Record a payment/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run billing now' })).toBeNull();
    await expectNoAxeViolations(container);
    await user.selectOptions(screen.getByLabelText('Status'), 'OVERDUE');
    await waitFor(() => {
      expect(cp.callsOf('listVendorInvoices').at(-1)?.query).toEqual({
        tenantId: TENANT_ID,
        status: 'OVERDUE',
      });
    });
    await user.click(screen.getByRole('button', { name: 'Show every restaurant' }));
    await waitFor(() => {
      expect(cp.callsOf('listVendorInvoices').at(-1)?.query).toEqual({ status: 'OVERDUE' });
    });
  });

  it('lets Finance record a payment, never more than is owed', async () => {
    const cp = billingPlane('FINANCE');
    cp.on('recordVendorPayment', ({ body }) =>
      invoice({
        paid: 1_00_000 + (body as { amount: number }).amount,
        status: 'PAID',
        daysOverdue: 0,
      }),
    );
    const { user, container } = renderApp({ cp, path: '/invoices' });
    await user.click(
      await screen.findByRole('button', { name: 'Record a payment for SUB/2026-27/00001' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Record a payment for SUB/2026-27/00001',
    });
    expect(
      within(dialog).getByText('Spice Route still owes ₹1,499.00 on this invoice.'),
    ).toBeVisible();
    const amount = within(dialog).getByLabelText('Amount');
    expect(amount).toHaveValue('1499');
    await user.clear(amount);
    await user.type(amount, '2000');
    expect(within(dialog).getByText('More than the ₹1,499.00 still owed.')).toBeVisible();
    await expectNoAxeViolations(container);
    await user.clear(amount);
    await user.type(amount, '1499');
    await user.selectOptions(within(dialog).getByLabelText('Paid by'), 'BANK_TRANSFER');
    await user.type(within(dialog).getByLabelText(/^Reference/), 'UTR 4417');
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText('SUB/2026-27/00001 paid in full')).toBeVisible();
    expect(cp.callsOf('recordVendorPayment')[0]).toMatchObject({
      params: { id: INVOICE_ID },
      body: { amount: 1_49_900, mode: 'BANK_TRANSFER', reference: 'UTR 4417' },
    });
  });

  it('voids an invoice with a reason and runs billing on demand', async () => {
    const cp = billingPlane('FINANCE');
    cp.on('voidVendorInvoice', () =>
      invoice({ status: 'VOID', voidReason: 'Issued in error', daysOverdue: 0 }),
    ).on('runBilling', () => ({ issued: 2, paymentDue: 1, grace: 0, restricted: 1 }));
    const { user } = renderApp({ cp, path: '/invoices' });
    await user.click(await screen.findByRole('button', { name: 'Void SUB/2026-27/00001' }));
    const dialog = await screen.findByRole('dialog', { name: 'Void SUB/2026-27/00001?' });
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Issued in error');
    await user.click(within(dialog).getByRole('button', { name: 'Void' }));
    expect(await screen.findByText('Invoice voided')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Run billing now' }));
    expect(
      await screen.findByText(
        'Billing run: 2 invoices issued; 1 payment due, 0 in grace, 1 restricted.',
      ),
    ).toBeVisible();
  });
});
