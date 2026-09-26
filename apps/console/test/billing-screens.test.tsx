import type { RecordPaymentsRequest } from '@rp/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { B, billView, invoiceView, paymentsView, shiftView } from './billing-fixture.js';
import type { FakeServer } from './fake-server.js';
import { STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

const cashier = () => signsInAs(server(), 'CASHIER');

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[BILL-001] [BILL-005] [AUTH-011] the bill', () => {
  it('previews the bill and asks a manager to approve a discount above the limit', async () => {
    const discounted = billView({
      discounts: [
        {
          id: B.discount,
          orderItemId: null,
          kind: 'PERCENT',
          rateBp: 2_000,
          amount: 12_800,
          reason: 'Regular guest',
          appliedById: STAFF.CASHIER.staffId,
          approvedById: STAFF.MANAGER.staffId,
        },
      ],
      discountTotal: 12_800,
      grandTotal: 56_960,
    });
    const fake: FakeServer = cashier()
      .on(
        'GET',
        `/api/v1/bills/${B.bill}`,
        () => ({ status: 200, body: billView() }),
        () => ({ status: 200, body: discounted }),
      )
      .on(
        'POST',
        `/api/v1/bills/${B.bill}/discounts`,
        () => ({
          status: 403,
          body: {
            code: 'OVERRIDE_REQUIRED',
            message: 'A manager must approve this. Ask a manager to enter their PIN.',
            details: { capability: 'DISCOUNT_ABOVE_LIMIT' },
          },
        }),
        () => ({ status: 200, body: discounted }),
      )
      .on('POST', '/api/v1/auth/override', () => ({
        status: 200,
        body: {
          overrideToken: 'override-1',
          expiresAt: '2026-09-26T10:02:00.000Z',
          approver: { id: STAFF.MANAGER.staffId, displayName: 'Meera', role: 'MANAGER' },
        },
      }));
    const { user, container } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/bill/${B.bill}`,
    });
    expect(
      await screen.findByRole('heading', {
        name: t('billing.billFor', { target: t('pos.table.title', { table: 'T4' }) }),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Paneer Tikka (Full)')).toBeInTheDocument();
    expect(screen.getByText('CGST 2.5%')).toBeInTheDocument();
    expect(screen.getByText('₹704.00')).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: t('billing.addDiscount') }));
    const dialog = await screen.findByRole('dialog', { name: t('billing.discount.title') });
    await user.type(within(dialog).getByLabelText(t('billing.discount.percentValue')), '20');
    await user.type(within(dialog).getByLabelText(t('billing.discount.reason')), 'Regular guest');
    await user.click(within(dialog).getByRole('button', { name: t('billing.discount.apply') }));

    const approval = await screen.findByRole('dialog', { name: t('override.title') });
    await user.click(within(approval).getByRole('button', { name: 'Meera' }));
    await user.keyboard('2222');
    await waitFor(() => {
      expect(fake.callsTo('POST', `/api/v1/bills/${B.bill}/discounts`)).toHaveLength(2);
    });
    expect(fake.callsTo('POST', '/api/v1/auth/override')[0]?.body).toEqual({
      approverStaffId: STAFF.MANAGER.staffId,
      pin: '2222',
      capability: 'DISCOUNT_ABOVE_LIMIT',
      entityType: 'bill',
      entityId: B.bill,
    });
    const [first, retry] = fake.callsTo('POST', `/api/v1/bills/${B.bill}/discounts`);
    expect(first?.body).toEqual({
      orderItemId: null,
      kind: 'PERCENT',
      rateBp: 2_000,
      amount: null,
      reason: 'Regular guest',
    });
    expect(first?.headers['x-override-token']).toBeUndefined();
    expect(retry?.headers['x-override-token']).toBe('override-1');
    expect(await screen.findByText(/Regular guest/)).toBeInTheDocument();
    expect(screen.getByText('₹569.60')).toBeInTheDocument();
  });

  it('prints the bill, which issues the invoice, and offers payment', async () => {
    const fake = cashier()
      .on(
        'GET',
        `/api/v1/bills/${B.bill}`,
        () => ({ status: 200, body: billView() }),
        () => ({ status: 200, body: billView({ status: 'INVOICED', invoiceIds: [B.invoice] }) }),
      )
      .on('GET', `/api/v1/invoices/${B.invoice}`, () => ({ status: 200, body: invoiceView() }))
      .on('POST', `/api/v1/bills/${B.bill}/invoice`, () => ({ status: 201, body: invoiceView() }))
      .on('POST', `/api/v1/invoices/${B.invoice}/print`, () => ({
        status: 200,
        body: {
          printed: false,
          error: 'The bill printer is off.',
          duplicate: false,
          printCount: 0,
        },
      }))
      .on('GET', `/api/v1/invoices/${B.invoice}/payments`, () => ({
        status: 200,
        body: paymentsView(),
      }));
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/bill/${B.bill}`,
    });
    await user.click(await screen.findByRole('button', { name: t('billing.printBill') }));
    expect(
      await screen.findByText(
        t('billing.notPrinted', { number: 'INV/26-27/000012', error: 'The bill printer is off.' }),
      ),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: t('billing.pay') }));
    expect(
      await screen.findByRole('heading', {
        name: t('payment.title', { number: 'INV/26-27/000012' }),
      }),
    ).toBeInTheDocument();
  });

  it('removes the service charge with a reason', async () => {
    const fake = cashier()
      .on('GET', `/api/v1/bills/${B.bill}`, () => ({ status: 200, body: billView() }))
      .on('POST', `/api/v1/bills/${B.bill}/service-charge`, () => ({
        status: 200,
        body: billView(),
      }));
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/bill/${B.bill}`,
    });
    await user.click(await screen.findByRole('button', { name: t('billing.removeServiceCharge') }));
    const dialog = await screen.findByRole('dialog', { name: t('billing.removeServiceCharge') });
    await user.type(within(dialog).getByLabelText(t('billing.serviceChargeReason')), 'Guest asked');
    await user.click(within(dialog).getByRole('button', { name: t('billing.confirm') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', `/api/v1/bills/${B.bill}/service-charge`)[0]?.body).toEqual({
        removed: true,
        reason: 'Guest asked',
      });
    });
  });
});

describe('[BILL-008] taking payment', () => {
  it('splits across UPI and cash with change, and retries with the same key', async () => {
    const fake = cashier()
      .on('GET', `/api/v1/invoices/${B.invoice}/payments`, () => ({
        status: 200,
        body: paymentsView(),
      }))
      .on(
        'POST',
        `/api/v1/invoices/${B.invoice}/payments`,
        () => {
          throw new TypeError('Failed to fetch');
        },
        () => ({
          status: 200,
          body: paymentsView({ status: 'SETTLED', paid: 70_400, remaining: 0 }),
        }),
      )
      .on('GET', `/api/v1/bills/${B.bill}`, () => ({
        status: 200,
        body: billView({ status: 'INVOICED' }),
      }));
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/pay/${B.invoice}?bill=${B.bill}`,
    });
    const amount = await screen.findByLabelText(t('payment.amount'));
    expect(amount).toHaveValue('704.00');

    await user.selectOptions(screen.getByLabelText(t('payment.mode')), t('payment.modes.UPI'));
    await user.clear(amount);
    await user.type(amount, '300');
    await user.click(screen.getByRole('button', { name: t('payment.add') }));
    expect(screen.getByLabelText(t('payment.amount'))).toHaveValue('404.00');

    await user.selectOptions(screen.getByLabelText(t('payment.mode')), t('payment.modes.CASH'));
    await user.type(screen.getByLabelText(t('payment.tendered')), '500');
    expect(screen.getByText(`${t('payment.change')}:`, { exact: false })).toHaveTextContent(
      '₹96.00',
    );
    await user.click(screen.getByRole('button', { name: t('payment.record') }));
    expect(
      await screen.findByText(t('payment.notRecorded', { message: t('errors.network') })),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('payment.record') }));
    expect(
      await screen.findByText(t('payment.settled', { number: 'INV/26-27/000012' })),
    ).toBeInTheDocument();

    const [first, second] = fake
      .callsTo('POST', `/api/v1/invoices/${B.invoice}/payments`)
      .map((call) => call.body as RecordPaymentsRequest);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.payments).toEqual([
      { mode: 'UPI', amount: 30_000, tendered: null, reference: null, otherModeName: null },
      { mode: 'CASH', amount: 40_400, tendered: 50_000, reference: null, otherModeName: null },
    ]);
    // Paid in full: back to the bill.
    expect(
      await screen.findByRole('heading', {
        name: t('billing.billFor', { target: t('pos.table.title', { table: 'T4' }) }),
      }),
    ).toBeInTheDocument();
  });

  it('points to the shift when cash needs one', async () => {
    const fake = cashier()
      .on('GET', `/api/v1/invoices/${B.invoice}/payments`, () => ({
        status: 200,
        body: paymentsView(),
      }))
      .on('POST', `/api/v1/invoices/${B.invoice}/payments`, () => ({
        status: 409,
        body: { code: 'NO_OPEN_SHIFT', message: 'Open a shift before taking cash.' },
      }))
      .on('GET', '/api/v1/shifts/current', () => ({ status: 200, body: { shift: null } }));
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/pay/${B.invoice}`,
    });
    await user.click(await screen.findByRole('button', { name: t('payment.record') }));
    await user.click(await screen.findByRole('button', { name: t('payment.openShift') }));
    expect(await screen.findByText(t('shift.none'))).toBeInTheDocument();
  });

  it('refuses an amount above what is still to pay', async () => {
    const fake = cashier().on('GET', `/api/v1/invoices/${B.invoice}/payments`, () => ({
      status: 200,
      body: paymentsView({ paid: 40_400, remaining: 30_000 }),
    }));
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/pay/${B.invoice}`,
    });
    const amount = await screen.findByLabelText(t('payment.amount'));
    await user.clear(amount);
    await user.type(amount, '500');
    await user.click(screen.getByRole('button', { name: t('payment.add') }));
    expect(screen.getByText(t('payment.invalidAmount'))).toBeInTheDocument();
    expect(fake.callsTo('POST', `/api/v1/invoices/${B.invoice}/payments`)).toHaveLength(0);
  });
});

