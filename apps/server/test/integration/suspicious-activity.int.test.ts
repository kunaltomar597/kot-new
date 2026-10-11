import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  AlertListResponse,
  ApiError,
  BillView,
  CurrentShiftResponse,
  DayEndPreview,
  InvoicePaymentsView,
  InvoiceView,
  type LoginResponse,
  OpenCashDrawerResponse,
  OverrideResponse,
  PrintInvoiceResponse,
  ReportExportResponse,
  ShiftView,
  SubmitOrderResponse,
  SuspiciousActivityResponse,
  type SuspiciousFlag,
  type SuspiciousKind,
  TableSessionView,
} from '@rp/contracts';
import { type Capability, OVERRIDE_RECORD_TYPES } from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SuspiciousActivityJob } from '../../src/reports/suspicious-activity.job.js';
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
import { until } from '../helpers/wait.js';

/**
 * S12 (P4-07b, RPT-014, AUD-006): fraud patterns on one day, each found with the right person.
 * - T1 (waiter): 2 Paneer Tikka, a Water and a Lassi; the kitchen starts the Water. The cashier
 *   prints the bill, reopens it (manager's PIN), voids the Water (manager's PIN) and issues the
 *   bill again under its number, then prints it (an original again) and twice more. The waiter reprints the kitchen
 *   ticket twice and the manager once. Paid in cash: the drawer opens.
 * - T2 (waiter): 2 Lassi with 30 % off the bill (cashier, manager's PIN). Paid by UPI.
 * - Takeaway A (cashier): a Lassi, billed and printed, voided by the manager, billed again.
 * - Takeaway B (cashier): a Water sent to the kitchen and never billed.
 * - The cashier opens the drawer without a sale, and closes the shift ₹500 short.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let cashier: LoginResponse;
let waiter: LoginResponse;
let kitchen: LoginResponse;
let printerServer: Server;
let today: string;
const jobs: Buffer[] = [];
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';
const invoices: Record<string, InvoiceView> = {};

const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
const kicks = () => jobs.filter((job) => job.equals(DRAWER_KICK)).length;

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const line = (name: string, quantity = 1) => ({
  clientLineId: randomUUID(),
  itemId: id(name),
  quantity,
});

async function order(body: object, login = waiter): Promise<string> {
  const response = await server()
    .post('/api/v1/orders')
    .set(as(login))
    .send({ idempotencyKey: randomUUID(), ...body });
  const placed = SubmitOrderResponse.parse(response.body);
  if (placed.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return placed.orderId;
}

async function itemOf(orderId: string, name: string): Promise<string> {
  return (await prisma.orderItem.findFirstOrThrow({ where: { orderId, name } })).id;
}

async function bill(target: object): Promise<BillView> {
  const response = await server().post('/api/v1/bills').set(as(cashier)).send(target);
  return BillView.parse(response.body);
}

async function issue(billId: string): Promise<InvoiceView> {
  const response = await server().post(`/api/v1/bills/${billId}/invoice`).set(as(cashier)).send({});
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return InvoiceView.parse(response.body);
}

async function print(invoiceId: string): Promise<void> {
  const printed = await server()
    .post(`/api/v1/invoices/${invoiceId}/print`)
    .set(as(cashier))
    .send({});
  expect(PrintInvoiceResponse.parse(printed.body).printed).toBe(true);
}

async function pay(invoice: InvoiceView, mode: 'CASH' | 'UPI'): Promise<InvoicePaymentsView> {
  const response = await server()
    .post(`/api/v1/invoices/${invoice.id}/payments`)
    .set(as(cashier))
    .send({ idempotencyKey: randomUUID(), payments: [{ mode, amount: invoice.grandTotal }] });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return InvoicePaymentsView.parse(response.body);
}

async function overrideToken(capability: Capability, entityId: string): Promise<string> {
  return OverrideResponse.parse(
    (
      await server().post('/api/v1/auth/override').set(as(cashier)).send({
        approverStaffId: kit.staff.MANAGER,
        pin: TEST_PINS.MANAGER,
        capability,
        entityType: OVERRIDE_RECORD_TYPES[capability],
        entityId,
      })
    ).body,
  ).overrideToken;
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

async function report(): Promise<SuspiciousActivityResponse> {
  const response = await server()
    .get('/api/v1/reports/suspicious')
    .query({ from: today, to: today })
    .set(as(manager));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return SuspiciousActivityResponse.parse(response.body);
}

const flagsOf = (result: SuspiciousActivityResponse, kind: SuspiciousKind): SuspiciousFlag[] =>
  result.flags.filter((flag) => flag.kind === kind);
const countOf = (result: SuspiciousActivityResponse, kind: SuspiciousKind) =>
  result.totals.find((total) => total.kind === kind)?.count;

async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { restaurantId_key: { restaurantId: kit.restaurantId, key } },
    create: { restaurantId: kit.restaurantId, key, value: value as never },
    update: { value: value as never },
  });
  app.get(SettingsService).invalidate();
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  cashier = await signIn(app, kit, 'CASHIER');
  waiter = await signIn(app, kit, 'WAITER');
  kitchen = await signIn(app, kit, 'KITCHEN');
  const base = { restaurantId: kit.restaurantId };
  await prisma.invoiceSeries.create({
    data: { ...base, name: 'Main', prefix: 'INV', isDefault: true },
  });
  printerServer = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      jobs.push(Buffer.concat(chunks));
      socket.end();
    });
  });
  printerServer.listen(0, '127.0.0.1');
  await once(printerServer, 'listening');
  const printer = await prisma.printer.create({
    data: {
      ...base,
      name: 'Counter',
      connection: 'NETWORK',
      host: '127.0.0.1',
      port: (printerServer.address() as AddressInfo).port,
    },
  });
  ids.printer = printer.id;
  await setSetting('bills.printerId', printer.id);
  const station = await prisma.station.create({
    data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
  });
  const taxGroup = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      sacCode: '996331',
      components: {
        create: [
          { ...base, code: 'CGST', rateBp: 250 },
          { ...base, code: 'SGST', rateBp: 250 },
        ],
      },
    },
  });
  const category = (await prisma.category.create({ data: { ...base, name: 'Menu' } })).id;
  for (const [name, price] of [
    ['Paneer Tikka', 28_000],
    ['Lassi', 8_000],
    ['Water', 2_000],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category,
          name,
          basePrice: price,
          taxGroupId: taxGroup.id,
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
  const shift = await server().post('/api/v1/shifts').set(as(cashier)).send({ openingFloat: 0 });
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);
  ids.shift = ShiftView.parse(shift.body).id;

  // T1: void after print, a cooked void, an edit after print and repeated reprints.
  const t1 = await openTable('T1');
  ids.t1Order = await order({
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId: t1,
    lines: [line('Paneer Tikka', 2), line('Water'), line('Lassi')],
  });
  const water = await itemOf(ids.t1Order, 'Water');
  ids.t1Water = water;
  await server()
    .post(`/api/v1/order-items/${water}/status`)
    .set(as(kitchen))
    .send({ event: 'START_PREPARING' });
  const t1Bill = await bill({ tableSessionId: t1 });
  invoices.t1 = await issue(t1Bill.id);
  await print(invoices.t1.id);
  const editToken = await overrideToken('BILL_EDIT_AFTER_PRINT', invoices.t1.id);
  const reopened = await server()
    .post(`/api/v1/invoices/${invoices.t1.id}/reopen`)
    .set({ ...as(cashier), 'x-override-token': editToken })
    .send({ reason: 'Guest sent the water back' });
  expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
  const voidToken = await overrideToken('ITEM_VOID_AFTER_PREP', water);
  const voided = await server()
    .post(`/api/v1/order-items/${water}/void`)
    .set({ ...as(cashier), 'x-override-token': voidToken })
    .send({ reason: 'Spilled' });
  expect(voided.status, JSON.stringify(voided.body)).toBe(200);
  invoices.t1Edited = await issue(t1Bill.id);
  // The edited bill prints as an original, then twice more.
  for (let copy = 0; copy < 3; copy += 1) await print(invoices.t1.id);
  const kot = await prisma.kot.findFirstOrThrow({ where: { orderId: ids.t1Order } });
  ids.kot = kot.id;
  for (const [login, reason] of [
    [waiter, 'Paper jam'],
    [waiter, 'Smudged'],
    [manager, 'Chef asked'],
  ] as const) {
    const reprinted = await server()
      .post(`/api/v1/kots/${kot.id}/reprint`)
      .set(as(login))
      .send({ printerId: printer.id, reason });
    expect(reprinted.status, JSON.stringify(reprinted.body)).toBe(200);
  }
  const before = kicks();
  await pay(invoices.t1Edited, 'CASH');
  await until(() => kicks() > before, 5_000, 'the drawer kick after a cash payment');

  // T2: a discount above the threshold.
  const t2 = await openTable('T2');
  await order({
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId: t2,
    lines: [line('Lassi', 2)],
  });
  const t2Bill = await bill({ tableSessionId: t2 });
  const discountToken = await overrideToken('DISCOUNT_ABOVE_LIMIT', t2Bill.id);
  const discounted = await server()
    .post(`/api/v1/bills/${t2Bill.id}/discounts`)
    .set({ ...as(cashier), 'x-override-token': discountToken })
    .send({ kind: 'PERCENT', rateBp: 3_000, reason: 'Friend of the owner' });
  expect(discounted.status, JSON.stringify(discounted.body)).toBe(200);
  invoices.t2 = await issue(t2Bill.id);
  await pay(invoices.t2, 'UPI');

  // Takeaway A: a printed bill voided by the manager, then billed again.
  const takeawayA = await order(
    { source: 'POS', orderType: 'TAKEAWAY', lines: [line('Lassi')] },
    cashier,
  );
  const takeawayBill = await bill({ orderId: takeawayA });
  invoices.voided = await issue(takeawayBill.id);
  await print(invoices.voided.id);
  const voidedBill = await server()
    .post(`/api/v1/invoices/${invoices.voided.id}/void`)
    .set(as(manager))
    .send({ reason: 'Wrong item' });
  expect(voidedBill.status, JSON.stringify(voidedBill.body)).toBe(200);
  invoices.reissued = await issue(takeawayBill.id);
  await pay(invoices.reissued, 'UPI');

  // Takeaway B: sent to the kitchen, never billed.
  ids.unbilled = await order(
    { source: 'POS', orderType: 'TAKEAWAY', lines: [line('Water', 3)] },
    cashier,
  );

  today = DayEndPreview.parse(
    (await server().get('/api/v1/day-end').set(as(manager))).body,
  ).businessDate;
});

afterAll(async () => {
  printerServer.close();
  await app.close();
  await database.drop();
});

describe('[BILL-016] [AUD-006] the cash drawer', () => {
  it('[BILL-016] a cash payment opens the drawer through the bill printer', () => {
    expect(kicks()).toBeGreaterThanOrEqual(1);
  });

  it('[BILL-016] opening it without a sale takes a reason, kicks the drawer and is audited', async () => {
    const before = kicks();
    const response = await server()
      .post('/api/v1/cash-drawer/open')
      .set(as(cashier))
      .send({ reason: 'Change for a 500 note' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const opened = OpenCashDrawerResponse.parse(response.body);
    expect(opened).toEqual({
      opened: true,
      error: null,
      printerId: id('printer'),
      shiftId: id('shift'),
    });
    await until(() => kicks() > before, 5_000, 'the no-sale drawer kick');
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'CASH_DRAWER_OPENED' },
    });
    expect(entry).toMatchObject({
      actorId: kit.staff.CASHIER,
      deviceId: kit.deviceId,
      reason: 'Change for a 500 note',
    });
  });

  it('[BILL-016] a printer that cannot be reached is reported and nothing is audited', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const dead = await prisma.printer.create({
      data: {
        restaurantId: kit.restaurantId,
        name: 'Unplugged',
        connection: 'NETWORK',
        host: '127.0.0.1',
        port,
      },
    });
    const response = await server()
      .post('/api/v1/cash-drawer/open')
      .set(as(cashier))
      .send({ reason: 'Checking the float', printerId: dead.id });
    const outcome = OpenCashDrawerResponse.parse(response.body);
    expect(outcome.opened).toBe(false);
    expect(outcome.error).toMatch(/refused/);
    expect(await prisma.auditLog.count({ where: { action: 'CASH_DRAWER_OPENED' } })).toBe(1);
  });

  it('[BILL-016] asks for a reason and an active printer; waiters cannot open it', async () => {
    const noReason = await server().post('/api/v1/cash-drawer/open').set(as(cashier)).send({});
    expect(noReason.status).toBe(400);
    const unknown = await server()
      .post('/api/v1/cash-drawer/open')
      .set(as(cashier))
      .send({ reason: 'Change', printerId: randomUUID() });
    expect(unknown.status).toBe(422);
    expect(codeOf(unknown)).toBe('PRINTER_NOT_FOUND');
    const forbidden = await server()
      .post('/api/v1/cash-drawer/open')
      .set(as(waiter))
      .send({ reason: 'Change' });
    expect(forbidden.status).toBe(403);
  });
});

describe('[RPT-014] [AUD-006] the suspicious-activity report (S12)', () => {
  it('[AUD-006] flags a void after the bill printed: the item and the bill, with who approved', async () => {
    const flags = flagsOf(await report(), 'VOID_AFTER_PRINT');
    expect(flags).toHaveLength(2);
    const item = flags.find((flag) => flag.item === 'Water');
    expect(item).toMatchObject({
      by: { id: kit.staff.CASHIER },
      approvedBy: { id: kit.staff.MANAGER },
      reason: 'Spilled',
      invoiceId: invoices.t1?.id,
      orderId: id('t1Order'),
      quantity: 1,
      amount: 2_000,
    });
    const voidedBill = flags.find((flag) => flag.item === null);
    expect(voidedBill).toMatchObject({
      by: { id: kit.staff.MANAGER },
      reason: 'Wrong item',
      invoiceId: invoices.voided?.id,
      invoiceNumber: invoices.voided?.invoiceNumber,
      amount: invoices.voided?.grandTotal,
    });
  });

  it('[AUD-006] flags a printed bill edited under its number, with the change in the total', async () => {
    const [edit] = flagsOf(await report(), 'EDIT_AFTER_PRINT');
    expect(edit).toMatchObject({
      by: { id: kit.staff.CASHIER },
      approvedBy: { id: kit.staff.MANAGER },
      reason: 'Guest sent the water back',
      invoiceNumber: invoices.t1?.invoiceNumber,
      amount: (invoices.t1Edited?.grandTotal ?? 0) - (invoices.t1?.grandTotal ?? 0),
    });
    expect(edit?.amount).toBeLessThan(0);
  });

  it('[AUD-006] flags a discount above the threshold, and the threshold is a setting', async () => {
    const result = await report();
    expect(result.thresholds.discountFlagBp).toBe(2_000);
    expect(flagsOf(result, 'DISCOUNT_OVER_LIMIT')).toEqual([
      expect.objectContaining({
        by: { id: kit.staff.CASHIER, name: expect.any(String) as string },
        approvedBy: expect.objectContaining({ id: kit.staff.MANAGER }) as object,
        rateBp: 3_000,
        reason: 'Friend of the owner',
        invoiceId: invoices.t2?.id,
      }),
    ]);
    await setSetting('audit.discountFlagBp', 3_000);
    expect(flagsOf(await report(), 'DISCOUNT_OVER_LIMIT')).toEqual([]);
    await setSetting('audit.discountFlagBp', 2_000);
  });

  it('[AUD-006] flags repeated reprints against whoever reprinted most, naming the others', async () => {
    const flags = flagsOf(await report(), 'REPEATED_REPRINT');
    expect(flags).toHaveLength(2);
    const ticket = flags.find((flag) => flag.kotNumber !== null);
    expect(ticket).toMatchObject({
      by: { id: kit.staff.WAITER },
      alsoBy: [expect.objectContaining({ id: kit.staff.MANAGER })],
      count: 3,
      orderId: id('t1Order'),
    });
    const billFlag = flags.find((flag) => flag.invoiceId !== null);
    expect(billFlag).toMatchObject({
      by: { id: kit.staff.CASHIER },
      alsoBy: [],
      count: 2,
      invoiceNumber: invoices.t1?.invoiceNumber,
    });
    await setSetting('audit.reprintFlagCount', 3);
    expect(flagsOf(await report(), 'REPEATED_REPRINT').map((flag) => flag.count)).toEqual([3]);
    await setSetting('audit.reprintFlagCount', 2);
  });

  it('[AUD-006] flags an item voided after the kitchen started it', async () => {
    expect(flagsOf(await report(), 'CANCELLED_AFTER_PREP')).toEqual([
      expect.objectContaining({
        item: 'Water',
        by: expect.objectContaining({ id: kit.staff.CASHIER }) as object,
        approvedBy: expect.objectContaining({ id: kit.staff.MANAGER }) as object,
        amount: 2_000,
      }),
    ]);
  });

  it('[AUD-006] lists no-sale drawer openings with who and why', async () => {
    expect(flagsOf(await report(), 'NO_SALE_DRAWER')).toEqual([
      expect.objectContaining({
        by: expect.objectContaining({ id: kit.staff.CASHIER }) as object,
        reason: 'Change for a 500 note',
      }),
    ]);
  });

  it('[AUD-006] waits for the day to end before calling a sent item unbilled', async () => {
    expect(countOf(await report(), 'SENT_NOT_BILLED')).toBe(0);
  });

  it('[AUD-006] after day-end: a cash variance above the threshold and the KOT never billed', async () => {
    const current = CurrentShiftResponse.parse(
      (await server().get('/api/v1/shifts/current').set(as(cashier))).body,
    );
    const expected = current.shift?.expectedCash ?? 0;
    const closed = await server()
      .post(`/api/v1/shifts/${id('shift')}/close`)
      .set(as(cashier))
      .send({ countedCash: expected - 50_000 });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const day = await server()
      .post('/api/v1/day-end')
      .set(as(manager))
      .send({ businessDate: today });
    expect(day.status, JSON.stringify(day.body)).toBe(201);

    const result = await report();
    expect(flagsOf(result, 'CASH_VARIANCE')).toEqual([
      expect.objectContaining({
        by: expect.objectContaining({ id: kit.staff.CASHIER }) as object,
        amount: -50_000,
      }),
    ]);
    expect(flagsOf(result, 'SENT_NOT_BILLED')).toEqual([
      expect.objectContaining({
        item: 'Water',
        quantity: 3,
        amount: 6_000,
        orderId: id('unbilled'),
        by: expect.objectContaining({ id: kit.staff.CASHIER }) as object,
        kotNumber: expect.any(Number) as number,
      }),
    ]);
  });

  it('[S12] every pattern appears with the correct people attributed', async () => {
    const result = await report();
    expect(Object.fromEntries(result.totals.map((total) => [total.kind, total.count]))).toEqual({
      VOID_AFTER_PRINT: 2,
      EDIT_AFTER_PRINT: 1,
      DISCOUNT_OVER_LIMIT: 1,
      REPEATED_REPRINT: 2,
      CASH_VARIANCE: 1,
      CANCELLED_AFTER_PREP: 1,
      SENT_NOT_BILLED: 1,
      NO_SALE_DRAWER: 1,
    });
    const [first, ...others] = result.people.map((person) => [person.id, person.count]);
    expect(first).toEqual([kit.staff.CASHIER, 8]);
    expect(others).toHaveLength(2);
    expect(others).toEqual(
      expect.arrayContaining([
        [kit.staff.MANAGER, 1],
        [kit.staff.WAITER, 1],
      ]),
    );
  });

  it('[RPT-017] exports with the other reports, stamped', async () => {
    const response = await server()
      .post('/api/v1/reports/exports')
      .set(as(manager))
      .send({ report: 'SUSPICIOUS', from: today, to: today, format: 'CSV' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const file = ReportExportResponse.parse(response.body);
    expect(file.content).toContain('Suspicious activity');
    expect(file.content).toContain('Drawer opened without a sale');
    expect(file.content).toContain('Change for a 500 note');
  });

  it('[RPT-014] is a manager report: cashiers and waiters cannot read it', async () => {
    for (const login of [cashier, waiter]) {
      const response = await server()
        .get('/api/v1/reports/suspicious')
        .query({ from: today, to: today })
        .set(as(login));
      expect(response.status).toBe(403);
    }
  });
});

describe('[AUD-006] the daily report', () => {
  it('[AUD-006] stays quiet when the Owner turned it off', async () => {
    await setSetting('audit.dailyReportEnabled', false);
    expect(await app.get(SuspiciousActivityJob).runFor(kit.restaurantId)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'SUSPICIOUS_ACTIVITY_REPORTED' } })).toBe(
      0,
    );
    await setSetting('audit.dailyReportEnabled', true);
  });

  it('[AUD-006] reports the finished day once, alerting the Owner with the counts', async () => {
    const job = app.get(SuspiciousActivityJob);
    const outcome = await job.runFor(kit.restaurantId);
    expect(outcome).toMatchObject({ businessDate: today, flags: 10 });
    expect(outcome?.alertId).not.toBeNull();
    const alert = await prisma.alert.findUniqueOrThrow({ where: { id: outcome?.alertId ?? '' } });
    expect(alert.type).toBe('SUSPICIOUS_ACTIVITY');
    expect(alert.recipientIds).toEqual([kit.staff.OWNER]);
    expect(alert.payload).toMatchObject({
      businessDate: today,
      flags: 10,
      totals: { VOID_AFTER_PRINT: 2, REPEATED_REPRINT: 2 },
    });
    const owner = await signIn(app, kit, 'OWNER');
    const alerts = AlertListResponse.parse(
      (await server().get('/api/v1/alerts').set(as(owner))).body,
    );
    expect(alerts.alerts.map((entry) => entry.type)).toContain('SUSPICIOUS_ACTIVITY');
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'SUSPICIOUS_ACTIVITY_REPORTED' },
    });
    expect(entry.businessDate.toISOString().slice(0, 10)).toBe(today);
    expect(entry.actorId).toBeNull();

    expect(await job.runFor(kit.restaurantId)).toBeNull();
    expect(await prisma.alert.count({ where: { type: 'SUSPICIOUS_ACTIVITY' } })).toBe(1);
  });
});
