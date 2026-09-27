import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type LoginResponse,
  OrderFeedResponse,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import { filterOrderFeed, itemDelay, summarizeOrderFeed } from '@rp/domain';
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
let waiter: LoginResponse;
let cashier: LoginResponse;
let kitchen: LoginResponse;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  cashier = await signIn(app, kit, 'CASHIER');
  kitchen = await signIn(app, kit, 'KITCHEN');
  const base = { restaurantId: kit.restaurantId };
  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  const tax = await prisma.taxGroup.create({ data: { ...base, name: 'Nil' } });
  for (const station of ['Kitchen', 'Bar', 'Old Grill']) {
    ids[station] = (
      await prisma.station.create({ data: { ...base, name: station, mode: 'SCREEN' } })
    ).id;
  }
  await prisma.station.update({ where: { id: id('Old Grill') }, data: { archivedAt: new Date() } });
  for (const [name, station, prepTimeMinutes] of [
    ['Dal', 'Kitchen', 15],
    ['Roti', 'Kitchen', null],
    ['Lassi', 'Bar', 5],
    ['Thali', 'Kitchen', null],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: 10_000,
          taxGroupId: tax.id,
          foodType: 'VEG',
          stationId: id(station),
          prepTimeMinutes,
        },
      })
    ).id;
  }
  await prisma.combo.create({
    data: {
      ...base,
      itemId: id('Thali'),
      components: {
        create: [
          { ...base, kind: 'FIXED', itemId: id('Dal'), quantity: 1, displayOrder: 1 },
          { ...base, kind: 'FIXED', itemId: id('Roti'), quantity: 2, displayOrder: 2 },
        ],
      },
    },
  });
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

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

async function feed(login: LoginResponse = manager): Promise<OrderFeedResponse> {
  const response = await server().get('/api/v1/order-feed').set(as(login));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return OrderFeedResponse.parse(response.body);
}

async function open(table: string, login: LoginResponse): Promise<string> {
  const response = await server()
    .post(`/api/v1/tables/${id(table)}/open`)
    .set(as(login))
    .send({ covers: 2 });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return TableSessionView.parse(response.body).id;
}

