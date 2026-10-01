import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BillView,
  InvoiceView,
  type LoginResponse,
  PendingApprovalsResponse,
  PrintInvoiceResponse,
  ServiceRequestView,
  SubmitOrderResponse,
  TableServiceRequestsResponse,
  TableSessionView,
  TabletOrdersResponse,
  TabletTableView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
  signIn,
  TEST_PINS,
} from '../helpers/auth-kit.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * Phase 3 exit (P3-06), scenario S6: a table's whole visit on its tablet. Open → order →
 * approval in the waiter app and at the table with the waiter's PIN → status → Water and Cancel →
 * bill and feedback → paid and closed, the tablet back to idle → the next guests start with
 * nothing carried over. Over the real API and live connection; the tablet's own wipe of what the
 * guests left on it is tested in `apps/table-tablet`.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let cashier: LoginResponse;
let kitchen: LoginResponse;
let paper: Server;
let live: RealtimeTestClient;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const tablet = () => authHeaders(id('tablet'));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

async function tableView(): Promise<TabletTableView> {
  return TabletTableView.parse(
    (await server().get('/api/v1/devices/current/table').set(tablet())).body,
  );
}

async function tabletOrders(): Promise<TabletOrdersResponse> {
  return TabletOrdersResponse.parse(
    (await server().get('/api/v1/devices/current/orders').set(tablet())).body,
  );
}

async function tabletRequests(): Promise<TableServiceRequestsResponse> {
  return TableServiceRequestsResponse.parse(
    (await server().get('/api/v1/devices/current/service-requests').set(tablet())).body,
  );
}

async function dinerOrder(name: string, quantity: number): Promise<string> {
  const response = await server()
    .post('/api/v1/devices/current/orders')
    .set(tablet())
    .send({
      idempotencyKey: randomUUID(),
      lines: [{ clientLineId: randomUUID(), itemId: id(name), quantity }],
    });
  const placed = SubmitOrderResponse.parse(response.body);
  if (placed.status !== 'ACCEPTED') throw new Error(JSON.stringify(placed));
  expect(placed.itemState).toBe('PENDING_APPROVAL');
  return placed.orderId;
}

const states = (orders: TabletOrdersResponse) =>
  orders.orders.flatMap((order) => order.items.map((item) => [item.name, item.state]));

const heard = (type: string) => live.received.filter((event) => event.type === type).length;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  cashier = await signIn(app, kit, 'CASHIER');
  kitchen = await signIn(app, kit, 'KITCHEN');
  const manager = await signIn(app, kit, 'MANAGER');
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
  await prisma.setting.create({ data: { ...base, key: 'bills.printerId', value: printer.id } });
  app.get(SettingsService).invalidate();
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
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
  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  for (const [name, price] of [
    ['Paneer Tikka', 28_000],
    ['Mineral Water', 2_000],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
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
  const section = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  ids.T1 = (
    await prisma.diningTable.create({ data: { ...base, sectionId: section.id, label: 'T1' } })
  ).id;
  ids.tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: id('T1') });
  live = await RealtimeTestClient.connect(appUrl(app), {
    deviceToken: deviceTokenOf(id('tablet')),
  });
});

afterAll(async () => {
  live.close();
  paper.close();
  await app.close();
  await database.drop();
});

