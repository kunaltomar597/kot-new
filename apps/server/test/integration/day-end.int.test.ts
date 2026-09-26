import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BillView,
  DayEndPreview,
  DayEndView,
  InvoiceView,
  type LoginResponse,
  ShiftView,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import { addDays } from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoDateOf } from '../../src/common/business-dates.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let cashier: LoginResponse;
let waiter: LoginResponse;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  cashier = await signIn(app, kit, 'CASHIER');
  waiter = await signIn(app, kit, 'WAITER');
  const base = { restaurantId: kit.restaurantId };
  await prisma.invoiceSeries.create({
    data: { ...base, name: 'Main', prefix: 'INV', isDefault: true },
  });
  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  const station = await prisma.station.create({
    data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
  });
  const gst5 = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      components: {
        create: [
          { ...base, code: 'CGST', rateBp: 250 },
          { ...base, code: 'SGST', rateBp: 250 },
        ],
      },
    },
  });
  for (const [name, price] of [
    ['Paneer Tikka', 28_000],
    ['Lassi', 8_000],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: gst5.id,
          foodType: 'VEG',
          stationId: station.id,
        },
      })
    ).id;
  }
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));

async function order(body: object, login = waiter): Promise<string> {
  const response = await server()
    .post('/api/v1/orders')
    .set(as(login))
    .send({ idempotencyKey: randomUUID(), ...body });
  const accepted = SubmitOrderResponse.parse(response.body);
  if (accepted.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return accepted.orderId;
}

const line = (name: string) => ({ clientLineId: randomUUID(), itemId: id(name), quantity: 1 });

async function tableInvoice(table: string, item: string): Promise<InvoiceView> {
  const session = TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${id(table)}/open`)
        .set(as(waiter))
        .send({ covers: 2 })
    ).body,
  );
  ids[`session:${table}`] = session.id;
  await order({
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId: session.id,
    lines: [line(item)],
  });
  return issue({ tableSessionId: session.id });
}

async function takeawayInvoice(): Promise<InvoiceView> {
  const orderId = await order(
    { source: 'POS', orderType: 'TAKEAWAY', lines: [line('Lassi')] },
    cashier,
  );
  return issue({ orderId });
}

async function issue(target: object): Promise<InvoiceView> {
  const bill = BillView.parse(
    (await server().post('/api/v1/bills').set(as(cashier)).send(target)).body,
  );
  return InvoiceView.parse(
    (await server().post(`/api/v1/bills/${bill.id}/invoice`).set(as(cashier)).send({})).body,
  );
}

function pay(invoice: InvoiceView, payment: object) {
  return server()
    .post(`/api/v1/invoices/${invoice.id}/payments`)
    .set(as(cashier))
    .send({ idempotencyKey: randomUUID(), payments: [{ amount: invoice.grandTotal, ...payment }] });
}

let today: string;
let shift: ShiftView;
let takeaway: InvoiceView;

describe('[BILL-013] [RPT-005] day-end', () => {
  it('previews the Z-report and lists what blocks closing the day', async () => {
    shift = ShiftView.parse(
      (await server().post('/api/v1/shifts').set(as(cashier)).send({ openingFloat: 100_000 })).body,
    );
    const t1 = await tableInvoice('T1', 'Paneer Tikka');
    expect((await pay(t1, { mode: 'CASH', tendered: 30_000 })).status).toBe(200);
    await tableInvoice('T2', 'Lassi');
    takeaway = await takeawayInvoice();
    const voided = await takeawayInvoice();
    expect(
      (
        await server()
          .post(`/api/v1/invoices/${voided.id}/void`)
          .set(as(manager))
          .send({ reason: 'Customer left' })
      ).status,
    ).toBe(200);

    expect((await server().get('/api/v1/day-end').set(as(cashier))).status).toBe(403);
    const preview = DayEndPreview.parse(
      (await server().get('/api/v1/day-end').set(as(manager))).body,
    );
    today = preview.businessDate;
    expect(preview.status).toBe('OPEN');
    expect(preview.blockers).toEqual({
      openShifts: [{ shiftId: shift.id, staffId: kit.staff.CASHIER }],
      openTables: [{ tableSessionId: id('session:T2'), tableLabel: 'T2' }],
      unsettledInvoices: [
        {
          invoiceId: takeaway.id,
          invoiceNumber: takeaway.invoiceNumber,
          grandTotal: 8_400,
        },
      ],
    });
    expect(preview.report).toMatchObject({
      orders: 4,
      invoices: { count: 3, settled: 1, unsettled: 2, voided: [voided.invoiceNumber] },
      grossSales: 44_000,
      taxTotal: 2_200,
      netSales: 46_200,
      settledSales: 29_400,
      paymentsTotal: 29_400,
    });
    expect(preview.report.invoices.numbers).toHaveLength(4);
    expect(preview.report.taxes).toEqual([
      { code: 'CGST', rateBp: 250, taxableValue: 44_000, amount: 1_100 },
      { code: 'SGST', rateBp: 250, taxableValue: 44_000, amount: 1_100 },
    ]);
  });

  it('refuses to close while shifts are open, bills unpaid or tables open', async () => {
    const close = (body: object) => server().post('/api/v1/day-end').set(as(manager)).send(body);
    const blocked = await close({ businessDate: today });
    expect([blocked.status, codeOf(blocked)]).toEqual([409, 'DAY_END_BLOCKED']);
    expect(ApiError.parse(blocked.body).details).toMatchObject({
      blockers: { openShifts: [{ shiftId: shift.id }] },
    });

    expect((await pay(takeaway, { mode: 'UPI' })).status).toBe(200);
    const closedShift = ShiftView.parse(
      (
        await server()
          .post(`/api/v1/shifts/${shift.id}/close`)
          .set(as(cashier))
          .send({ countedCash: 129_000 })
      ).body,
    );
    expect(closedShift.variance).toBe(-400);

    const tableOpen = await close({ businessDate: today });
    expect([tableOpen.status, codeOf(tableOpen)]).toEqual([409, 'DAY_END_BLOCKED']);
    const future = await close({ businessDate: addDays(today, 1), carryForwardTables: true });
    expect([future.status, codeOf(future)]).toEqual([409, 'DAY_NOT_STARTED']);
  });

  it('closes the day, carrying the open table forward, and keeps the Z-report', async () => {
    const closed = await server()
      .post('/api/v1/day-end')
      .set(as(manager))
      .send({ businessDate: today, carryForwardTables: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    const day = DayEndView.parse(closed.body);
    expect(day).toMatchObject({
      businessDate: today,
      closedById: kit.staff.MANAGER,
      carriedForward: [id('session:T2')],
      report: {
        invoices: { settled: 2, unsettled: 1 },
        netSales: 46_200,
        settledSales: 37_800,
        totalVariance: -400,
        payments: [
          { mode: 'CASH', label: null, count: 1, amount: 29_400 },
          { mode: 'UPI', label: null, count: 1, amount: 8_400 },
        ],
      },
    });
    const session = await prisma.tableSession.findUniqueOrThrow({
      where: { id: id('session:T2') },
    });
    expect(isoDateOf(session.businessDate)).toBe(addDays(today, 1));
    expect(await prisma.auditLog.count({ where: { action: 'DAY_CLOSED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'TABLES_CARRIED_FORWARD' } })).toBe(1);

    const again = await server()
      .post('/api/v1/day-end')
      .set(as(manager))
      .send({ businessDate: today, carryForwardTables: true });
    expect([again.status, codeOf(again)]).toEqual([409, 'DAY_ALREADY_CLOSED']);
    const kept = DayEndView.parse(
      (await server().get(`/api/v1/day-ends/${today}`).set(as(manager))).body,
    );
    expect(kept).toEqual(day);
    const notClosed = await server()
      .get(`/api/v1/day-ends/${addDays(today, 1)}`)
      .set(as(manager));
    expect([notClosed.status, codeOf(notClosed)]).toEqual([404, 'DAY_NOT_CLOSED']);
  });

  it('records everything after day-end on the next business date', async () => {
    const orderId = await order(
      { source: 'POS', orderType: 'TAKEAWAY', lines: [line('Lassi')] },
      cashier,
    );
    const next = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(isoDateOf(next.businessDate)).toBe(addDays(today, 1));
    const preview = DayEndPreview.parse(
      (await server().get('/api/v1/day-end').set(as(manager))).body,
    );
    expect(preview.businessDate).toBe(addDays(today, 1));
    expect(preview.report.orders).toBe(1);
  });
});
