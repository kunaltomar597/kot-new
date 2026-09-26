import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BillView,
  InvoiceView,
  type LoginResponse,
  OverrideResponse,
  PrintInvoiceResponse,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import { calendarDateOf, financialYearOf, gstinCheckCharacter } from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateInvoiceSequence } from '../../src/database/numbering.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import {
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
  TEST_PINS,
} from '../helpers/auth-kit.js';
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
const GSTIN_BASE = '27AAPFU0939F1Z';
const CUSTOMER_GSTIN = `${GSTIN_BASE}${gstinCheckCharacter(GSTIN_BASE)}`;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  cashier = await signIn(app, kit, 'CASHIER');
  waiter = await signIn(app, kit, 'WAITER');
  const base = { restaurantId: kit.restaurantId };

  await prisma.restaurant.update({
    where: { id: kit.restaurantId },
    data: {
      displayName: 'Spice Route',
      legalName: 'Spice Route Foods LLP',
      gstin: '27AAAAA0000A1Z' + gstinCheckCharacter('27AAAAA0000A1Z'),
      stateCode: '27',
      fssaiNumber: '12345678901234',
      address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' },
    },
  });
  ids.inv = (
    await prisma.invoiceSeries.create({
      data: { ...base, name: 'Dine-in', prefix: 'INV', isDefault: true },
    })
  ).id;
  ids.ta = (
    await prisma.invoiceSeries.create({
      data: {
        ...base,
        name: 'Takeaway',
        prefix: 'TA',
        includeFinancialYear: false,
        separator: '-',
      },
    })
  ).id;

  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  const station = await prisma.station.create({
    data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
  });
  const taxGroup = async (name: string, rateBp: number, sacCode: string) =>
    (
      await prisma.taxGroup.create({
        data: {
          ...base,
          name,
          sacCode,
          components: {
            create: [
              { ...base, code: 'CGST', rateBp },
              { ...base, code: 'SGST', rateBp },
            ],
          },
        },
      })
    ).id;
  ids.gst5 = await taxGroup('GST 5 %', 250, '996331');
  ids.gst18 = await taxGroup('GST 18 %', 900, '996332');
  for (const [name, price, group] of [
    ['Paneer Tikka', 28_000, 'gst5'],
    ['Lassi', 8_000, 'gst5'],
    ['Water', 2_000, 'gst18'],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: id(group),
          foodType: 'VEG',
          stationId: station.id,
        },
      })
    ).id;
  }
  const published = await server().post('/api/v1/menu/publish').set(as(manager));
  expect(published.status, JSON.stringify(published.body)).toBe(200);
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

const line = (itemId: string, quantity = 1) => ({ clientLineId: randomUUID(), itemId, quantity });

