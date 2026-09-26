import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, createServer } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  BillView,
  DayEndPreview,
  GstSummaryResponse,
  InvoiceRegisterResponse,
  ApiError,
  InvoiceView,
  ItemSalesResponse,
  type LoginResponse,
  OrderDrillDownResponse,
  PaymentModesResponse,
  PrintInvoiceResponse,
  ReportExportResponse,
  SalesSummaryResponse,
  ShiftReportResponse,
  SplitBillResponse,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import { addDays } from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
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
let today: string;
/**
 * The invoices' own (calendar) date. The register is kept by invoice date for GST, which is the
 * next calendar day when the test runs between midnight and the 04:00 business-day cut-off.
 */
let invoiceDay: string;
const invoices: Record<string, InvoiceView> = {};

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));
const line = (name: string, quantity = 1) => ({
  clientLineId: randomUUID(),
  itemId: id(name),
  quantity,
});

async function order(body: object, login = waiter): Promise<void> {
  const response = await server()
    .post('/api/v1/orders')
    .set(as(login))
    .send({ idempotencyKey: randomUUID(), ...body });
  expect(SubmitOrderResponse.parse(response.body).status).toBe('ACCEPTED');
}

async function bill(target: object): Promise<BillView> {
  return BillView.parse((await server().post('/api/v1/bills').set(as(cashier)).send(target)).body);
}

async function issue(billId: string): Promise<InvoiceView> {
  return InvoiceView.parse(
    (await server().post(`/api/v1/bills/${billId}/invoice`).set(as(cashier)).send({})).body,
  );
}

