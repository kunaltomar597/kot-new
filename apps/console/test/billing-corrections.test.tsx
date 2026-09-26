import type { DayEndPreview } from '@rp/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { B, billView, invoiceView } from './billing-fixture.js';
import { STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

const SECOND_INVOICE = '0199a0e0-0000-7000-8000-000000000720';
const cashier = () => signsInAs(server(), 'CASHIER');

const OVERRIDE_REQUIRED = (capability: string) => ({
  status: 403,
  body: {
    code: 'OVERRIDE_REQUIRED',
    message: 'A manager must approve this. Ask a manager to enter their PIN.',
    details: { capability },
  },
});

const GRANTED = {
  status: 200,
  body: {
    overrideToken: 'override-1',
    expiresAt: '2026-09-26T10:02:00.000Z',
    approver: { id: STAFF.MANAGER.staffId, displayName: 'Meera', role: 'MANAGER' },
  },
};

const PRINTED = { printed: true, error: null, duplicate: false, printCount: 1 };

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[BILL-007] splitting a bill', () => {
  it('splits equally and prints each part as its own invoice', async () => {
    const second = invoiceView({ id: SECOND_INVOICE, invoiceNumber: 'INV/26-27/000013' });
    const fake = cashier()
      .on('GET', `/api/v1/bills/${B.bill}`, () => ({ status: 200, body: billView() }))
      .on('POST', `/api/v1/bills/${B.bill}/split`, () => ({
        status: 201,
        body: { invoices: [invoiceView(), second] },
      }))
      .on('POST', `/api/v1/invoices/${B.invoice}/print`, () => ({ status: 200, body: PRINTED }))
      .on('POST', `/api/v1/invoices/${SECOND_INVOICE}/print`, () => ({
        status: 200,
        body: PRINTED,
      }));
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/bill/${B.bill}`,
    });
    await user.click(await screen.findByRole('button', { name: t('billing.split.open') }));
    const dialog = await screen.findByRole('dialog', { name: t('billing.split.title') });
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole('button', { name: t('pos.item.more') }));
    await user.click(within(dialog).getByRole('button', { name: t('billing.split.submit') }));
    expect(await screen.findByText(t('billing.split.done', { count: 3 }))).toBeInTheDocument();
    expect(fake.callsTo('POST', `/api/v1/bills/${B.bill}/split`)[0]?.body).toEqual({
      mode: 'EQUAL',
      parts: 3,
      seriesId: null,
    });
    expect(fake.callsTo('POST', `/api/v1/invoices/${B.invoice}/print`)).toHaveLength(1);
    expect(fake.callsTo('POST', `/api/v1/invoices/${SECOND_INVOICE}/print`)).toHaveLength(1);
  });

  it('splits by items once every item has a part', async () => {
    const fake = cashier()
      .on('GET', `/api/v1/bills/${B.bill}`, () => ({ status: 200, body: billView() }))
      .on('POST', `/api/v1/bills/${B.bill}/split`, () => ({
        status: 201,
        body: { invoices: [] },
      }));
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/bill/${B.bill}`,
    });
    await user.click(await screen.findByRole('button', { name: t('billing.split.open') }));
    const dialog = await screen.findByRole('dialog', { name: t('billing.split.title') });
    await user.click(within(dialog).getByRole('tab', { name: t('billing.split.items') }));
    const partFor = (item: string) =>
      within(dialog).getByLabelText(t('billing.split.partOf', { item }));
    await user.selectOptions(partFor('2 × Paneer Tikka (Full)'), '1');
    await user.click(within(dialog).getByRole('button', { name: t('billing.split.submit') }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      t('billing.split.unassigned'),
    );
    await user.selectOptions(partFor('1 × Lassi'), '2');
    await user.click(within(dialog).getByRole('button', { name: t('billing.split.submit') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', `/api/v1/bills/${B.bill}/split`)[0]?.body).toEqual({
        mode: 'ITEMS',
        parts: [[{ orderItemId: B.item1, quantity: 2 }], [{ orderItemId: B.item2, quantity: 1 }]],
        seriesId: null,
      });
    });
  });
});

