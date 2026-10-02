import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BillingRunView,
  PlanView,
  SubscriptionView,
  VendorInvoiceListResponse,
  VendorInvoiceView,
} from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import { BillingService } from '../../src/billing/billing.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { LicencesService } from '../../src/licences/licences.service.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let billing: BillingService;
let licences: LicencesService;
const tokens: Record<string, string> = {};
let tenantId: string;
let installationId: string;
let plan: PlanView;

const server = () => request(httpServer(app));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const as = (role: string) => bearer(tokens[role] ?? '');
/** Noon IST on a day, as the billing run would see it. */
const on = (date: string) => new Date(`${date}T06:30:00.000Z`);
const stateOf = async () => (await licences.summary(installationId)).state;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url, {
    billingPaymentTermsDays: 7,
    billingGraceAfterDays: 15,
  });
  prisma = app.get(PrismaService);
  billing = app.get(BillingService);
  licences = app.get(LicencesService);
  for (const role of ['FINANCE', 'READ_ONLY', 'SUPPORT'] as const) {
    tokens[role] = await signInVendor(app, await vendorAccount(app, role));
  }
  const admin = app.get(AdminService);
  tenantId = (await admin.createTenant('Spice Route', 'cli:test')).id;
  installationId = (await admin.createInstallation({ tenantId, name: 'Main PC' }, 'cli:test'))
    .installationId;
  // The licence terms exist from the first licence (P7-01b).
  await licences.summary(installationId);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[VCP-003] plans and subscriptions', () => {
  it('lets Finance add a plan; Read-only only sees the catalogue', async () => {
    const body = {
      code: 'STANDARD',
      name: 'Standard',
      prices: { MONTHLY: 2_49_900, QUARTERLY: null, YEARLY: 24_99_000 },
      deviceLimits: { TABLE_TABLET: 12, PAGER: 6, WAITER_PHONE: 6, KDS: 2 },
      modules: ['POS', 'KDS', 'WAITER_APP', 'TABLE_TABLET', 'QR_MENU', 'PAGERS'],
    };
    expect((await server().post('/v1/vendor/plans').set(as('READ_ONLY')).send(body)).status).toBe(
      403,
    );
    const created = await server().post('/v1/vendor/plans').set(as('FINANCE')).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    plan = PlanView.parse(created.body);
    const noCycle = await server()
      .post('/v1/vendor/plans')
      .set(as('FINANCE'))
      .send({ ...body, code: 'EMPTY', prices: { MONTHLY: null, QUARTERLY: null, YEARLY: null } });
    expect(noCycle.status).toBe(400);
    const list = await server().get('/v1/vendor/plans').set(as('READ_ONLY'));
    expect(list.body).toMatchObject({ plans: [{ code: 'STANDARD' }] });
  });

  it('puts a restaurant on a plan; its licence takes the plan’s limits', async () => {
    const quarterly = await server()
      .put(`/v1/vendor/tenants/${tenantId}/subscription`)
      .set(as('FINANCE'))
      .send({ planId: plan.id, cycle: 'QUARTERLY', startsOn: '2026-09-01', reason: 'Signed up' });
    expect([quarterly.status, codeOf(quarterly)]).toEqual([409, 'CYCLE_NOT_OFFERED']);
    const set = await server()
      .put(`/v1/vendor/tenants/${tenantId}/subscription`)
      .set(as('FINANCE'))
      .send({ planId: plan.id, cycle: 'MONTHLY', startsOn: '2026-09-01', reason: 'Signed up' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(SubscriptionView.parse(set.body)).toMatchObject({
      planName: 'Standard',
      price: 2_49_900,
      nextInvoiceOn: '2026-09-01',
    });
    expect(await licences.summary(installationId)).toMatchObject({
      plan: 'Standard',
      deviceLimits: { TABLE_TABLET: 12, KDS: 2 },
    });
  });
});