describe('[BILL-013] the cashier’s shift', () => {
  it('opens a shift with the float', async () => {
    const fake = cashier()
      .on(
        'GET',
        '/api/v1/shifts/current',
        () => ({ status: 200, body: { shift: null } }),
        () => ({ status: 200, body: { shift: shiftView() } }),
      )
      .on('POST', '/api/v1/shifts', () => ({ status: 201, body: shiftView() }));
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos/shift' });
    await user.type(await screen.findByLabelText(t('shift.openingFloat')), '1000');
    await user.click(screen.getByRole('button', { name: t('shift.open') }));
    expect(await screen.findByText(t('shift.expected'))).toBeInTheDocument();
    expect(fake.callsTo('POST', '/api/v1/shifts')[0]?.body).toEqual({ openingFloat: 100_000 });
  });

  it('records cash out and closes with the counted cash', async () => {
    const fake = cashier()
      .on('GET', '/api/v1/shifts/current', () => ({ status: 200, body: { shift: shiftView() } }))
      .on('POST', `/api/v1/shifts/${B.shift}/cash-movements`, () => ({
        status: 200,
        body: shiftView(),
      }))
      .on('POST', `/api/v1/shifts/${B.shift}/close`, () => ({
        status: 200,
        body: shiftView({
          status: 'CLOSED',
          countedCash: 139_600,
          variance: -400,
          closedAt: '2026-09-26T20:00:00.000Z',
        }),
      }));
    const { user } = await renderConsole({ fake, signedIn: 'CASHIER', path: '/pos/shift' });
    expect(await screen.findByText('₹1,400.00')).toBeInTheDocument();
    await user.type(screen.getByLabelText(t('shift.movementAmount')), '250');
    await user.type(screen.getByLabelText(t('shift.movementReason')), 'Milk from the shop');
    await user.click(screen.getByRole('button', { name: t('shift.record') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', `/api/v1/shifts/${B.shift}/cash-movements`)[0]?.body).toEqual({
        direction: 'OUT',
        amount: 25_000,
        reason: 'Milk from the shop',
      });
    });
    await user.type(screen.getByLabelText(t('shift.counted')), '1396');
    await user.click(screen.getByRole('button', { name: t('shift.close') }));
    expect(await screen.findByText(t('shift.closed', { variance: '-₹4.00' }))).toBeInTheDocument();
  });
});