describe('[BILL-010] [AUTH-011] correcting a printed bill', () => {
  const invoiced = () => billView({ status: 'INVOICED', invoiceIds: [B.invoice] });

  it('cancels an invoice with a reason and a manager’s approval', async () => {
    const fake = cashier()
      .on('GET', `/api/v1/bills/${B.bill}`, () => ({ status: 200, body: invoiced() }))
      .on('GET', `/api/v1/invoices/${B.invoice}`, () => ({ status: 200, body: invoiceView() }))
      .on(
        'POST',
        `/api/v1/invoices/${B.invoice}/void`,
        () => OVERRIDE_REQUIRED('INVOICE_VOID'),
        () => ({
          status: 200,
          body: invoiceView({
            status: 'VOIDED',
            voidReason: 'Wrong table',
            voidedAt: '2026-09-26T10:05:00.000Z',
          }),
        }),
      )
      .on('POST', '/api/v1/auth/override', () => GRANTED);
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/bill/${B.bill}`,
    });
    const voidFor = t('billing.voidFor', { number: 'INV/26-27/000012' });
    await user.click(await screen.findByRole('button', { name: voidFor }));
    const dialog = await screen.findByRole('dialog', { name: voidFor });
    await user.type(within(dialog).getByLabelText(t('billing.voidReason')), 'Wrong table');
    await user.click(within(dialog).getByRole('button', { name: t('billing.confirm') }));
    const approval = await screen.findByRole('dialog', { name: t('override.title') });
    await user.click(within(approval).getByRole('button', { name: 'Meera' }));
    await user.keyboard('2222');
    expect(
      await screen.findByText(t('billing.voidedToast', { number: 'INV/26-27/000012' })),
    ).toBeInTheDocument();
    expect(fake.callsTo('POST', '/api/v1/auth/override')[0]?.body).toMatchObject({
      capability: 'INVOICE_VOID',
      entityType: 'invoice',
      entityId: B.invoice,
    });
    const [first, retry] = fake.callsTo('POST', `/api/v1/invoices/${B.invoice}/void`);
    expect(first?.body).toEqual({ reason: 'Wrong table' });
    expect(first?.headers['x-override-token']).toBeUndefined();
    expect(retry?.headers['x-override-token']).toBe('override-1');
  });

  it('reopens a printed bill for editing, which keeps its number', async () => {
    const editing = billView({ invoiceIds: [B.invoice], editingInvoiceId: B.invoice });
    const fake = cashier()
      .on(
        'GET',
        `/api/v1/bills/${B.bill}`,
        () => ({ status: 200, body: invoiced() }),
        () => ({ status: 200, body: editing }),
      )
      .on('GET', `/api/v1/invoices/${B.invoice}`, () => ({ status: 200, body: invoiceView() }))
      .on(
        'POST',
        `/api/v1/invoices/${B.invoice}/reopen`,
        () => OVERRIDE_REQUIRED('BILL_EDIT_AFTER_PRINT'),
        () => ({ status: 200, body: editing }),
      )
      .on('POST', '/api/v1/auth/override', () => GRANTED);
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/bill/${B.bill}`,
    });
    const editFor = t('billing.editFor', { number: 'INV/26-27/000012' });
    await user.click(await screen.findByRole('button', { name: editFor }));
    const dialog = await screen.findByRole('dialog', { name: editFor });
    await user.type(within(dialog).getByLabelText(t('billing.editReason')), 'Guest added a Lassi');
    await user.click(within(dialog).getByRole('button', { name: t('billing.confirm') }));
    const approval = await screen.findByRole('dialog', { name: t('override.title') });
    await user.click(within(approval).getByRole('button', { name: 'Meera' }));
    await user.keyboard('2222');
    expect(
      await screen.findByText(t('billing.editing', { number: 'INV/26-27/000012' })),
    ).toBeInTheDocument();
    expect(fake.callsTo('POST', '/api/v1/auth/override')[0]?.body).toMatchObject({
      capability: 'BILL_EDIT_AFTER_PRINT',
    });
    expect(fake.callsTo('POST', `/api/v1/invoices/${B.invoice}/reopen`)[1]?.body).toEqual({
      reason: 'Guest added a Lassi',
    });
  });

  it('says a reprint is marked DUPLICATE', async () => {
    const fake = cashier()
      .on('GET', `/api/v1/bills/${B.bill}`, () => ({ status: 200, body: invoiced() }))
      .on('GET', `/api/v1/invoices/${B.invoice}`, () => ({
        status: 200,
        body: invoiceView({ printCount: 1 }),
      }))
      .on('POST', `/api/v1/invoices/${B.invoice}/print`, () => ({
        status: 200,
        body: { ...PRINTED, duplicate: true, printCount: 2 },
      }));
    const { user } = await renderConsole({
      fake,
      signedIn: 'CASHIER',
      path: `/pos/bill/${B.bill}`,
    });
    await user.click(await screen.findByRole('button', { name: t('billing.reprint') }));
    expect(await screen.findByText(t('billing.reprinted'))).toBeInTheDocument();
  });
});