describe('[S6] Phase 3 exit: a table’s visit on its tablet', () => {
  it('[TAB-003] opens: the tablet unlocks and hears it', async () => {
    expect((await tableView()).session).toBeNull();
    const opened = await server()
      .post(`/api/v1/tables/${id('T1')}/open`)
      .set(as(waiter))
      .send({ covers: 2 });
    ids.session = TableSessionView.parse(opened.body).id;
    await live.waitFor(() => heard('TableOpened') > 0 || undefined);
    expect((await tableView()).session?.id).toBe(id('session'));
  });

  it('[ORD-003] [ORD-005] orders: the order waits and the waiter is alerted', async () => {
    ids.first = await dinerOrder('Paneer Tikka', 2);
    await until(
      async () =>
        (await prisma.alert.count({
          where: { type: 'ORDER_PENDING_APPROVAL', orderId: id('first'), status: 'OPEN' },
        })) === 1,
      5_000,
      'the approval alert',
    );
    expect(states(await tabletOrders())).toEqual([['Paneer Tikka', 'PENDING_APPROVAL']]);
  });

  it('[WTR-004] the waiter approves it in the app: the kitchen gets the ticket', async () => {
    const inbox = PendingApprovalsResponse.parse(
      (await server().get('/api/v1/orders/pending-approval').set(as(waiter))).body,
    );
    expect(inbox.orders.map((entry) => entry.order.id)).toEqual([id('first')]);
    const approved = await server()
      .post(`/api/v1/orders/${id('first')}/approve`)
      .set(as(waiter))
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await prisma.kot.count({ where: { orderId: id('first') } })).toBe(1);
    await live.waitFor(() => heard('OrderApproved') > 0 || undefined);
    expect(states(await tabletOrders())).toEqual([['Paneer Tikka', 'SENT']]);
  });

  it('[TAB-009] the tablet follows it through the kitchen to the table', async () => {
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: id('first') } });
    for (const [login, event] of [
      [kitchen, 'START_PREPARING'],
      [kitchen, 'MARK_READY'],
      [waiter, 'SERVE'],
    ] as const) {
      const step = await server()
        .post(`/api/v1/order-items/${item.id}/status`)
        .set(as(login))
        .send({ event });
      expect(step.status, `${event}: ${JSON.stringify(step.body)}`).toBe(200);
    }
    await live.waitFor(() => heard('ItemStatusChanged') >= 4 || undefined);
    expect(states(await tabletOrders())).toEqual([['Paneer Tikka', 'SERVED']]);
    expect((await tabletOrders()).runningTotal).toBe(56_000);
  });

  it('[ORD-004] the next order is approved at the table with the waiter’s PIN', async () => {
    ids.second = await dinerOrder('Mineral Water', 2);
    const response = await server()
      .post(`/api/v1/devices/current/orders/${id('second')}/approve`)
      .set(tablet())
      .send({ staffId: kit.staff.WAITER, pin: TEST_PINS.WAITER });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(states(await tabletOrders())).toEqual([
      ['Paneer Tikka', 'SERVED'],
      ['Mineral Water', 'SENT'],
    ]);
  });

  it('[TAB-004] Water calls the waiter once; Cancel clears it', async () => {
    const raised = await server()
      .post('/api/v1/devices/current/service-requests')
      .set(tablet())
      .send({ type: 'WATER' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    const water = ServiceRequestView.parse(raised.body);
    const again = await server()
      .post('/api/v1/devices/current/service-requests')
      .set(tablet())
      .send({ type: 'WATER' });
    expect(again.status).toBe(409);
    const cancelled = await server()
      .post(`/api/v1/devices/current/service-requests/${water.id}/cancel`)
      .set(tablet())
      .send({});
    expect(ServiceRequestView.parse(cancelled.body).state).toBe('CANCELLED');
    expect((await tabletRequests()).requests).toEqual([]);
  });

  it('[BILL-014] [TAB-014] the bill prints and the guests leave feedback', async () => {
    const bill = BillView.parse(
      (
        await server()
          .post('/api/v1/bills')
          .set(as(cashier))
          .send({ tableSessionId: id('session') })
      ).body,
    );
    const issued = await server()
      .post(`/api/v1/bills/${bill.id}/invoice`)
      .set(as(cashier))
      .send({});
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const invoice = InvoiceView.parse(issued.body);
    ids.invoice = invoice.id;
    ids.total = String(invoice.grandTotal);
    const printed = await server()
      .post(`/api/v1/invoices/${invoice.id}/print`)
      .set(as(cashier))
      .send({});
    expect(PrintInvoiceResponse.parse(printed.body).printed).toBe(true);
    expect((await tableView()).state).toBe('BILL_PRINTED');
    const feedback = await server()
      .post('/api/v1/devices/current/feedback')
      .set(tablet())
      .send({ foodRating: 5, serviceRating: 5, comment: 'Quick and friendly' });
    expect(feedback.status, JSON.stringify(feedback.body)).toBe(201);
  });

  it('[TAB-003] paid and closed: the tablet goes back to idle', async () => {
    const paid = await server()
      .post(`/api/v1/invoices/${id('invoice')}/payments`)
      .set(as(cashier))
      .send({
        idempotencyKey: randomUUID(),
        payments: [{ mode: 'UPI', amount: Number(id('total')) }],
      });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    await live.waitFor(() => heard('TableClosed') > 0 || undefined);
    const view = await tableView();
    expect(view).toMatchObject({ state: 'FREE', session: null });
    expect(await tabletOrders()).toEqual({
      tableSessionId: null,
      orders: [],
      runningTotal: 0,
      pendingTotal: 0,
    });
  });

  it('[S6] the next guests start with nothing carried over', async () => {
    const opened = await server()
      .post(`/api/v1/tables/${id('T1')}/open`)
      .set(as(waiter))
      .send({ covers: 4 });
    const next = TableSessionView.parse(opened.body).id;
    expect(next).not.toBe(id('session'));
    expect((await tableView()).session?.id).toBe(next);
    expect((await tabletOrders()).orders).toEqual([]);
    expect((await tabletRequests()).requests).toEqual([]);
    expect(
      await prisma.alert.count({ where: { tableSessionId: id('session'), status: 'OPEN' } }),
    ).toBe(0);
    // Feedback is asked of the new guests again (one per visit).
    const feedback = await server()
      .post('/api/v1/devices/current/feedback')
      .set(tablet())
      .send({ foodRating: 4, serviceRating: 4 });
    expect(feedback.status).toBe(201);
    const twice = await server()
      .post('/api/v1/devices/current/feedback')
      .set(tablet())
      .send({ foodRating: 4, serviceRating: 4 });
    expect(codeOf(twice)).toBe('FEEDBACK_ALREADY_GIVEN');
  });
});
