import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  BillView,
  CancellationReportResponse,
  DayEndPreview,
  DiscountReportResponse,
  InvoiceView,
  KitchenReportResponse,
  type LoginResponse,
  OverrideResponse,
  PrintInvoiceResponse,
  RecommendationReportResponse,
  ReprintReportResponse,
  SourceSalesResponse,
  StaffPerformanceResponse,
  SubmitOrderResponse,
  TableReportResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * The full report suite, part one (P4-05a), on a day with known answers:
 * - T1 (waiter): 2 Paneer Tikka, a Water and a Lassi. The Lassi is cancelled before cooking, the
 *   Water voided while cooking (cashier, manager's PIN). 10 % off the bill (cashier). The bill is
 *   printed, printed again, its kitchen ticket reprinted; then a Water is added and the printed
 *   bill edited under its number (manager's PIN).
 * - T2 (waiter): 2 Lassi, given free for a birthday (cashier, manager's PIN).
 * - Takeaway (cashier at the POS): a Water, billed, voided by the manager, billed again.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let cashier: LoginResponse;
let waiter: LoginResponse;
let kitchen: LoginResponse;
let paper: Server;
let today: string;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';
const invoices: Record<string, InvoiceView> = {};
const names = new Map<string, string>();
const nameOf = (staffId: string) => names.get(staffId) ?? '';

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));
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
  return BillView.parse((await server().post('/api/v1/bills').set(as(cashier)).send(target)).body);
}

async function issue(billId: string): Promise<InvoiceView> {
  const response = await server().post(`/api/v1/bills/${billId}/invoice`).set(as(cashier)).send({});
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return InvoiceView.parse(response.body);
}