async function openTable(label: string) {
  return TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${id(label)}/open`)
        .set(as(waiter))
        .send({ covers: 2 })
    ).body,
  );
}

async function submit(body: object, login = waiter) {
  const response = await server()
    .post('/api/v1/orders')
    .set(as(login))
    .send({ idempotencyKey: randomUUID(), ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const accepted = SubmitOrderResponse.parse(response.body);
  if (accepted.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return accepted.orderId;
}

async function takeawayBill(): Promise<BillView> {
  const orderId = await submit(
    { source: 'POS', orderType: 'TAKEAWAY', lines: [line(id('Lassi'))] },
    cashier,
  );
  return bill({ orderId });
}

async function bill(target: object, login = cashier): Promise<BillView> {
  const response = await server().post('/api/v1/bills').set(as(login)).send(target);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return BillView.parse(response.body);
}

async function override(capability: string) {
  return OverrideResponse.parse(
    (
      await server().post('/api/v1/auth/override').set(as(cashier)).send({
        approverStaffId: kit.staff.MANAGER,
        pin: TEST_PINS.MANAGER,
        capability,
      })
    ).body,
  ).overrideToken;
}

function discount(billId: string, body: object, headers: Record<string, string> = as(cashier)) {
  return server().post(`/api/v1/bills/${billId}/discounts`).set(headers).send(body);
}

function issue(billId: string, body: object = {}) {
  return server().post(`/api/v1/bills/${billId}/invoice`).set(as(cashier)).send(body);
}

let dineIn: BillView;
let session: TableSessionView;
const lineOf = (view: BillView, name: string) =>
  view.lines.find((candidate) => candidate.orderItemId === id(`item:${name}`));

describe('[BILL-001] [BILL-004] the bill of a table', () => {
  it('prices what was ordered on the server, with tax per group and round-off', async () => {
    session = await openTable('T1');
    const orderId = await submit({
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: [line(id('Paneer Tikka'), 2), line(id('Lassi')), line(id('Water'))],
    });
    for (const item of await prisma.orderItem.findMany({ where: { orderId } })) {
      ids[`item:${item.name}`] = item.id;
    }

    expect(
      (await server().post('/api/v1/bills').set(as(waiter)).send({ tableSessionId: session.id }))
        .status,
    ).toBe(403);
    dineIn = await bill({ tableSessionId: session.id });
    expect(dineIn).toMatchObject({
      status: 'OPEN',
      tableLabel: 'T1',
      priceMode: 'TAX_EXCLUSIVE',
      subtotal: 66_000,
      discountTotal: 0,
      taxTotal: 3_560,
      roundOff: 40,
      grandTotal: 69_600,
      serviceCharge: { enabled: false, removed: false, amount: 0 },
    });
    expect(lineOf(dineIn, 'Paneer Tikka')).toMatchObject({
      description: 'Paneer Tikka',
      quantity: 2,
      unitPrice: 28_000,
      grossAmount: 56_000,
    });
    expect(dineIn.taxLines).toEqual([
      {
        taxGroupId: id('gst5'),
        name: 'GST 5 %',
        source: 'ITEMS',
        taxableValue: 64_000,
        components: [
          { code: 'CGST', rateBp: 250, amount: 1_600 },
          { code: 'SGST', rateBp: 250, amount: 1_600 },
        ],
        taxTotal: 3_200,
      },
      {
        taxGroupId: id('gst18'),
        name: 'GST 18 %',
        source: 'ITEMS',
        taxableValue: 2_000,
        components: [
          { code: 'CGST', rateBp: 900, amount: 180 },
          { code: 'SGST', rateBp: 900, amount: 180 },
        ],
        taxTotal: 360,
      },
    ]);
    // Opening again returns the same bill.
    expect((await bill({ tableSessionId: session.id })).id).toBe(dineIn.id);
  });
});

describe('[BILL-005] discounts', () => {
  it('lets a cashier give a bill discount within the limit, with a reason, audited', async () => {
    const noReason = await discount(dineIn.id, { kind: 'PERCENT', rateBp: 1_000 });
    expect(noReason.status).toBe(400);
    const byWaiter = await discount(
      dineIn.id,
      { kind: 'PERCENT', rateBp: 1_000, reason: 'Regular guest' },
      as(waiter),
    );
    expect(byWaiter.status).toBe(403);

    const given = await discount(dineIn.id, {
      kind: 'PERCENT',
      rateBp: 1_000,
      reason: 'Regular guest',
    });
    expect(given.status, JSON.stringify(given.body)).toBe(200);
    const view = BillView.parse(given.body);
    expect(view).toMatchObject({ discountTotal: 6_600, taxTotal: 3_204, grandTotal: 62_600 });
    expect(view.discounts).toEqual([
      expect.objectContaining({
        orderItemId: null,
        kind: 'PERCENT',
        rateBp: 1_000,
        amount: 6_600,
        reason: 'Regular guest',
        approvedById: null,
      }),
    ]);
    expect(lineOf(view, 'Paneer Tikka')?.billDiscountShare).toBe(5_600);

    const second = await discount(dineIn.id, { kind: 'FLAT', amount: 100, reason: 'Again' });
    expect([second.status, codeOf(second)]).toEqual([409, 'DISCOUNT_EXISTS']);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'DISCOUNT_APPLIED' } });
    expect(audit).toMatchObject({ entityId: dineIn.id, reason: 'Regular guest' });
  });

  it('needs a manager PIN above the cashier limit and for a complimentary item', async () => {
    const water = id('item:Water');
    const tooMuch = await discount(dineIn.id, {
      orderItemId: water,
      kind: 'PERCENT',
      rateBp: 1_500,
      reason: 'Warm bottle',
    });
    expect([tooMuch.status, codeOf(tooMuch)]).toEqual([403, 'OVERRIDE_REQUIRED']);

    const lassi = id('item:Lassi');
    const withoutPin = await discount(dineIn.id, {
      orderItemId: lassi,
      kind: 'PERCENT',
      rateBp: 10_000,
      reason: 'Birthday',
    });
    expect([withoutPin.status, codeOf(withoutPin)]).toEqual([403, 'OVERRIDE_REQUIRED']);
    const token = await override('DISCOUNT_ABOVE_LIMIT');
    const comp = await discount(
      dineIn.id,
      { orderItemId: lassi, kind: 'PERCENT', rateBp: 10_000, reason: 'Birthday' },
      { ...as(cashier), 'x-override-token': token },
    );
    expect(comp.status, JSON.stringify(comp.body)).toBe(200);
    const view = BillView.parse(comp.body);
    expect(lineOf(view, 'Lassi')).toMatchObject({ complimentary: true, itemDiscount: 8_000 });
    // 10 % of what is left after the complimentary Lassi.
    expect(view).toMatchObject({ discountTotal: 13_800, grandTotal: 55_000, roundOff: -44 });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ITEM_COMPLIMENTARY' },
    });
    expect(audit).toMatchObject({ approverId: kit.staff.MANAGER, reason: 'Birthday' });

    // The token was used up.
    const reused = await discount(
      dineIn.id,
      { orderItemId: water, kind: 'PERCENT', rateBp: 1_500, reason: 'Warm bottle' },
      { ...as(cashier), 'x-override-token': token },
    );
    expect([reused.status, codeOf(reused)]).toEqual([403, 'OVERRIDE_INVALID']);
    // A manager needs no approval.
    const byManager = await discount(
      dineIn.id,
      { orderItemId: water, kind: 'FLAT', amount: 2_500, reason: 'Warm bottle' },
      as(manager),
    );
    expect([byManager.status, codeOf(byManager)]).toEqual([422, 'DISCOUNT_EXCEEDS_AMOUNT']);
  });

  it('takes a discount back before printing, audited', async () => {
    const billDiscount = (await bill({ tableSessionId: session.id })).discounts.find(
      (candidate) => candidate.orderItemId === null,
    );
    const revoked = await server()
      .post(`/api/v1/bills/${dineIn.id}/discounts/${billDiscount?.id ?? ''}/revoke`)
      .set(as(cashier))
      .send({ reason: 'Guest paid full' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const view = BillView.parse(revoked.body);
    expect(view.discounts.map((entry) => entry.orderItemId)).toEqual([id('item:Lassi')]);
    expect(view).toMatchObject({ discountTotal: 8_000, taxTotal: 3_160, grandTotal: 61_200 });
    const row = await prisma.discount.findUniqueOrThrow({ where: { id: billDiscount?.id ?? '' } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedById).toBe(kit.staff.CASHIER);
  });
});

describe('[BILL-006] the voluntary service charge', () => {
  it('is added when turned on, taxed, and removed at the diner’s request, audited', async () => {
    await prisma.setting.create({
      data: { restaurantId: kit.restaurantId, key: 'billing.serviceChargeEnabled', value: true },
    });
    app.get(SettingsService).invalidate();
    const withCharge = await bill({ tableSessionId: session.id });
    expect(withCharge.serviceCharge).toEqual({
      enabled: true,
      removed: false,
      rateBp: 500,
      amount: 2_900,
    });
    expect(withCharge.taxLines.at(-1)).toMatchObject({
      source: 'SERVICE_CHARGE',
      taxGroupId: id('gst5'),
      taxableValue: 2_900,
      // 72.5 paise per component rounds half up (ADR-0003).
      taxTotal: 146,
    });

    const removed = await server()
      .post(`/api/v1/bills/${dineIn.id}/service-charge`)
      .set(as(cashier))
      .send({ removed: true, reason: 'Guest asked' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(BillView.parse(removed.body)).toMatchObject({
      serviceCharge: { enabled: true, removed: true, amount: 0 },
      grandTotal: 61_200,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'SERVICE_CHARGE_REMOVED' },
    });
    expect(audit).toMatchObject({ entityId: dineIn.id, reason: 'Guest asked' });
    expect(audit.before).toMatchObject({ serviceCharge: 2_900 });
  });
});

describe('[BILL-011] customer details', () => {
  it('keeps a phone number only with consent', async () => {
    const put = (body: object) =>
      server().put(`/api/v1/bills/${dineIn.id}/customer`).set(as(cashier)).send(body);
    const noConsent = await put({
      name: 'Asha',
      phone: '98765 43210',
      phoneConsent: false,
      gstin: null,
    });
    expect(noConsent.status).toBe(400);
    const badGstin = await put({ name: 'Asha', phone: null, phoneConsent: false, gstin: '27ABC' });
    expect(badGstin.status).toBe(400);
    const saved = await put({
      name: 'Asha',
      phone: '98765 43210',
      phoneConsent: true,
      gstin: CUSTOMER_GSTIN,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(BillView.parse(saved.body).customer).toEqual({
      name: 'Asha',
      phone: '98765 43210',
      phoneConsent: true,
      gstin: CUSTOMER_GSTIN,
    });
  });
});

describe('[BILL-002] [BILL-003] printing: the GST invoice', () => {
  let invoice: InvoiceView;

  it('issues the invoice with the next number, the particulars and the tax breakdown', async () => {
    const issued = await issue(dineIn.id);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    invoice = InvoiceView.parse(issued.body);
    expect(invoice).toMatchObject({
      invoiceNumber: `INV/${FY.shortLabel}/000001`,
      status: 'ISSUED',
      financialYear: FY.label,
      tableLabel: 'T1',
      subtotal: 66_000,
      discountTotal: 8_000,
      serviceCharge: 0,
      taxTotal: 3_160,
      roundOff: 40,
      grandTotal: 61_200,
      printCount: 0,
      particulars: {
        displayName: 'Spice Route',
        legalName: 'Spice Route Foods LLP',
        fssaiNumber: '12345678901234',
        placeOfSupply: '27',
        address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' },
      },
      customer: { name: 'Asha', gstin: CUSTOMER_GSTIN, phoneConsent: true },
    });
    expect(invoice.lines).toEqual([
      expect.objectContaining({
        description: 'Paneer Tikka',
        lineTotal: 56_000,
        sacCode: '996331',
      }),
      expect.objectContaining({ description: 'Lassi', discount: 8_000, taxableValue: 0 }),
      expect.objectContaining({ description: 'Water', taxableValue: 2_000, sacCode: '996332' }),
    ]);
    expect(invoice.taxLines.map((tax) => [tax.code, tax.rateBp, tax.amount])).toEqual([
      ['CGST', 250, 1_400],
      ['SGST', 250, 1_400],
      ['CGST', 900, 180],
      ['SGST', 900, 180],
    ]);

    // The table waits for payment; the bill is closed to changes; everything is recorded.
    const table = await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } });
    expect(table.state).toBe('BILL_PRINTED');
    expect(
      BillView.parse((await server().get(`/api/v1/bills/${dineIn.id}`).set(as(cashier))).body),
    ).toMatchObject({
      status: 'INVOICED',
      invoiceIds: [invoice.id],
    });
    const discountRow = await prisma.discount.findFirstOrThrow({
      where: { billId: dineIn.id, revokedAt: null },
    });
    expect(discountRow).toMatchObject({ invoiceId: invoice.id, amount: 8_000 });
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'BillPrinted' },
    });
    expect((event.payload as { payload: unknown }).payload).toEqual({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      grandTotal: 61_200,
      duplicate: false,
    });
    expect(
      await prisma.auditLog.count({ where: { action: 'INVOICE_ISSUED', entityId: invoice.id } }),
    ).toBe(1);

    const again = await issue(dineIn.id);
    expect([again.status, codeOf(again)]).toEqual([409, 'BILL_ALREADY_PRINTED']);
    const late = await discount(dineIn.id, { kind: 'FLAT', amount: 100, reason: 'Late' });
    expect([late.status, codeOf(late)]).toEqual([409, 'BILL_ALREADY_PRINTED']);

    const fetched = await server().get(`/api/v1/invoices/${invoice.id}`).set(as(cashier));
    expect(InvoiceView.parse(fetched.body)).toEqual(invoice);
  });

  it('keeps an issued invoice as it was when the restaurant profile changes', async () => {
    await prisma.restaurant.update({
      where: { id: kit.restaurantId },
      data: { legalName: 'Renamed LLP' },
    });
    const fetched = InvoiceView.parse(
      (await server().get(`/api/v1/invoices/${invoice.id}`).set(as(cashier))).body,
    );
    expect(fetched.particulars.legalName).toBe('Spice Route Foods LLP');
  });

  it('refuses a bill with nothing on it', async () => {
    const empty = await bill({ tableSessionId: (await openTable('T2')).id });
    const refused = await issue(empty.id);
    expect([refused.status, codeOf(refused)]).toEqual([409, 'NOTHING_TO_BILL']);
  });

  it('bills a takeaway order on its own, in the series chosen', async () => {
    const takeaway = await takeawayBill();
    expect(takeaway).toMatchObject({ tableLabel: null, subtotal: 8_000, grandTotal: 8_400 });
    const issued = InvoiceView.parse((await issue(takeaway.id, { seriesId: id('ta') })).body);
    // A series without the year runs on: TA-000001, TA-000002, ...
    expect(issued.invoiceNumber).toBe('TA-000001');

    const dineInOrder = await prisma.order.findFirstOrThrow({ where: { orderType: 'DINE_IN' } });
    const refused = await server()
      .post('/api/v1/bills')
      .set(as(cashier))
      .send({ orderId: dineInOrder.id });
    expect([refused.status, codeOf(refused)]).toEqual([404, 'ORDER_NOT_FOUND']);
  });

  it('numbers invoices consecutively under concurrency and after a rollback', async () => {
    const bills = await Promise.all([1, 2, 3, 4, 5].map(() => takeawayBill()));
    const issued = await Promise.all(bills.map((entry) => issue(entry.id)));
    const numbers = issued.map((response) => InvoiceView.parse(response.body).invoiceNumber).sort();
    expect(numbers).toEqual(
      [2, 3, 4, 5, 6].map((n) => `INV/${FY.shortLabel}/${String(n).padStart(6, '0')}`),
    );

    // A transaction that took a number and failed gives it back.
    await expect(
      prisma.transaction(async (tx) => {
        await allocateInvoiceSequence(tx, {
          restaurantId: kit.restaurantId,
          seriesId: id('inv'),
          financialYear: FY.label,
        });
        throw new Error('printer on fire');
      }),
    ).rejects.toThrow('printer on fire');
    const next = InvoiceView.parse((await issue((await takeawayBill()).id)).body);
    expect(next.invoiceNumber).toBe(`INV/${FY.shortLabel}/000007`);
  });
});

describe('[BILL-014] [BILL-009] printing the bill', () => {
  const jobs: string[] = [];
  let paper: Server;
  let port = 0;
  let invoiceId: string;

  const listen = async () => {
    paper = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => {
        jobs.push(Buffer.concat(chunks).toString('latin1'));
        socket.end();
      });
    });
    paper.listen(port, '127.0.0.1');
    await once(paper, 'listening');
    port = (paper.address() as AddressInfo).port;
  };
  const print = (login = cashier) =>
    server().post(`/api/v1/invoices/${invoiceId}/print`).set(as(login)).send({});

  beforeAll(async () => {
    await listen();
    invoiceId = (await prisma.invoice.findFirstOrThrow({ where: { billId: dineIn.id } })).id;
  });

  afterAll(() => {
    paper.close();
  });

  it('prints the original on the bill printer, then marks every reprint DUPLICATE', async () => {
    const unset = await print();
    expect([unset.status, codeOf(unset)]).toEqual([422, 'NO_BILL_PRINTER']);

    const printer = await prisma.printer.create({
      data: {
        restaurantId: kit.restaurantId,
        name: 'Counter',
        connection: 'NETWORK',
        host: '127.0.0.1',
        port,
      },
    });
    ids.billPrinter = printer.id;
    await prisma.setting.create({
      data: { restaurantId: kit.restaurantId, key: 'bills.printerId', value: printer.id },
    });
    app.get(SettingsService).invalidate();
    expect((await print(waiter)).status).toBe(403);

    const first = await print();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(PrintInvoiceResponse.parse(first.body)).toEqual({
      printed: true,
      error: null,
      duplicate: false,
      printCount: 1,
    });
    const original = jobs.at(-1) ?? '';
    expect(original).toContain('Spice Route');
    expect(original).toContain('TAX INVOICE');
    expect(original).toContain(`No: INV/${FY.shortLabel}/000001`);
    expect(original).toContain('Table T1');
    expect(original).toContain('Customer GSTIN: ' + CUSTOMER_GSTIN);
    expect(original).toContain('CGST @ 2.5% on 560.00');
    expect(original).toContain('612.00');
    expect(original).toContain('SAC: 996331, 996332');
    expect(original).not.toContain('DUPLICATE');
    expect(await prisma.auditLog.count({ where: { action: 'INVOICE_REPRINTED' } })).toBe(0);

    const again = PrintInvoiceResponse.parse((await print()).body);
    expect(again).toMatchObject({ printed: true, duplicate: true, printCount: 2 });
    expect(jobs.at(-1)).toContain('DUPLICATE');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'INVOICE_REPRINTED' },
    });
    expect(audit).toMatchObject({ entityId: invoiceId, actorId: kit.staff.CASHIER });
    const events = await prisma.outboxEvent.findMany({ where: { eventType: 'BillPrinted' } });
    expect(
      events.some((row) => (row.payload as { payload: { duplicate: boolean } }).payload.duplicate),
    ).toBe(true);
  });

  it('answers in plain words when the bill printer is off, and does not count the print', async () => {
    paper.close();
    await once(paper, 'close');
    const failed = PrintInvoiceResponse.parse((await print()).body);
    expect(failed).toMatchObject({ printed: false, duplicate: true, printCount: 2 });
    expect(failed.error).toContain('refused the connection');
    const printer = await prisma.printer.findUniqueOrThrow({ where: { id: id('billPrinter') } });
    expect(printer.offlineSince).not.toBeNull();
    await listen();
  });
});

describe('[BILL-010] [BILL-003] void and re-issue', () => {
  let voided: InvoiceView;

  it('voids with a manager PIN; the number stays in the series and the table waits again', async () => {
    const original = await prisma.invoice.findFirstOrThrow({ where: { billId: dineIn.id } });
    const voidIt = (headers: Record<string, string>) =>
      server()
        .post(`/api/v1/invoices/${original.id}/void`)
        .set(headers)
        .send({ reason: 'Wrong table billed' });

    const withoutPin = await voidIt(as(cashier));
    expect([withoutPin.status, codeOf(withoutPin)]).toEqual([403, 'OVERRIDE_REQUIRED']);
    const token = await override('INVOICE_VOID');
    const done = await voidIt({ ...as(cashier), 'x-override-token': token });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    voided = InvoiceView.parse(done.body);
    expect(voided).toMatchObject({
      status: 'VOIDED',
      voidReason: 'Wrong table billed',
      invoiceNumber: `INV/${FY.shortLabel}/000001`,
      grandTotal: 61_200,
    });
    expect(voided.voidedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'INVOICE_VOIDED' } });
    expect(audit).toMatchObject({
      entityId: original.id,
      actorId: kit.staff.CASHIER,
      approverId: kit.staff.MANAGER,
      reason: 'Wrong table billed',
    });
    const table = await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } });
    expect(table.state).toBe('OCCUPIED');
    expect((await bill({ tableSessionId: session.id })).status).toBe('OPEN');

    const twice = await server()
      .post(`/api/v1/invoices/${original.id}/void`)
      .set(as(manager))
      .send({ reason: 'Again' });
    expect([twice.status, codeOf(twice)]).toEqual([409, 'INVOICE_ALREADY_VOIDED']);
    const reprint = await server()
      .post(`/api/v1/invoices/${original.id}/print`)
      .set(as(cashier))
      .send({});
    expect([reprint.status, codeOf(reprint)]).toEqual([409, 'INVOICE_VOIDED']);

    // Its amounts are frozen in the database, whatever the application does.
    await expect(
      prisma.invoice.update({ where: { id: original.id }, data: { grandTotal: 1 } }),
    ).rejects.toThrow();
  });

  it('issues the corrected bill with a new number that points back at the voided one', async () => {
    const reissued = await issue(dineIn.id);
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(201);
    const invoice = InvoiceView.parse(reissued.body);
    expect(invoice).toMatchObject({
      invoiceNumber: `INV/${FY.shortLabel}/000008`,
      status: 'ISSUED',
      replacesInvoiceId: voided.id,
      grandTotal: 61_200,
      printCount: 0,
    });
    expect((await bill({ tableSessionId: session.id })).invoiceIds).toEqual([
      voided.id,
      invoice.id,
    ]);
    const table = await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } });
    expect(table.state).toBe('BILL_PRINTED');

    // The register keeps every number, the voided one included (RPT-006).
    const register = await prisma.invoice.findMany({
      where: { seriesId: id('inv') },
      orderBy: { sequence: 'asc' },
      select: { sequence: true, status: true },
    });
    expect(register.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(register[0]?.status).toBe('VOIDED');
  });
});

describe('[BILL-010] editing a printed bill', () => {
  let edited: InvoiceView;

  it('reopens a printed bill with a manager PIN when items are added after printing', async () => {
    const printed = await prisma.invoice.findFirstOrThrow({
      where: { billId: dineIn.id, status: 'ISSUED' },
    });
    const orderId = await submit({
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: [line(id('Water'))],
    });
    expect(orderId).toBeTruthy();
    const refused = await issue(dineIn.id);
    expect([refused.status, codeOf(refused)]).toEqual([409, 'BILL_ALREADY_PRINTED']);

    const reopen = (headers: Record<string, string>) =>
      server()
        .post(`/api/v1/invoices/${printed.id}/reopen`)
        .set(headers)
        .send({ reason: 'Guest ordered another water' });
    const withoutPin = await reopen(as(cashier));
    expect([withoutPin.status, codeOf(withoutPin)]).toEqual([403, 'OVERRIDE_REQUIRED']);
    const token = await override('BILL_EDIT_AFTER_PRINT');
    const opened = await reopen({ ...as(cashier), 'x-override-token': token });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const view = BillView.parse(opened.body);
    expect(view).toMatchObject({ status: 'OPEN', editingInvoiceId: printed.id });
    expect(view.lines).toHaveLength(4);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'INVOICE_REOPENED' } });
    expect(audit).toMatchObject({
      entityId: printed.id,
      approverId: kit.staff.MANAGER,
      reason: 'Guest ordered another water',
    });
    const again = await reopen(as(manager));
    expect([again.status, codeOf(again)]).toEqual([409, 'BILL_ALREADY_OPEN']);
  });

  it('prints the edited bill under the same number, audited with before and after', async () => {
    const before = await prisma.invoice.findFirstOrThrow({
      where: { billId: dineIn.id, status: 'ISSUED' },
    });
    const reissued = await issue(dineIn.id);
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(201);
    edited = InvoiceView.parse(reissued.body);
    expect(edited).toMatchObject({
      id: before.id,
      invoiceNumber: before.invoiceNumber,
      version: 2,
      printCount: 0,
      grandTotal: 63_500,
      roundOff: -20,
      taxTotal: 3_520,
    });
    expect(edited.lines).toHaveLength(4);
    // Both versions' lines stay in the database; the view shows the current one.
    expect(await prisma.invoiceLine.count({ where: { invoiceId: before.id } })).toBe(7);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'INVOICE_EDITED' } });
    expect(audit).toMatchObject({
      entityId: before.id,
      actorId: kit.staff.CASHIER,
      approverId: kit.staff.MANAGER,
      reason: 'Guest ordered another water',
    });
    expect(audit.before).toMatchObject({ version: 1, grandTotal: 61_200 });
    expect(audit.after).toMatchObject({ version: 2, grandTotal: 63_500 });

    // No number was used for the edit, and the bill and table are printed again.
    expect(await prisma.invoice.count({ where: { seriesId: id('inv') } })).toBe(8);
    expect((await bill({ tableSessionId: session.id })).editingInvoiceId).toBeNull();
    const table = await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } });
    expect(table.state).toBe('BILL_PRINTED');
  });

  it('refuses to reopen a settled bill: it must be voided and issued again', async () => {
    await prisma.invoice.update({ where: { id: edited.id }, data: { status: 'SETTLED' } });
    const refused = await server()
      .post(`/api/v1/invoices/${edited.id}/reopen`)
      .set(as(manager))
      .send({ reason: 'Too late' });
    expect([refused.status, codeOf(refused)]).toEqual([409, 'INVOICE_SETTLED']);
  });
});
