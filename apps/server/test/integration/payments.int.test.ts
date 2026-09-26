import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BillView,
  CurrentShiftResponse,
  InvoicePaymentsView,
  InvoiceView,
  LoginResponse,
  ShiftView,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { addStaff, authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let cashier: LoginResponse;
let otherCashier: LoginResponse;
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
  const otherId = await addStaff(app, kit, 'CASHIER', '3939');
  otherCashier = LoginResponse.parse(
    (
      await server()
        .post('/api/v1/auth/pin-login')
        .set(authHeaders(kit.deviceId))
        .send({ staffId: otherId, pin: '3939' })
    ).body,
  );

  const base = { restaurantId: kit.restaurantId };
  await prisma.invoiceSeries.create({
    data: { ...base, name: 'Dine-in', prefix: 'INV', isDefault: true },
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

/** Orders at a table and prints the bill; returns the invoice. */
async function invoiceFor(table: string, lines: [string, number][]): Promise<InvoiceView> {
  const session = TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${id(table)}/open`)
        .set(as(waiter))
        .send({ covers: 2 })
    ).body,
  );
  ids[`session:${table}`] = session.id;
  const ordered = SubmitOrderResponse.parse(
    (
      await server()
        .post('/api/v1/orders')
        .set(as(waiter))
        .send({
          idempotencyKey: randomUUID(),
          source: 'WAITER_APP',
          orderType: 'DINE_IN',
          tableSessionId: session.id,
          lines: lines.map(([name, quantity]) => ({
            clientLineId: randomUUID(),
            itemId: id(name),
            quantity,
          })),
        })
    ).body,
  );
  expect(ordered.status).toBe('ACCEPTED');
  const bill = BillView.parse(
    (await server().post('/api/v1/bills').set(as(cashier)).send({ tableSessionId: session.id }))
      .body,
  );
  return InvoiceView.parse(
    (await server().post(`/api/v1/bills/${bill.id}/invoice`).set(as(cashier)).send({})).body,
  );
}

function pay(invoiceId: string, payments: object[], login = cashier, key = randomUUID()) {
  return server()
    .post(`/api/v1/invoices/${invoiceId}/payments`)
    .set(as(login))
    .send({ idempotencyKey: key, payments });
}

let shift: ShiftView;

describe('[BILL-013] opening a shift', () => {
  it('opens one shift per person with a float, audited', async () => {
    const opened = await server()
      .post('/api/v1/shifts')
      .set(as(cashier))
      .send({ openingFloat: 200_000 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    shift = ShiftView.parse(opened.body);
    expect(shift).toMatchObject({ status: 'OPEN', openingFloat: 200_000, expectedCash: 200_000 });

    const twice = await server().post('/api/v1/shifts').set(as(cashier)).send({ openingFloat: 0 });
    expect([twice.status, codeOf(twice)]).toEqual([409, 'SHIFT_ALREADY_OPEN']);
    expect(
      (await server().post('/api/v1/shifts').set(as(waiter)).send({ openingFloat: 0 })).status,
    ).toBe(403);
    const current = CurrentShiftResponse.parse(
      (await server().get('/api/v1/shifts/current').set(as(cashier))).body,
    );
    expect(current.shift?.id).toBe(shift.id);
    expect(
      CurrentShiftResponse.parse(
        (await server().get('/api/v1/shifts/current').set(as(manager))).body,
      ).shift,
    ).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'SHIFT_OPENED' } })).toBe(1);
  });
});

describe('[BILL-008] recording payments', () => {
  let invoice: InvoiceView;

  it('refuses paying more than the bill, short cash and unknown modes', async () => {
    invoice = await invoiceFor('T1', [
      ['Paneer Tikka', 2],
      ['Lassi', 1],
    ]);
    expect(invoice.grandTotal).toBe(67_200);
    expect((await pay(invoice.id, [{ mode: 'CARD', amount: 100 }], waiter)).status).toBe(403);

    const over = await pay(invoice.id, [{ mode: 'CARD', amount: 70_000 }]);
    expect([over.status, codeOf(over)]).toEqual([422, 'OVERPAYMENT']);
    const short = await pay(invoice.id, [{ mode: 'CASH', amount: 10_000, tendered: 5_000 }]);
    expect([short.status, codeOf(short)]).toEqual([422, 'INVALID_PAYMENT']);
    const cardTendered = await pay(invoice.id, [{ mode: 'CARD', amount: 100, tendered: 200 }]);
    expect(cardTendered.status).toBe(400);
    const unnamed = await pay(invoice.id, [{ mode: 'OTHER', amount: 100 }]);
    expect(unnamed.status).toBe(400);
    const unknown = await pay(invoice.id, [
      { mode: 'OTHER', amount: 100, otherModeName: 'Barter' },
    ]);
    expect([unknown.status, codeOf(unknown)]).toEqual([422, 'UNKNOWN_PAYMENT_MODE']);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('[TBL-004] settles on a split payment, gives change and frees the table', async () => {
    const key = randomUUID();
    const body = [
      { mode: 'CARD', amount: 40_000, reference: 'slip-0042' },
      { mode: 'CASH', amount: 27_200, tendered: 30_000 },
    ];
    const settled = await pay(invoice.id, body, cashier, key);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const view = InvoicePaymentsView.parse(settled.body);
    expect(view).toMatchObject({
      status: 'SETTLED',
      paid: 67_200,
      remaining: 0,
      tableClosed: true,
    });
    expect(view.payments.map((payment) => [payment.mode, payment.amount, payment.change])).toEqual([
      ['CARD', 40_000, null],
      ['CASH', 27_200, 2_800],
    ]);
    expect(view.payments[0]?.reference).toBe('slip-0042');
    expect(view.payments.every((payment) => payment.shiftId === shift.id)).toBe(true);

    const table = await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } });
    expect(table.state).toBe('FREE');
    const session = await prisma.tableSession.findUniqueOrThrow({
      where: { id: id('session:T1') },
    });
    expect(session.status).toBe('CLOSED');
    expect(await prisma.outboxEvent.count({ where: { eventType: 'BillSettled' } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'TableClosed' } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'BILL_SETTLED', entityId: invoice.id } }),
    ).toBe(1);

    // A retry records nothing twice; a reused key with other payments is refused.
    const retried = await pay(invoice.id, body, cashier, key);
    expect(retried.status).toBe(200);
    expect(InvoicePaymentsView.parse(retried.body).payments).toHaveLength(2);
    expect(await prisma.payment.count({ where: { invoiceId: invoice.id } })).toBe(2);
    const reused = await pay(invoice.id, [{ mode: 'UPI', amount: 1 }], cashier, key);
    expect([reused.status, codeOf(reused)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    const again = await pay(invoice.id, [{ mode: 'UPI', amount: 1 }]);
    expect([again.status, codeOf(again)]).toEqual([409, 'INVOICE_SETTLED']);
  });

  it('takes a bill in steps; cash needs an open shift', async () => {
    const second = await invoiceFor('T2', [['Lassi', 2]]);
    expect(second.grandTotal).toBe(16_800);
    const part = InvoicePaymentsView.parse(
      (await pay(second.id, [{ mode: 'UPI', amount: 6_800, reference: 'UPI-77' }], manager)).body,
    );
    expect(part).toMatchObject({
      status: 'ISSUED',
      paid: 6_800,
      remaining: 10_000,
      tableClosed: false,
    });
    expect(part.payments[0]?.shiftId).toBeNull();

    const cashWithoutShift = await pay(second.id, [{ mode: 'CASH', amount: 10_000 }], manager);
    expect([cashWithoutShift.status, codeOf(cashWithoutShift)]).toEqual([409, 'NO_OPEN_SHIFT']);
    const rest = InvoicePaymentsView.parse(
      (await pay(second.id, [{ mode: 'OTHER', amount: 10_000, otherModeName: 'Other' }])).body,
    );
    expect(rest).toMatchObject({ status: 'SETTLED', remaining: 0, tableClosed: true });
    expect(rest.payments[1]).toMatchObject({ mode: 'OTHER', modeLabel: 'Other' });

    const fetched = InvoicePaymentsView.parse(
      (await server().get(`/api/v1/invoices/${second.id}/payments`).set(as(cashier))).body,
    );
    expect(fetched.payments).toHaveLength(2);
  });
});

describe('[BILL-013] [AUD-006] cash in the drawer and closing the shift', () => {
  it('records cash in and out with a reason, the cashier on their own shift only', async () => {
    const move = (login: LoginResponse, body: object) =>
      server().post(`/api/v1/shifts/${shift.id}/cash-movements`).set(as(login)).send(body);
    expect((await move(waiter, { direction: 'IN', amount: 100, reason: 'Change' })).status).toBe(
      403,
    );
    expect(
      (await move(otherCashier, { direction: 'IN', amount: 100, reason: 'Change' })).status,
    ).toBe(403);
    expect((await move(cashier, { direction: 'IN', amount: 10_000 })).status).toBe(400);

    const cashIn = await move(cashier, {
      direction: 'IN',
      amount: 10_000,
      reason: 'Change from the bank',
    });
    expect(cashIn.status, JSON.stringify(cashIn.body)).toBe(200);
    const byManager = ShiftView.parse(
      (await move(manager, { direction: 'OUT', amount: 5_000, reason: 'Milk delivery' })).body,
    );
    expect(byManager).toMatchObject({
      cashPayments: 27_200,
      cashIn: 10_000,
      cashOut: 5_000,
      expectedCash: 232_200,
    });
    expect(byManager.movements.map((movement) => movement.reason)).toEqual([
      'Change from the bank',
      'Milk delivery',
    ]);
    expect(
      await prisma.auditLog.count({ where: { action: { in: ['CASH_IN', 'CASH_OUT'] } } }),
    ).toBe(2);
  });

  it('closes against a denomination count and records the variance', async () => {
    const closed = await server()
      .post(`/api/v1/shifts/${shift.id}/close`)
      .set(as(cashier))
      .send({ denominations: { '500': 4, '100': 3, '10': 2 } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(ShiftView.parse(closed.body)).toMatchObject({
      status: 'CLOSED',
      expectedCash: 232_200,
      countedCash: 232_000,
      variance: -200,
      denominations: { '500': 4, '100': 3, '10': 2 },
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'SHIFT_CLOSED' } });
    expect(audit.after).toMatchObject({
      expectedCash: 232_200,
      countedCash: 232_000,
      variance: -200,
    });

    const late = await server()
      .post(`/api/v1/shifts/${shift.id}/cash-movements`)
      .set(as(cashier))
      .send({ direction: 'OUT', amount: 100, reason: 'Too late' });
    expect([late.status, codeOf(late)]).toEqual([409, 'SHIFT_CLOSED']);
    const both = await server()
      .post(`/api/v1/shifts/${shift.id}/close`)
      .set(as(manager))
      .send({ countedCash: 1, denominations: { '1': 1 } });
    expect(both.status).toBe(400);
  });
});