async function overrideToken(capability: string): Promise<string> {
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
  paper = createServer((socket) => {
    socket.resume();
    socket.on('end', () => socket.end());
  });
  paper.listen(0, '127.0.0.1');
  await once(paper, 'listening');
  const printer = await prisma.printer.create({
    data: {
      ...base,
      name: 'Counter',
      connection: 'NETWORK',
      host: '127.0.0.1',
      port: (paper.address() as AddressInfo).port,
    },
  });
  ids.printer = printer.id;
  await prisma.setting.create({ data: { ...base, key: 'bills.printerId', value: printer.id } });
  app.get(SettingsService).invalidate();
  const station = await prisma.station.create({
    data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
  });
  const group = async (name: string, rateBp: number) =>
    (
      await prisma.taxGroup.create({
        data: {
          ...base,
          name,
          sacCode: '996331',
          components: {
            create: [
              { ...base, code: 'CGST', rateBp },
              { ...base, code: 'SGST', rateBp },
            ],
          },
        },
      })
    ).id;
  const gst5 = await group('GST 5 %', 250);
  const gst18 = await group('GST 18 %', 900);
  const category = (await prisma.category.create({ data: { ...base, name: 'Menu' } })).id;
  for (const [name, price, taxGroupId] of [
    ['Paneer Tikka', 28_000, gst5],
    ['Lassi', 8_000, gst5],
    ['Water', 2_000, gst18],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category,
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

  // T1: a cancellation before cooking and a void while cooking.
  const t1 = await openTable('T1');
  ids.t1 = t1;
  ids.t1Order = await order({
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId: t1,
    lines: [line('Paneer Tikka', 2), line('Water'), line('Lassi')],
  });
  const lassi = await itemOf(ids.t1Order, 'Lassi');
  expect(
    (
      await server()
        .post(`/api/v1/order-items/${lassi}/cancel`)
        .set(as(waiter))
        .send({ reason: 'Changed mind' })
    ).status,
  ).toBe(200);
  const water = await itemOf(ids.t1Order, 'Water');
  await server()
    .post(`/api/v1/order-items/${water}/status`)
    .set(as(kitchen))
    .send({ event: 'START_PREPARING' });
  const voidToken = await overrideToken('ITEM_VOID_AFTER_PREP');
  const voided = await server()
    .post(`/api/v1/order-items/${water}/void`)
    .set({ ...as(cashier), 'x-override-token': voidToken })
    .send({ reason: 'Dropped' });
  expect(voided.status, JSON.stringify(voided.body)).toBe(200);
  const t1Bill = await bill({ tableSessionId: t1 });
  const discounted = await server()
    .post(`/api/v1/bills/${t1Bill.id}/discounts`)
    .set(as(cashier))
    .send({ kind: 'PERCENT', rateBp: 1_000, reason: 'Regular guest' });
  expect(discounted.status, JSON.stringify(discounted.body)).toBe(200);
  invoices.t1 = await issue(t1Bill.id);
  for (let print = 0; print < 2; print += 1) {
    const printed = await server()
      .post(`/api/v1/invoices/${invoices.t1.id}/print`)
      .set(as(cashier))
      .send({});
    expect(PrintInvoiceResponse.parse(printed.body).printed).toBe(true);
  }
  const kot = await prisma.kot.findFirstOrThrow({ where: { orderId: ids.t1Order } });
  ids.kot = kot.id;
  const reprinted = await server()
    .post(`/api/v1/kots/${kot.id}/reprint`)
    .set(as(waiter))
    .send({ printerId: printer.id, reason: 'Paper jam' });
  expect(reprinted.status, JSON.stringify(reprinted.body)).toBe(200);
  // Another Water after printing: the printed bill is edited under its number.
  await order({
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId: t1,
    lines: [line('Water')],
  });
  const editToken = await overrideToken('BILL_EDIT_AFTER_PRINT');
  const reopened = await server()
    .post(`/api/v1/invoices/${invoices.t1.id}/reopen`)
    .set({ ...as(cashier), 'x-override-token': editToken })
    .send({ reason: 'Another water' });
  expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
  invoices.t1Edited = await issue(t1Bill.id);

  // T2: a complimentary item.
  const t2 = await openTable('T2');
  ids.t2 = t2;
  const second = await order({
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId: t2,
    lines: [line('Lassi', 2)],
  });
  const t2Bill = await bill({ tableSessionId: t2 });
  const freeToken = await overrideToken('DISCOUNT_ABOVE_LIMIT');
  const freeLassi = await itemOf(second, 'Lassi');
  ids.freeLassi = freeLassi;
  const free = await server()
    .post(`/api/v1/bills/${t2Bill.id}/discounts`)
    .set({ ...as(cashier), 'x-override-token': freeToken })
    .send({
      orderItemId: freeLassi,
      kind: 'PERCENT',
      rateBp: 10_000,
      reason: 'Birthday',
    });
  expect(free.status, JSON.stringify(free.body)).toBe(200);
  invoices.t2 = await issue(t2Bill.id);

  // Takeaway: billed, voided, billed again.
  const takeaway = await order(
    { source: 'POS', orderType: 'TAKEAWAY', lines: [line('Water')] },
    cashier,
  );
  const takeawayBill = await bill({ orderId: takeaway });
  invoices.voided = await issue(takeawayBill.id);
  await server()
    .post(`/api/v1/invoices/${invoices.voided.id}/void`)
    .set(as(manager))
    .send({ reason: 'Wrong item' });
  invoices.reissued = await issue(takeawayBill.id);

  for (const person of await prisma.staff.findMany({ select: { id: true, displayName: true } })) {
    names.set(person.id, person.displayName);
  }
  today = DayEndPreview.parse(
    (await server().get('/api/v1/day-end').set(as(manager))).body,
  ).businessDate;

  // Acknowledgements: an alert after 90 s and a water request after 30 s; one escalated alert.
  const raised = new Date('2026-09-30T10:00:00.000Z');
  const later = (seconds: number) => new Date(raised.getTime() + seconds * 1_000);
  await prisma.alert.createMany({
    data: [
      {
        ...base,
        businessDate: new Date(today),
        type: 'ITEM_READY',
        status: 'ACKNOWLEDGED',
        recipientIds: [kit.staff.WAITER],
        createdAt: raised,
        acknowledgedAt: later(90),
        acknowledgedById: kit.staff.WAITER,
      },
      {
        ...base,
        businessDate: new Date(today),
        type: 'BILL_REQUEST',
        recipientIds: [kit.staff.WAITER, kit.staff.MANAGER],
        escalatedAt: later(60),
        escalatedTo: [kit.staff.MANAGER],
        createdAt: raised,
      },
    ],
  });
  await prisma.serviceRequest.create({
    data: {
      ...base,
      businessDate: new Date(today),
      tableSessionId: t2,
      tableId: id('T2'),
      type: 'WATER',
      source: 'TABLE_TABLET',
      createdAt: raised,
      acknowledgedAt: later(30),
      acknowledgedById: kit.staff.WAITER,
    },
  });

  // Kitchen times (P4-05b): the Paneer Tikka cooked 10 min and collected after 1 min; the free
  // Lassi bumped straight to ready 2 min after sending and served 1 min later.
  const paneer = await itemOf(ids.t1Order, 'Paneer Tikka');
  ids.paneer = paneer;
  await prisma.orderItem.update({
    where: { id: paneer },
    data: { preparingAt: raised, readyAt: later(600), pickedUpAt: later(660) },
  });
  await prisma.orderItem.update({
    where: { id: freeLassi },
    data: { sentAt: raised, preparingAt: null, readyAt: later(120), servedAt: later(180) },
  });
  // The kitchen pressed "Notify manager" once; the other uncollected-dish alert is the timer's.
  await prisma.alert.createMany({
    data: [
      {
        ...base,
        businessDate: new Date(today),
        type: 'READY_NOT_COLLECTED',
        kotId: id('kot'),
        raisedByDeviceId: kit.deviceId,
      },
      { ...base, businessDate: new Date(today), type: 'READY_NOT_COLLECTED', kotId: id('kot') },
    ],
  });
  // Both tables served and left: T1 after an hour, T2 after half an hour. A third session, opened
  // by mistake, does not count.
  for (const [session, minutes] of [
    [t1, 60],
    [t2, 30],
  ] as const) {
    await prisma.tableSession.update({
      where: { id: session },
      data: { status: 'CLOSED', openedAt: raised, closedAt: later(minutes * 60) },
    });
  }
  await prisma.tableSession.create({
    data: {
      ...base,
      tableId: id('T2'),
      businessDate: new Date(today),
      status: 'CLOSED',
      covers: 4,
      openedAt: raised,
      closedAt: later(60),
      closeReason: 'Opened by mistake',
    },
  });
  // Suggestions: the Paneer Tikka from a rule, shown twice, opened, added and ordered; the
  // voided Water from best sellers, shown twice and ordered.
  const event = (kind: string, layer: string, itemName: string, orderItemId?: string) => ({
    ...base,
    businessDate: new Date(today),
    kind: kind as 'IMPRESSION',
    layer: layer as 'RULE',
    itemId: id(itemName),
    channel: 'WAITER_APP' as const,
    tableSessionId: t1,
    ...(orderItemId !== undefined && { orderItemId }),
  });
  await prisma.recommendationEvent.createMany({
    data: [
      event('IMPRESSION', 'RULE', 'Paneer Tikka'),
      event('IMPRESSION', 'RULE', 'Paneer Tikka'),
      event('TAP', 'RULE', 'Paneer Tikka'),
      event('ADD_TO_CART', 'RULE', 'Paneer Tikka'),
      event('ORDERED', 'RULE', 'Paneer Tikka', paneer),
      event('IMPRESSION', 'BEST_SELLER', 'Water'),
      event('IMPRESSION', 'BEST_SELLER', 'Water'),
      event('ORDERED', 'BEST_SELLER', 'Water', await itemOf(ids.t1Order, 'Water')),
    ],
  });
});

afterAll(async () => {
  paper.close();
  await app.close();
  await database.drop();
});

const report = (path: string, login = manager) =>
  server().get(`/api/v1/reports/${path}`).query({ from: today, to: today }).set(as(login));

describe('[RPT-004] sales by source and order type', () => {
  it('adds up billed lines per source and type, without the voided bill', async () => {
    const response = await report('sources');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const sources = SourceSalesResponse.parse(response.body);
    // T1 after the edit: 2 Paneer Tikka and a Water, 10 % off; T2: 2 Lassi, free.
    expect(sources.rows).toEqual([
      {
        source: 'POS',
        orderType: 'TAKEAWAY',
        orders: 1,
        gross: 2_000,
        discounts: 0,
        net: 2_000,
      },
      {
        source: 'WAITER_APP',
        orderType: 'DINE_IN',
        orders: 3,
        gross: 74_000,
        discounts: 21_800,
        net: 52_200,
      },
    ]);
    expect(sources.totals).toEqual({ orders: 4, gross: 76_000, discounts: 21_800, net: 54_200 });
  });

  it('is for people who see reports, not a cashier', async () => {
    expect((await report('sources', cashier)).status).toBe(403);
    expect((await report('staff', waiter)).status).toBe(403);
  });
});

describe('[RPT-003] each person’s work', () => {
  it('counts orders, sales, acknowledgements, escalations, cancellations and voids', async () => {
    const { staff } = StaffPerformanceResponse.parse((await report('staff')).body);
    const of = (staffId: string) => staff.find((person) => person.staffId === staffId);
    expect(of(kit.staff.WAITER)).toMatchObject({
      role: 'WAITER',
      ordersCreated: 3,
      ordersApproved: 0,
      net: 52_200,
      acknowledgements: 2,
      averageAckSeconds: 60,
      escalations: 1,
      cancellations: 1,
      voids: 0,
    });
    expect(of(kit.staff.CASHIER)).toMatchObject({
      role: 'CASHIER',
      ordersCreated: 1,
      net: 2_000,
      acknowledgements: 0,
      averageAckSeconds: null,
      escalations: 0,
      cancellations: 0,
      voids: 1,
    });
    // The manager only approved and was escalated to: nothing of their own here.
    expect(of(kit.staff.MANAGER)).toBeUndefined();
  });
});

describe('[RPT-007] discounts and complimentary items', () => {
  it('lists each with who gave it, who approved it, the reason and the value', async () => {
    const report7 = DiscountReportResponse.parse((await report('discounts')).body);
    expect(report7.discounts).toEqual([
      expect.objectContaining({
        invoiceId: invoices.t1?.id,
        orderId: null,
        item: null,
        complimentary: false,
        kind: 'PERCENT',
        rateBp: 1_000,
        amount: 5_800,
        reason: 'Regular guest',
        appliedBy: { id: kit.staff.CASHIER, name: nameOf(kit.staff.CASHIER) },
        approvedBy: null,
      }),
      expect.objectContaining({
        invoiceId: invoices.t2?.id,
        item: 'Lassi',
        complimentary: true,
        amount: 16_000,
        reason: 'Birthday',
        appliedBy: { id: kit.staff.CASHIER, name: nameOf(kit.staff.CASHIER) },
        approvedBy: { id: kit.staff.MANAGER, name: nameOf(kit.staff.MANAGER) },
      }),
    ]);
    expect(report7.totals).toEqual({
      count: 2,
      amount: 21_800,
      complimentaryCount: 1,
      complimentaryAmount: 16_000,
    });
  });
});

describe('[RPT-008] cancellations and voids', () => {
  it('gives the stage, who, approver, reason and value, and calls a cooked void wastage', async () => {
    const report8 = CancellationReportResponse.parse((await report('cancellations')).body);
    expect(report8.items).toEqual([
      expect.objectContaining({
        kind: 'CANCELLED',
        orderId: id('t1Order'),
        item: 'Lassi',
        quantity: 1,
        stage: 'SENT',
        value: 8_000,
        wastage: false,
        by: { id: kit.staff.WAITER, name: nameOf(kit.staff.WAITER) },
        approvedBy: null,
        reason: 'Changed mind',
      }),
      expect.objectContaining({
        kind: 'VOIDED',
        item: 'Water',
        stage: 'PREPARING',
        value: 2_000,
        wastage: true,
        by: { id: kit.staff.CASHIER, name: nameOf(kit.staff.CASHIER) },
        approvedBy: { id: kit.staff.MANAGER, name: nameOf(kit.staff.MANAGER) },
        reason: 'Dropped',
      }),
    ]);
    expect(report8.bills).toEqual([
      expect.objectContaining({
        invoiceId: invoices.voided?.id,
        invoiceNumber: invoices.voided?.invoiceNumber,
        value: invoices.voided?.grandTotal,
        by: { id: kit.staff.MANAGER, name: nameOf(kit.staff.MANAGER) },
        reason: 'Wrong item',
      }),
    ]);
    expect(report8.totals).toEqual({
      cancelledCount: 1,
      cancelledValue: 8_000,
      voidedCount: 1,
      voidedValue: 2_000,
      wastageValue: 2_000,
      billCount: 1,
      billValue: invoices.voided?.grandTotal,
    });
  });
});

describe('[RPT-009] reprints and bill edits', () => {
  it('lists kitchen tickets and bills printed again, and bills edited after printing', async () => {
    const report9 = ReprintReportResponse.parse((await report('reprints')).body);
    const kot = await prisma.kot.findUniqueOrThrow({ where: { id: id('kot') } });
    expect(report9.events.map((event) => event.kind)).toEqual([
      'BILL_REPRINT',
      'KOT_REPRINT',
      'BILL_EDIT',
    ]);
    expect(report9.events[0]).toMatchObject({
      reference: invoices.t1?.invoiceNumber,
      invoiceId: invoices.t1?.id,
      by: { id: kit.staff.CASHIER },
    });
    expect(report9.events[1]).toMatchObject({
      reference: `KOT ${String(kot.kotNumber)}`,
      orderId: id('t1Order'),
      invoiceId: null,
      by: { id: kit.staff.WAITER },
      reason: 'Paper jam',
    });
    expect(report9.events[2]).toMatchObject({
      reference: invoices.t1?.invoiceNumber,
      by: { id: kit.staff.CASHIER },
      approvedBy: { id: kit.staff.MANAGER },
      reason: 'Another water',
      before: invoices.t1?.grandTotal,
      after: invoices.t1Edited?.grandTotal,
    });
    expect(report9.totals).toEqual({ kotReprints: 1, billReprints: 1, billEdits: 1 });
  });
});

describe('[RPT-010] kitchen performance', () => {
  it('averages prep and pickup times by station and dish, and counts Notify manager', async () => {
    const response = await report('kitchen');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const kitchen10 = KitchenReportResponse.parse(response.body);
    expect(kitchen10.stations).toEqual([
      expect.objectContaining({
        name: 'Kitchen',
        lines: 2,
        quantity: 4,
        averagePrepSeconds: 360,
        averagePickupSeconds: 60,
        notifyManager: 1,
      }),
    ]);
    expect(kitchen10.items).toEqual([
      {
        itemId: id('Lassi'),
        name: 'Lassi',
        station: 'Kitchen',
        lines: 1,
        quantity: 2,
        averagePrepSeconds: 120,
        averagePickupSeconds: 60,
      },
      {
        itemId: id('Paneer Tikka'),
        name: 'Paneer Tikka',
        station: 'Kitchen',
        lines: 1,
        quantity: 2,
        averagePrepSeconds: 600,
        averagePickupSeconds: 60,
      },
    ]);
    expect(kitchen10.totals).toEqual({
      lines: 2,
      quantity: 4,
      averagePrepSeconds: 360,
      averagePickupSeconds: 60,
      notifyManager: 1,
    });
  });
});

describe('[RPT-011] table metrics', () => {
  it('gives covers, seated time, spend per cover and turnover of the tables served', async () => {
    const tables11 = TableReportResponse.parse((await report('tables')).body);
    const t1Spend = invoices.t1Edited?.grandTotal ?? 0;
    const t2Spend = invoices.t2?.grandTotal ?? 0;
    expect(tables11.tables).toEqual([
      {
        tableId: id('T1'),
        label: 'T1',
        sessions: 1,
        covers: 2,
        averageSeatedSeconds: 3_600,
        spend: t1Spend,
        spendPerCover: Math.round(t1Spend / 2),
      },
      {
        tableId: id('T2'),
        label: 'T2',
        sessions: 1,
        covers: 2,
        averageSeatedSeconds: 1_800,
        spend: t2Spend,
        spendPerCover: Math.round(t2Spend / 2),
      },
    ]);
    expect(tables11.totals).toMatchObject({
      sessions: 2,
      covers: 4,
      averageSeatedSeconds: 2_700,
      spend: t1Spend + t2Spend,
      tableCount: 2,
      days: 1,
      // Two sessions on two tables in one day: one turn each.
      turnoverBp: 10_000,
    });
  });
});

describe('[RPT-012] [REC-008] recommendation performance', () => {
  it('counts each step per layer, with revenue only from lines that stayed', async () => {
    const reco = RecommendationReportResponse.parse((await report('recommendations')).body);
    expect(reco.layers).toEqual([
      {
        layer: 'RULE',
        impressions: 2,
        taps: 1,
        addedToCart: 1,
        ordered: 1,
        attachRateBp: 5_000,
        revenue: 56_000,
      },
      {
        layer: 'LEARNED',
        impressions: 0,
        taps: 0,
        addedToCart: 0,
        ordered: 0,
        attachRateBp: null,
        revenue: 0,
      },
      {
        layer: 'BEST_SELLER',
        impressions: 2,
        taps: 0,
        addedToCart: 0,
        ordered: 1,
        attachRateBp: 5_000,
        revenue: 0,
      },
    ]);
    expect(reco.items.map((item) => [item.name, item.ordered, item.revenue])).toEqual([
      ['Paneer Tikka', 1, 56_000],
      ['Water', 1, 0],
    ]);
    expect(reco.totals).toEqual({
      impressions: 4,
      taps: 1,
      addedToCart: 1,
      ordered: 2,
      attachRateBp: 5_000,
      revenue: 56_000,
      orders: 4,
      ordersWithSuggestion: 1,
    });
  });
});