describe('[VCP-003] [LIC-005] [LIC-006] invoices, overdue follow-up and payments', () => {
  it('issues the invoices due, catching up, numbered by financial year', async () => {
    const run = BillingRunView.parse(await billing.run(on('2026-09-05')));
    expect(run).toMatchObject({ issued: 1, paymentDue: 0 });
    const caughtUp = await billing.run(on('2026-10-02'));
    expect(caughtUp.issued).toBe(1);
    const invoices = VendorInvoiceListResponse.parse(
      (await server().get('/v1/vendor/invoices').query({ tenantId }).set(as('READ_ONLY'))).body,
    ).invoices;
    expect(
      invoices.map((invoice) => [
        invoice.number,
        invoice.periodStart,
        invoice.periodEnd,
        invoice.dueOn,
      ]),
    ).toEqual([
      ['SUB/2026-27/00002', '2026-10-01', '2026-10-31', '2026-10-08'],
      ['SUB/2026-27/00001', '2026-09-01', '2026-09-30', '2026-09-08'],
    ]);
    // Running again issues nothing twice.
    expect((await billing.run(on('2026-10-02'))).issued).toBe(0);
  });

  it('moves the licence to payment due, then grace, then restricted', async () => {
    // 2 Oct: September's invoice is 24 days past due, more than 15: grace.
    expect(await stateOf()).toBe('GRACE');
    const graceDays = (await licences.summary(installationId)).graceDays;
    const later = new Date(on('2026-10-02').getTime() + (graceDays + 1) * 86_400_000);
    const run = await billing.run(later);
    expect(run.restricted).toBe(1);
    expect(await stateOf()).toBe('RESTRICTED');
    const audit = await prisma.auditEntry.findFirstOrThrow({
      where: { action: 'licence.changed', actor: 'system:billing' },
      orderBy: { id: 'desc' },
    });
    expect(audit.details).toMatchObject({
      reason: expect.stringContaining('SUB/2026-27/00001') as unknown,
    });
  });

  it('lifts the restriction as payments come in, down to what is still overdue', async () => {
    const [october, september] = VendorInvoiceListResponse.parse(
      (await server().get('/v1/vendor/invoices').query({ tenantId }).set(as('FINANCE'))).body,
    ).invoices;
    const bySupport = await server()
      .post(`/v1/vendor/invoices/${september?.id ?? ''}/payments`)
      .set(as('SUPPORT'))
      .send({ amount: 2_49_900, mode: 'UPI', reference: 'UPI-1', receivedOn: '2026-10-11' });
    expect(bySupport.status).toBe(403);
    const over = await server()
      .post(`/v1/vendor/invoices/${september?.id ?? ''}/payments`)
      .set(as('FINANCE'))
      .send({ amount: 3_00_000, mode: 'UPI', reference: 'UPI-1', receivedOn: '2026-10-11' });
    expect([over.status, codeOf(over)]).toEqual([409, 'OVERPAYMENT']);
    const pay = (invoiceId: string, amount: number, reference: string) =>
      billing.recordPayment(
        invoiceId,
        { amount, mode: 'UPI', reference, receivedOn: '2026-10-11' },
        'vendor:finance',
        on('2026-10-11'),
      );
    const part = await pay(september?.id ?? '', 1_00_000, 'NEFT-9');
    expect(part).toMatchObject({ status: 'ISSUED', paid: 1_00_000 });
    expect(await stateOf()).toBe('RESTRICTED');
    expect(await pay(september?.id ?? '', 1_49_900, 'UPI-2')).toMatchObject({ status: 'PAID' });
    // October's invoice is past due too (since 8 Oct, a few days): payment due, not restricted.
    expect(await stateOf()).toBe('PAYMENT_DUE');
    await pay(october?.id ?? '', 2_49_900, 'UPI-3');
    expect(await stateOf()).toBe('ACTIVE');
  });

  it('never undoes a vendor’s own restriction, and voids an invoice with a reason', async () => {
    await licences.change(
      installationId,
      { state: 'RESTRICTED', reason: 'Fraud review' },
      'vendor:x',
    );
    await billing.run(on('2026-11-02'));
    // November's invoice is not yet past due, and the restriction was a person's.
    expect(await stateOf()).toBe('RESTRICTED');
    const [november] = VendorInvoiceListResponse.parse(
      (
        await server()
          .get('/v1/vendor/invoices')
          .query({ tenantId, status: 'ISSUED' })
          .set(as('FINANCE'))
      ).body,
    ).invoices;
    const bySupport = await server()
      .post(`/v1/vendor/invoices/${november?.id ?? ''}/void`)
      .set(as('SUPPORT'))
      .send({ reason: 'Issued in error' });
    expect(bySupport.status).toBe(403);
    const voided = await billing.voidInvoice(
      november?.id ?? '',
      'Issued in error',
      'vendor:finance',
      on('2026-11-02'),
    );
    expect(VendorInvoiceView.parse(voided)).toMatchObject({
      status: 'VOID',
      voidReason: 'Issued in error',
    });
    expect(await stateOf()).toBe('RESTRICTED');
    const run = await server().post('/v1/vendor/billing/run').set(as('FINANCE'));
    expect(run.status).toBe(200);
  });
});
