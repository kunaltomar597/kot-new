import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BillView,
  InvoiceView,
  type LoginResponse,
  SplitBillResponse,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import { calendarDateOf, financialYearOf } from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const FY = financialYearOf(calendarDateOf(new Date(), 'Asia/Kolkata'));
const number = (n: number) => `INV/${FY.shortLabel}/${String(n).padStart(6, '0')}`;

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
    data: { ...base, name: 'Dine-in', prefix: 'INV', isDefault: true },
  });
  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  const station = await prisma.station.create({
    data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
  });
  const taxGroup = async (name: string, rateBp: number) =>
    (
      await prisma.taxGroup.create({
        data: {
          ...base,
          name,
          components: {
            create: [
              { ...base, code: 'CGST', rateBp },
              { ...base, code: 'SGST', rateBp },
            ],
          },
        },
      })
    ).id;
  const gst5 = await taxGroup('GST 5 %', 250);
  const gst18 = await taxGroup('GST 18 %', 900);
  for (const [name, price, group] of [
    ['Paneer Tikka', 28_000, gst5],
    ['Lassi', 8_000, gst5],
    ['Water', 2_000, gst18],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: group,
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

async function billFor(table: string, lines: [string, number][]): Promise<BillView> {
  const session = TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${id(table)}/open`)
        .set(as(waiter))
        .send({ covers: 4 })
    ).body,
  );
  const response = await server()
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
    });
  const accepted = SubmitOrderResponse.parse(response.body);
  if (accepted.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return BillView.parse(
    (await server().post('/api/v1/bills').set(as(cashier)).send({ tableSessionId: session.id }))
      .body,
  );
}

function split(billId: string, body: object) {
  return server().post(`/api/v1/bills/${billId}/split`).set(as(cashier)).send(body);
}

const total = (invoices: readonly InvoiceView[], pick: (invoice: InvoiceView) => number) =>
  invoices.reduce((sum, invoice) => sum + pick(invoice), 0);

let equalParts: InvoiceView[];
let t1: BillView;

describe('[BILL-007] splitting a bill', () => {
  it('splits into equal parts, each its own invoice, adding up exactly to the bill', async () => {
    t1 = await billFor('T1', [
      ['Paneer Tikka', 2],
      ['Lassi', 1],
      ['Water', 1],
    ]);
    expect(t1.grandTotal).toBe(69_600);
    const tooFew = await split(t1.id, { mode: 'EQUAL', parts: 1 });
    expect(tooFew.status).toBe(400);

    const response = await split(t1.id, { mode: 'EQUAL', parts: 3 });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    equalParts = SplitBillResponse.parse(response.body).invoices;
    expect(equalParts.map((invoice) => invoice.invoiceNumber)).toEqual([
      number(1),
      number(2),
      number(3),
    ]);
    expect(total(equalParts, (invoice) => invoice.grandTotal)).toBe(t1.grandTotal);
    expect(total(equalParts, (invoice) => invoice.subtotal)).toBe(t1.subtotal);
    expect(total(equalParts, (invoice) => invoice.taxTotal)).toBe(t1.taxTotal);
    expect(total(equalParts, (invoice) => invoice.roundOff)).toBe(t1.roundOff);
    const cgst = (invoice: InvoiceView) =>
      invoice.taxLines
        .filter((tax) => tax.code === 'CGST')
        .reduce((sum, tax) => sum + tax.amount, 0);
    expect(total(equalParts, cgst)).toBe(1_780);
    for (const invoice of equalParts) {
      expect(invoice.lines.reduce((sum, line) => sum + line.lineTotal, 0)).toBe(invoice.subtotal);
      expect(invoice.lines[0]?.description).toMatch(/^Paneer Tikka \(share \d of 3\)$/);
    }

    const table = await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } });
    expect(table.state).toBe('BILL_PRINTED');
    const bill = BillView.parse(
      (await server().get(`/api/v1/bills/${t1.id}`).set(as(cashier))).body,
    );
    expect(bill).toMatchObject({ status: 'INVOICED', invoiceIds: equalParts.map((i) => i.id) });
    expect(await prisma.auditLog.count({ where: { action: 'BILL_SPLIT', entityId: t1.id } })).toBe(
      1,
    );
    expect(await prisma.outboxEvent.count({ where: { eventType: 'BillPrinted' } })).toBe(3);

    const again = await split(t1.id, { mode: 'EQUAL', parts: 2 });
    expect([again.status, codeOf(again)]).toEqual([409, 'BILL_ALREADY_PRINTED']);
  });

  it('splits by items, and refuses a split that does not give out every item exactly', async () => {
    const t2 = await billFor('T2', [
      ['Paneer Tikka', 3],
      ['Water', 1],
    ]);
    const [tikka, water] = [t2.lines[0]?.orderItemId ?? '', t2.lines[1]?.orderItemId ?? ''];

    const incomplete = await split(t2.id, {
      mode: 'ITEMS',
      parts: [[{ orderItemId: tikka, quantity: 2 }], [{ orderItemId: water, quantity: 1 }]],
    });
    expect([incomplete.status, codeOf(incomplete)]).toEqual([422, 'SPLIT_INCOMPLETE']);
    const unknown = await split(t2.id, {
      mode: 'ITEMS',
      parts: [[{ orderItemId: tikka, quantity: 3 }], [{ orderItemId: randomUUID(), quantity: 1 }]],
    });
    expect([unknown.status, codeOf(unknown)]).toEqual([422, 'SPLIT_INVALID']);

    const response = await split(t2.id, {
      mode: 'ITEMS',
      parts: [
        [{ orderItemId: tikka, quantity: 2 }],
        [
          { orderItemId: tikka, quantity: 1 },
          { orderItemId: water, quantity: 1 },
        ],
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [first, second] = SplitBillResponse.parse(response.body).invoices;
    expect(first?.invoiceNumber).toBe(number(4));
    expect(first?.lines).toEqual([
      expect.objectContaining({ description: 'Paneer Tikka', quantity: 2, lineTotal: 56_000 }),
    ]);
    expect(first?.taxLines.map((tax) => tax.rateBp)).toEqual([250, 250]);
    expect(second?.lines.map((line) => [line.description, line.quantity])).toEqual([
      ['Paneer Tikka', 1],
      ['Water', 1],
    ]);
    expect((first?.grandTotal ?? 0) + (second?.grandTotal ?? 0)).toBe(t2.grandTotal);
  });
});

describe('[BILL-010] voiding the parts of a split bill', () => {
  it('opens the bill again only when every part is voided, then issues it whole', async () => {
    const voidPart = (invoice: InvoiceView) =>
      server()
        .post(`/api/v1/invoices/${invoice.id}/void`)
        .set(as(manager))
        .send({ reason: 'Guests will pay together' });
    const [a, b, c] = equalParts;
    if (a === undefined || b === undefined || c === undefined) throw new Error('three parts');

    expect((await voidPart(a)).status).toBe(200);
    let bill = BillView.parse((await server().get(`/api/v1/bills/${t1.id}`).set(as(cashier))).body);
    expect(bill.status).toBe('INVOICED');
    expect((await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } })).state).toBe(
      'BILL_PRINTED',
    );
    const reopen = await server()
      .post(`/api/v1/invoices/${b.id}/reopen`)
      .set(as(manager))
      .send({ reason: 'Change it' });
    expect([reopen.status, codeOf(reopen)]).toEqual([409, 'INVOICE_NOT_EDITABLE']);

    expect((await voidPart(b)).status).toBe(200);
    expect((await voidPart(c)).status).toBe(200);
    bill = BillView.parse((await server().get(`/api/v1/bills/${t1.id}`).set(as(cashier))).body);
    expect(bill.status).toBe('OPEN');
    expect((await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } })).state).toBe(
      'OCCUPIED',
    );

    const whole = await server().post(`/api/v1/bills/${t1.id}/invoice`).set(as(cashier)).send({});
    expect(whole.status, JSON.stringify(whole.body)).toBe(201);
    expect(InvoiceView.parse(whole.body)).toMatchObject({
      invoiceNumber: number(6),
      grandTotal: 69_600,
      replacesInvoiceId: c.id,
    });
  });
});