function dayEnd(overrides: Partial<DayEndPreview> = {}): DayEndPreview {
  return {
    businessDate: '2026-09-26',
    status: 'OPEN',
    blockers: { openShifts: [], openTables: [], unsettledInvoices: [] },
    report: {
      businessDate: '2026-09-26',
      orders: 14,
      invoices: {
        count: 12,
        settled: 12,
        unsettled: 0,
        voided: ['INV/26-27/000004'],
        numbers: [],
      },
      grossSales: 1_250_000,
      discounts: 25_000,
      serviceCharge: 40_000,
      taxTotal: 63_250,
      roundOff: 0,
      netSales: 1_328_250,
      settledSales: 1_328_250,
      taxes: [],
      payments: [{ mode: 'CASH', label: null, count: 5, amount: 428_250 }],
      paymentsTotal: 1_328_250,
      cash: { cashIn: 0, cashOut: 0 },
      shifts: [],
      totalVariance: -400,
    },
    ...overrides,
  };
}

describe('[BILL-013] [RPT-005] closing the day', () => {
  it('shows the Z-report and carries open tables forward when closing', async () => {
    const blocked = dayEnd({
      blockers: {
        openShifts: [],
        openTables: [{ tableSessionId: B.session, tableLabel: 'T4' }],
        unsettledInvoices: [],
      },
    });
    const fake = signsInAs(server(), 'MANAGER')
      .on(
        'GET',
        '/api/v1/day-end',
        () => ({ status: 200, body: blocked }),
        () => ({ status: 200, body: dayEnd({ status: 'CLOSED' }) }),
      )
      .on('POST', '/api/v1/day-end', () => ({
        status: 201,
        body: {
          businessDate: '2026-09-26',
          closedAt: '2026-09-26T22:00:00.000Z',
          closedById: STAFF.MANAGER.staffId,
          carriedForward: [B.session],
          report: blocked.report,
        },
      }));
    const { user, container } = await renderConsole({
      fake,
      signedIn: 'MANAGER',
      path: '/pos/day-end',
    });
    expect(
      await screen.findByRole('heading', { name: t('dayEnd.title', { date: '2026-09-26' }) }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('₹13,282.50')).toHaveLength(2);
    expect(screen.getByText('INV/26-27/000004')).toBeInTheDocument();
    expect(screen.getByText(t('dayEnd.openTables', { tables: 'T4' }))).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByLabelText(t('dayEnd.carryForward')));
    await user.click(screen.getByRole('button', { name: t('dayEnd.close') }));
    expect(
      await screen.findByText(t('dayEnd.closedToast', { date: '2026-09-26' })),
    ).toBeInTheDocument();
    expect(await screen.findByText(t('dayEnd.closed'))).toBeInTheDocument();
    expect(fake.callsTo('POST', '/api/v1/day-end')[0]?.body).toEqual({
      businessDate: '2026-09-26',
      carryForwardTables: true,
    });
  });

  it('shows why the day cannot close', async () => {
    const fake = signsInAs(server(), 'MANAGER')
      .on('GET', '/api/v1/day-end', () => ({
        status: 200,
        body: dayEnd({
          blockers: { openShifts: [], openTables: [], unsettledInvoices: [] },
        }),
      }))
      .on('POST', '/api/v1/day-end', () => ({
        status: 409,
        body: { code: 'SHIFTS_OPEN', message: 'Close the open shifts first.' },
      }));
    const { user } = await renderConsole({ fake, signedIn: 'MANAGER', path: '/pos/day-end' });
    expect(await screen.findByText(t('dayEnd.noBlockers'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('dayEnd.close') }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