async function order(
  login: LoginResponse,
  lines: { item: string; quantity?: number }[],
  tableSessionId?: string,
): Promise<string> {
  const response = await server()
    .post('/api/v1/orders')
    .set(as(login))
    .send({
      idempotencyKey: randomUUID(),
      source: login === waiter ? 'WAITER_APP' : 'POS',
      orderType: tableSessionId === undefined ? 'TAKEAWAY' : 'DINE_IN',
      ...(tableSessionId !== undefined && { tableSessionId }),
      lines: lines.map((line) => ({
        clientLineId: randomUUID(),
        itemId: id(line.item),
        quantity: line.quantity ?? 1,
      })),
    });
  const result = SubmitOrderResponse.parse(response.body);
  if (result.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return result.orderId;
}

const step = (login: LoginResponse, orderItemId: string, event: string) =>
  server().post(`/api/v1/order-items/${orderItemId}/status`).set(as(login)).send({ event });

function entry(response: OrderFeedResponse, orderId: string) {
  const found = response.orders.find((candidate) => candidate.orderId === orderId);
  if (found === undefined) throw new Error(`order ${orderId} is not in the feed`);
  return found;
}

describe('[MGR-003] the live order feed', () => {
  it('lists every order with something in the kitchen, oldest first, with stations, states and times', async () => {
    ids.session1 = await open('T1', waiter);
    ids.dineIn = await order(
      waiter,
      [{ item: 'Dal', quantity: 2 }, { item: 'Lassi' }, { item: 'Thali' }],
      id('session1'),
    );
    ids.takeaway = await order(cashier, [{ item: 'Roti', quantity: 3 }]);

    const before = Date.now();
    const response = await feed();
    expect(response.orders.map((candidate) => candidate.orderId)).toEqual([
      id('dineIn'),
      id('takeaway'),
    ]);
    const dineIn = entry(response, id('dineIn'));
    expect(dineIn).toMatchObject({
      orderType: 'DINE_IN',
      source: 'WAITER_APP',
      tableId: id('T1'),
      tableLabel: 'T1',
      takeawayToken: null,
      waiterId: kit.staff.WAITER,
      waiterName: 'Test waiter',
    });
    // The kitchen cooks the combo's parts; the combo's own line is not shown.
    expect(
      dineIn.items.map(({ name, quantity, comboName, stationName, state, prepTimeMinutes }) => ({
        name,
        quantity,
        comboName,
        stationName,
        state,
        prepTimeMinutes,
      })),
    ).toEqual([
      {
        name: 'Dal',
        quantity: 2,
        comboName: null,
        stationName: 'Kitchen',
        state: 'SENT',
        prepTimeMinutes: 15,
      },
      {
        name: 'Lassi',
        quantity: 1,
        comboName: null,
        stationName: 'Bar',
        state: 'SENT',
        prepTimeMinutes: 5,
      },
      {
        name: 'Dal',
        quantity: 1,
        comboName: 'Thali',
        stationName: 'Kitchen',
        state: 'SENT',
        prepTimeMinutes: 15,
      },
      {
        name: 'Roti',
        quantity: 2,
        comboName: 'Thali',
        stationName: 'Kitchen',
        state: 'SENT',
        prepTimeMinutes: null,
      },
    ]);
    for (const line of dineIn.items) {
      expect(line.sentAt).not.toBeNull();
      expect(line.preparingAt).toBeNull();
      expect(line.readyAt).toBeNull();
    }
    // A takeaway order's waiter is the person who took it.
    expect(entry(response, id('takeaway'))).toMatchObject({
      orderType: 'TAKEAWAY',
      source: 'POS',
      tableId: null,
      tableLabel: null,
      waiterId: kit.staff.CASHIER,
      waiterName: 'Test cashier',
    });
    expect(entry(response, id('takeaway')).takeawayToken).toBeGreaterThan(0);

    // The filters offer the stations in use (not archived ones) and the people serving.
    expect(response.stations.map((station) => station.name)).toEqual(['Bar', 'Kitchen']);
    expect(response.waiters.map((person) => person.name)).toEqual(['Test cashier', 'Test waiter']);
    expect(response.settings).toEqual({ ageRedMinutes: 20, readyNotCollectedMinutes: 3 });
    const serverTime = Date.parse(response.serverTime);
    expect(serverTime).toBeGreaterThanOrEqual(before - 1000);
    expect(serverTime).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('follows the kitchen, and drops cancelled dishes and orders with nothing left to do', async () => {
    const lines = entry(await feed(), id('dineIn')).items;
    const [dal, lassi] = lines;
    expect((await step(kitchen, dal?.orderItemId ?? '', 'START_PREPARING')).status).toBe(200);
    expect((await step(kitchen, dal?.orderItemId ?? '', 'MARK_READY')).status).toBe(200);
    const cancelled = await server()
      .post(`/api/v1/order-items/${lassi?.orderItemId ?? ''}/cancel`)
      .set(as(waiter))
      .send({ reason: 'Guest changed their mind' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const after = entry(await feed(), id('dineIn'));
    expect(after.items.map((line) => `${line.name}: ${line.state}`)).toEqual([
      'Dal: READY',
      'Dal: SENT',
      'Roti: SENT',
    ]);
    expect(after.items[0]?.preparingAt).not.toBeNull();
    expect(after.items[0]?.readyAt).not.toBeNull();

    // Everything of the takeaway order handed over: it leaves the feed.
    const [roti] = entry(await feed(), id('takeaway')).items;
    expect((await step(kitchen, roti?.orderItemId ?? '', 'MARK_READY')).status).toBe(200);
    expect((await step(cashier, roti?.orderItemId ?? '', 'PICK_UP')).status).toBe(200);
    expect((await feed()).orders.map((candidate) => candidate.orderId)).toEqual([id('dineIn')]);
  });

  it('gives the screen what it needs to mark late dishes and filter them', async () => {
    const lines = entry(await feed(), id('dineIn')).items;
    const readyDal = lines[0]?.orderItemId ?? '';
    const comboDal = lines[1]?.orderItemId ?? '';
    await prisma.orderItem.update({
      where: { id: comboDal },
      data: { sentAt: new Date(Date.now() - 16 * 60_000) },
    });
    await prisma.orderItem.update({
      where: { id: readyDal },
      data: { readyAt: new Date(Date.now() - 2 * 60_000) },
    });
    const response = await feed();
    const now = Date.parse(response.serverTime);
    const items = entry(response, id('dineIn')).items;
    expect(items.map((line) => itemDelay(line, now, response.settings)?.kind ?? null)).toEqual([
      null,
      'KITCHEN',
      null,
    ]);
    expect(summarizeOrderFeed(response.orders, now, response.settings)).toMatchObject({
      inKitchen: 2,
      ready: 1,
      delayed: 1,
    });
    // A minute later the ready Dal has waited at the pass for too long as well.
    expect(summarizeOrderFeed(response.orders, now + 60_000, response.settings).delayed).toBe(2);
    const bar = filterOrderFeed(response.orders, { stationId: id('Bar') }, now, response.settings);
    expect(bar).toEqual([]);
    const waiters = filterOrderFeed(
      response.orders,
      { waiterId: kit.staff.WAITER, delayedOnly: true },
      now,
      response.settings,
    );
    expect(waiters.map((candidate) => candidate.orderId)).toEqual([id('dineIn')]);
  });

  it('reads prep times from the published menu, not from unpublished changes', async () => {
    await prisma.item.update({ where: { id: id('Dal') }, data: { prepTimeMinutes: 25 } });
    const prep = async () => entry(await feed(), id('dineIn')).items[1]?.prepTimeMinutes;
    expect(await prep()).toBe(15);
    expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
    expect(await prep()).toBe(25);
  });

  it('lets a dine-in order leave with its table, and a takeaway order with its business date', async () => {
    ids.session2 = await open('T2', cashier);
    ids.second = await order(cashier, [{ item: 'Roti' }], id('session2'));
    ids.lateTakeaway = await order(cashier, [{ item: 'Lassi' }]);
    const orders = async () => (await feed()).orders.map((candidate) => candidate.orderId);
    expect(await orders()).toEqual([id('dineIn'), id('second'), id('lateTakeaway')]);
    // The table was settled and closed with a dish never marked: it goes with the table.
    await prisma.tableSession.update({
      where: { id: id('session2') },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    // A takeaway order from an earlier business date that was never handed over.
    await prisma.order.update({
      where: { id: id('lateTakeaway') },
      data: { businessDate: new Date('2020-01-01T00:00:00.000Z') },
    });
    expect(await orders()).toEqual([id('dineIn')]);
    // The people serving: the waiter of the open table and of the live orders.
    expect((await feed()).waiters.map((person) => person.name)).toEqual(['Test waiter']);
  });

  it('[MGR-001] is for managers and owners: other roles are refused', async () => {
    for (const login of [waiter, cashier, kitchen]) {
      const response = await server().get('/api/v1/order-feed').set(as(login));
      expect(response.status).toBe(403);
      expect(codeOf(response)).toBe('FORBIDDEN');
    }
    expect((await server().get('/api/v1/order-feed').set(authHeaders(kit.deviceId))).status).toBe(
      401,
    );
  });
});