async function pay(invoice: InvoiceView, payment: object): Promise<void> {
  const response = await server()
    .post(`/api/v1/invoices/${invoice.id}/payments`)
    .set(as(cashier))
    .send({
      idempotencyKey: randomUUID(),
      payments: [{ amount: invoice.grandTotal, ...payment }],
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function openTable(label: string): Promise<string> {
  return TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${id(label)}/open`)
        .set(as(waiter))
        .send({ covers: 2 })
    ).body,
  ).id;
}

/**
 * A day with known totals:
 * - T1: 2 Paneer Tikka + 1 Water → 58,000 + tax 3,160 + round-off 40 = 61,200, paid in cash.
 * - T2: 3 Lassi split into three equal parts of 8,400, each paid by UPI.
 * - Takeaway: 1 Lassi billed, voided, billed again (8,400), paid by another mode.
 */
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
  const station = await prisma.station.create({
    data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
  });
  const group = async (name: string, rateBp: number, sacCode: string) =>
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
  const gst5 = await group('GST 5 %', 250, '996331');
  const gst18 = await group('GST 18 %', 900, '996332');
  ids.starters = (await prisma.category.create({ data: { ...base, name: 'Starters' } })).id;
  ids.drinks = (await prisma.category.create({ data: { ...base, name: 'Drinks' } })).id;
  for (const [name, price, taxGroupId, category] of [
    ['Paneer Tikka', 28_000, gst5, 'starters'],
    ['Lassi', 8_000, gst5, 'drinks'],
    ['Water', 2_000, gst18, 'drinks'],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: id(category),
          name,
          basePrice: price,
          taxGroupId,
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

  ids.shift = (
    (await server().post('/api/v1/shifts').set(as(cashier)).send({ openingFloat: 100_000 }))
      .body as { id: string }
  ).id;

  const t1 = await openTable('T1');
  await order({
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId: t1,
    lines: [line('Paneer Tikka', 2), line('Water')],
  });
  invoices.a = await issue((await bill({ tableSessionId: t1 })).id);
  await pay(invoices.a, { mode: 'CASH', tendered: 70_000 });

  const t2 = await openTable('T2');
  await order({
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId: t2,
    lines: [line('Lassi', 3)],
  });
  const parts = SplitBillResponse.parse(
    (
      await server()
        .post(`/api/v1/bills/${(await bill({ tableSessionId: t2 })).id}/split`)
        .set(as(cashier))
        .send({ mode: 'EQUAL', parts: 3 })
    ).body,
  ).invoices;
  for (const part of parts) await pay(part, { mode: 'UPI' });

  await order({ source: 'POS', orderType: 'TAKEAWAY', lines: [line('Lassi')] }, cashier);
  const takeaway = await prisma.order.findFirstOrThrow({ where: { orderType: 'TAKEAWAY' } });
  const takeawayBill = await bill({ orderId: takeaway.id });
  invoices.voided = await issue(takeawayBill.id);
  await server()
    .post(`/api/v1/invoices/${invoices.voided.id}/void`)
    .set(as(manager))
    .send({ reason: 'Wrong item' });
  invoices.reissued = await issue(takeawayBill.id);
  await pay(invoices.reissued, { mode: 'OTHER', otherModeName: 'Other' });

  today = DayEndPreview.parse(
    (await server().get('/api/v1/day-end').set(as(manager))).body,
  ).businessDate;
  invoiceDay = invoices.a.invoiceDate;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const report = (path: string, login = manager, from = today, to = today) =>
  server().get(`/api/v1/reports/${path}`).query({ from, to }).set(as(login));

describe('[RPT-001] sales summary', () => {
  it('totals the day exactly, by date and by hour, without the voided bill', async () => {
    const response = await report('sales');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const sales = SalesSummaryResponse.parse(response.body);
    const expected = {
      invoices: 5,
      grossSales: 90_000,
      discounts: 0,
      serviceCharge: 0,
      tax: 4_760,
      roundOff: 40,
      netSales: 94_800,
    };
    expect(sales.totals).toEqual(expected);
    expect(sales.byDay).toEqual([{ businessDate: today, ...expected }]);
    expect(sales.byHour.reduce((total, hour) => total + hour.netSales, 0)).toBe(94_800);
  });

  it('refuses a range backwards or longer than a year', async () => {
    expect((await report('sales', manager, today, addDays(today, -1))).status).toBe(400);
    expect((await report('sales', manager, addDays(today, -400), today)).status).toBe(400);
    expect((await server().get('/api/v1/reports/sales').set(as(manager))).status).toBe(400);
  });
});

describe('[RPT-002] item and category sales', () => {
  it('counts each dish once, even across equal parts, with its share of tax', async () => {
    const sales = ItemSalesResponse.parse((await report('items')).body);
    expect(sales.items).toEqual([
      expect.objectContaining({
        name: 'Paneer Tikka',
        quantity: 2,
        gross: 56_000,
        net: 56_000,
        tax: 2_800,
      }),
      expect.objectContaining({
        name: 'Lassi',
        quantity: 4,
        gross: 32_000,
        net: 32_000,
        tax: 1_600,
      }),
      expect.objectContaining({ name: 'Water', quantity: 1, gross: 2_000, net: 2_000, tax: 360 }),
    ]);
    expect(sales.categories).toEqual([
      expect.objectContaining({ category: 'Starters', quantity: 2, gross: 56_000, tax: 2_800 }),
      expect.objectContaining({ category: 'Drinks', quantity: 5, gross: 34_000, tax: 1_960 }),
    ]);
  });
});

describe('[RPT-005] payments and shifts', () => {
  it('adds up payments per mode', async () => {
    const payments = PaymentModesResponse.parse((await report('payments')).body);
    expect(payments.modes).toEqual([
      { mode: 'CASH', label: null, count: 1, amount: 61_200 },
      { mode: 'UPI', label: null, count: 3, amount: 25_200 },
      { mode: 'OTHER', label: 'Other', count: 1, amount: 8_400 },
    ]);
    expect(payments.total).toBe(94_800);
  });

  it('reports shifts with expected cash; a cashier sees only their own and no other report', async () => {
    const shifts = ShiftReportResponse.parse((await report('shifts')).body);
    expect(shifts.shifts).toEqual([
      expect.objectContaining({
        shiftId: id('shift'),
        staffId: kit.staff.CASHIER,
        status: 'OPEN',
        cashPayments: 61_200,
        expectedCash: 161_200,
        variance: null,
      }),
    ]);
    const own = ShiftReportResponse.parse((await report('shifts', cashier)).body);
    expect(own.shifts.map((shift) => shift.shiftId)).toEqual([id('shift')]);
    expect((await report('sales', cashier)).status).toBe(403);
    expect((await report('gst', waiter)).status).toBe(403);
  });
});

describe('[RPT-006] GST reports for the CA', () => {
  it('gives taxable value, CGST and SGST by SAC and rate', async () => {
    const gst = GstSummaryResponse.parse((await report('gst')).body);
    expect(gst.rows).toEqual([
      {
        sacCode: '996331',
        rateBp: 500,
        taxableValue: 88_000,
        components: { CGST: 2_200, SGST: 2_200 },
        taxTotal: 4_400,
      },
      {
        sacCode: '996332',
        rateBp: 1_800,
        taxableValue: 2_000,
        components: { CGST: 180, SGST: 180 },
        taxTotal: 360,
      },
    ]);
    expect(gst.totals).toEqual({
      taxableValue: 90_000,
      components: { CGST: 2_380, SGST: 2_380 },
      taxTotal: 4_760,
    });
  });

  it('lists every invoice number in sequence, the cancelled one included', async () => {
    const register = InvoiceRegisterResponse.parse(
      (await report('invoice-register', manager, invoiceDay, invoiceDay)).body,
    );
    expect(register.invoices.map((invoice) => [invoice.invoiceNumber, invoice.status])).toEqual([
      [invoices.a?.invoiceNumber, 'SETTLED'],
      [expect.stringMatching(/000002$/), 'SETTLED'],
      [expect.stringMatching(/000003$/), 'SETTLED'],
      [expect.stringMatching(/000004$/), 'SETTLED'],
      [invoices.voided?.invoiceNumber, 'VOIDED'],
      [invoices.reissued?.invoiceNumber, 'SETTLED'],
    ]);
    const voided = register.invoices[4];
    expect(voided).toMatchObject({ voidReason: 'Wrong item', grandTotal: 8_400 });
    expect(register.invoices[5]?.replacesInvoiceNumber).toBe(invoices.voided?.invoiceNumber);
    expect(register.invoices[0]).toMatchObject({ taxableValue: 58_000, taxTotal: 3_160 });
  });
});

describe('[RPT-017] CSV export', () => {
  const exportCsv = (body: object, login = manager) =>
    server().post('/api/v1/reports/exports').set(as(login)).send(body);

  it('stamps the file with restaurant, filters, generated by and at, and audits it', async () => {
    const response = await exportCsv({ report: 'SALES', from: today, to: today });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const file = ReportExportResponse.parse(response.body);
    expect(file.filename).toBe(`sales_${today}_${today}.csv`);
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    const restaurant = await prisma.restaurant.findUniqueOrThrow({
      where: { id: kit.restaurantId },
    });
    const managerName = (await prisma.staff.findUniqueOrThrow({ where: { id: kit.staff.MANAGER } }))
      .displayName;
    const lines = file.content.split('\r\n');
    expect(lines.slice(0, 5)).toEqual([
      'Sales summary',
      `Restaurant,${restaurant.displayName}`,
      `From,${today}`,
      `To,${today}`,
      `Generated by,${managerName}`,
    ]);
    expect(lines[5]).toMatch(/^Generated at,\d{2}-\d{2}-\d{4} \d{2}:\d{2} \(Asia\/Kolkata\)$/);
    expect(lines).toContain(
      'Business date,Invoices,Gross sales,Discounts,Service charge,Tax,Round off,Net sales',
    );
    expect(lines).toContain(`${today},5,900.00,0.00,0.00,47.60,0.40,948.00`);
    expect(lines).toContain('Total,5,900.00,0.00,0.00,47.60,0.40,948.00');

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'REPORT_EXPORTED' } });
    expect(audit).toMatchObject({
      actorId: kit.staff.MANAGER,
      deviceId: kit.deviceId,
      entityType: 'report',
    });
    expect(audit.after).toMatchObject({ report: 'SALES', format: 'CSV', from: today, to: today });
  });

  it('exports the GST summary and invoice register the CA needs, in rupees', async () => {
    const gst = ReportExportResponse.parse(
      (await exportCsv({ report: 'GST', from: today, to: today })).body,
    ).content.split('\r\n');
    expect(gst).toContain('SAC,Rate %,Taxable value,CGST,SGST,Tax total');
    expect(gst).toContain('996331,5.00,880.00,22.00,22.00,44.00');
    expect(gst).toContain('996332,18.00,20.00,1.80,1.80,3.60');
    expect(gst).toContain('Total,,900.00,23.80,23.80,47.60');

    const register = ReportExportResponse.parse(
      (await exportCsv({ report: 'INVOICE_REGISTER', from: invoiceDay, to: invoiceDay })).body,
    ).content;
    expect(register).toContain(`${invoices.voided?.invoiceNumber ?? ''},${invoiceDay},${today}`);
    expect(register).toContain(',VOIDED,');
    expect(register).toContain(',Wrong item,');

    for (const report of ['ITEMS', 'PAYMENTS'] as const) {
      const file = ReportExportResponse.parse(
        (await exportCsv({ report, from: today, to: today })).body,
      );
      expect(file.content).toContain(
        report === 'ITEMS' ? 'Starters,Paneer Tikka,2,' : 'CASH,,1,612.00',
      );
    }
    expect(await prisma.auditLog.count({ where: { action: 'REPORT_EXPORTED' } })).toBe(5);
  });

  it('lets a cashier export their own shift report and nothing else', async () => {
    const own = await exportCsv({ report: 'SHIFTS', from: today, to: today }, cashier);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const lines = ReportExportResponse.parse(own.body).content.split('\r\n');
    expect(lines.some((row) => row.startsWith('Shifts of,'))).toBe(true);
    expect(lines.find((row) => row.startsWith(today))).toContain(',OPEN,');
    expect(lines.find((row) => row.startsWith(today))).toContain(
      ',1000.00,612.00,0.00,0.00,1612.00,,',
    );

    const sales = await exportCsv({ report: 'SALES', from: today, to: today }, cashier);
    expect([sales.status, ApiError.parse(sales.body).code]).toEqual([403, 'FORBIDDEN']);
    expect((await exportCsv({ report: 'SALES', from: today, to: today }, waiter)).status).toBe(403);
    expect((await exportCsv({ report: 'SALES', from: today, to: addDays(today, -1) })).status).toBe(
      400,
    );
    expect((await exportCsv({ report: 'NOPE', from: today, to: today })).status).toBe(400);
  });
});

describe('[RPT-015] order drill-down', () => {
  const drillDown = (orderId: string, login = manager) =>
    server().get(`/api/v1/reports/orders/${orderId}`).set(as(login));

  it('shows who created, sent, billed, voided and settled a takeaway order', async () => {
    const takeaway = await prisma.order.findFirstOrThrow({ where: { orderType: 'TAKEAWAY' } });
    const response = await drillDown(takeaway.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const order = OrderDrillDownResponse.parse(response.body);
    expect(order).toMatchObject({
      orderId: takeaway.id,
      orderType: 'TAKEAWAY',
      source: 'POS',
      tableLabel: null,
      createdBy: { id: kit.staff.CASHIER },
      device: { id: kit.deviceId },
    });
    expect(order.takeawayToken).not.toBeNull();
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      name: 'Lassi',
      state: 'SENT',
      createdBy: { id: kit.staff.CASHIER },
    });
    expect(order.items[0]?.sentAt).not.toBeNull();
    expect(order.kots.map((kot) => [kot.kind, kot.station])).toEqual([['NEW', 'Kitchen']]);
    expect(order.history[0]).toMatchObject({
      event: 'SUBMITTED',
      toState: 'SENT',
      by: { id: kit.staff.CASHIER },
      device: { id: kit.deviceId },
    });
    const [voided, reissued] = order.invoices;
    expect(order.invoices).toHaveLength(2);
    expect(voided).toMatchObject({
      invoiceNumber: invoices.voided?.invoiceNumber,
      status: 'VOIDED',
      issuedBy: { id: kit.staff.CASHIER },
      voidedBy: { id: kit.staff.MANAGER },
      voidReason: 'Wrong item',
      settledBy: null,
    });
    expect(reissued).toMatchObject({
      invoiceNumber: invoices.reissued?.invoiceNumber,
      status: 'SETTLED',
      settledBy: { id: kit.staff.CASHIER },
    });
    expect(reissued?.settledAt).not.toBeNull();
    const actions = new Set(order.audit.map((entry) => entry.action));
    for (const action of ['ORDER_SUBMITTED', 'INVOICE_ISSUED', 'INVOICE_VOIDED', 'BILL_SETTLED']) {
      expect(actions.has(action), action).toBe(true);
    }
  });

  it('names who printed a table bill, and keeps other people out', async () => {
    const paper = createServer((socket) => {
      socket.resume();
      socket.on('end', () => socket.end());
    });
    paper.listen(0, '127.0.0.1');
    await once(paper, 'listening');
    const printer = await prisma.printer.create({
      data: {
        restaurantId: kit.restaurantId,
        name: 'Counter',
        connection: 'NETWORK',
        host: '127.0.0.1',
        port: (paper.address() as AddressInfo).port,
      },
    });
    await prisma.setting.create({
      data: { restaurantId: kit.restaurantId, key: 'bills.printerId', value: printer.id },
    });
    app.get(SettingsService).invalidate();
    const printed = await server()
      .post(`/api/v1/invoices/${invoices.a?.id ?? ''}/print`)
      .set(as(cashier))
      .send({});
    paper.close();
    expect(PrintInvoiceResponse.parse(printed.body).printed).toBe(true);

    const dineIn = await prisma.order.findFirstOrThrow({ where: { tableId: id('T1') } });
    const order = OrderDrillDownResponse.parse((await drillDown(dineIn.id)).body);
    expect(order).toMatchObject({ tableLabel: 'T1', createdBy: { id: kit.staff.WAITER } });
    expect(order.invoices).toHaveLength(1);
    expect(order.invoices[0]).toMatchObject({
      invoiceId: invoices.a?.id,
      printCount: 1,
      printedBy: { id: kit.staff.CASHIER },
      settledBy: { id: kit.staff.CASHIER },
    });

    expect((await drillDown(dineIn.id, cashier)).status).toBe(403);
    expect((await drillDown(dineIn.id, waiter)).status).toBe(403);
    const missing = await drillDown(randomUUID());
    expect([missing.status, ApiError.parse(missing.body).code]).toEqual([404, 'ORDER_NOT_FOUND']);
  });
});
