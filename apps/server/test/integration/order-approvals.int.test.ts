import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BestSellersResponse,
  type LoginResponse,
  OrderView,
  PendingApprovalsResponse,
  SubmitOrderResponse,
  TableSessionView,
  TabletOrdersResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { BestSellers } from '../../src/recommendations/best-sellers.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import {
  addDevice,
  addStaff,
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
 * Diners' orders and their approval (P3-03a): the tablet orders for its own open table, the
 * table's waiter is alerted, and a waiter (own tables), the cashier or a manager approves it,
 * changed with the diner's agreement, or rejects it; or the waiter approves on the tablet with
 * their PIN. Approved lines reach the kitchen as a staff order's do.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let otherWaiter: LoginResponse;
let cashier: LoginResponse;
let otherWaiterId: string;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const fromTablet = (name = 'tablet') => authHeaders(id(name));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const line = (name: string, quantity = 1) => ({
  clientLineId: randomUUID(),
  itemId: id(name),
  quantity,
});

async function order(lines: object[], tablet = 'tablet'): Promise<string> {
  const response = await server()
    .post('/api/v1/devices/current/orders')
    .set(fromTablet(tablet))
    .send({ idempotencyKey: randomUUID(), lines });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const placed = SubmitOrderResponse.parse(response.body);
  if (placed.status !== 'ACCEPTED') throw new Error(JSON.stringify(placed));
  expect(placed.itemState).toBe('PENDING_APPROVAL');
  return placed.orderId;
}

async function itemsOf(orderId: string) {
  return prisma.orderItem.findMany({ where: { orderId }, orderBy: { name: 'asc' } });
}

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
  waiter = await signIn(app, kit, 'WAITER');
  cashier = await signIn(app, kit, 'CASHIER');
  otherWaiterId = await addStaff(app, kit, 'WAITER', '5656');
  otherWaiter = LoginResponseOf(
    await server()
      .post('/api/v1/auth/pin-login')
      .set(authHeaders(kit.deviceId))
      .send({ staffId: otherWaiterId, pin: '5656' }),
  );
  const base = { restaurantId: kit.restaurantId };
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
  ids.station = station.id;
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
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
  for (const [name, price] of [
    ['Paneer Tikka', 28_000],
    ['Lassi', 8_000],
    ['Biryani', 32_000],
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
          trackStock: name === 'Biryani',
          ...(name === 'Biryani' && { stockLevel: { create: { ...base, quantity: 1 } } }),
        },
      })
    ).id;
  }
  const manager = await signIn(app, kit, 'MANAGER');
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const section = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: section.id, label } })
    ).id;
  }
  ids.tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: id('T1') });
  ids.tablet2 = await addDevice(app, kit, 'TABLE_TABLET', { tableId: id('T2') });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

function LoginResponseOf(response: request.Response): LoginResponse {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as LoginResponse;
}

describe('[TAB-009] [ORD-003] [ORD-005] a diner orders from the tablet', () => {
  it('needs the table open', async () => {
    const response = await server()
      .post('/api/v1/devices/current/orders')
      .set(fromTablet())
      .send({ idempotencyKey: randomUUID(), lines: [line('Lassi')] });
    expect(response.status).toBe(409);
    expect(codeOf(response)).toBe('TABLE_NOT_OPEN');
    const list = TabletOrdersResponse.parse(
      (await server().get('/api/v1/devices/current/orders').set(fromTablet())).body,
    );
    expect(list).toEqual({ tableSessionId: null, orders: [], runningTotal: 0, pendingTotal: 0 });
  });

  it('waits for the waiter, who is alerted; nothing reaches the kitchen yet', async () => {
    const opened = await server()
      .post(`/api/v1/tables/${id('T1')}/open`)
      .set(as(waiter))
      .send({ covers: 2 });
    ids.session = TableSessionView.parse(opened.body).id;
    ids.first = await order([line('Paneer Tikka', 2), line('Lassi')]);
    expect((await itemsOf(id('first'))).map((item) => item.state)).toEqual([
      'PENDING_APPROVAL',
      'PENDING_APPROVAL',
    ]);
    expect(await prisma.kot.count({ where: { orderId: id('first') } })).toBe(0);
    await until(
      async () =>
        (await prisma.alert.count({
          where: { type: 'ORDER_PENDING_APPROVAL', orderId: id('first'), status: 'OPEN' },
        })) === 1,
      5_000,
      'the approval alert',
    );
    const alert = await prisma.alert.findFirstOrThrow({ where: { orderId: id('first') } });
    expect(alert.recipientIds).toContain(kit.staff.WAITER);
    const list = TabletOrdersResponse.parse(
      (await server().get('/api/v1/devices/current/orders').set(fromTablet())).body,
    );
    expect(list).toMatchObject({ tableSessionId: id('session'), runningTotal: 0 });
    expect(list.pendingTotal).toBe(2 * 28_000 + 8_000);
  });

  it('[AUTH-009] keeps each tablet to its own table', async () => {
    const other = await server().get('/api/v1/devices/current/orders').set(fromTablet('tablet2'));
    expect(TabletOrdersResponse.parse(other.body).orders).toEqual([]);
    const atOther = await server()
      .post(`/api/v1/devices/current/orders/${id('first')}/approve`)
      .set(fromTablet('tablet2'))
      .send({ staffId: kit.staff.WAITER, pin: TEST_PINS.WAITER });
    expect(atOther.status).toBe(404);
  });
});

describe('[WTR-004] [ORD-003] approving and rejecting', () => {
  it('lists the waiting orders: a waiter their own tables, the cashier all', async () => {
    const mine = PendingApprovalsResponse.parse(
      (await server().get('/api/v1/orders/pending-approval').set(as(waiter))).body,
    );
    expect(mine.orders.map((entry) => [entry.order.id, entry.tableLabel])).toEqual([
      [id('first'), 'T1'],
    ]);
    const others = PendingApprovalsResponse.parse(
      (await server().get('/api/v1/orders/pending-approval').set(as(otherWaiter))).body,
    );
    expect(others.orders).toEqual([]);
    const all = PendingApprovalsResponse.parse(
      (await server().get('/api/v1/orders/pending-approval').set(as(cashier))).body,
    );
    expect(all.orders).toHaveLength(1);
  });

  it('changes an order only with the diner’s agreement, and only on the waiter’s own tables', async () => {
    const [firstLine] = await itemsOf(id('first'));
    const unagreed = await server()
      .post(`/api/v1/orders/${id('first')}/approve`)
      .set(as(waiter))
      .send({ changes: [{ orderItemId: firstLine?.id, quantity: 0 }] });
    expect(unagreed.status).toBe(400);
    const notMine = await server()
      .post(`/api/v1/orders/${id('first')}/approve`)
      .set(as(otherWaiter))
      .send({});
    expect(notMine.status).toBe(403);
  });

  it('[ORD-003] sends it to the kitchen with the agreed changes, and clears the alert', async () => {
    const [lassi, paneer] = await itemsOf(id('first'));
    const response = await server()
      .post(`/api/v1/orders/${id('first')}/approve`)
      .set(as(waiter))
      .send({
        changes: [
          { orderItemId: paneer?.id, quantity: 1 },
          { orderItemId: lassi?.id, quantity: 0 },
        ],
        dinerAgreed: true,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const view = OrderView.parse(response.body);
    expect(
      view.items.map((item) => [item.name, item.state, item.quantity, item.lineTotal]),
    ).toEqual(
      expect.arrayContaining([
        ['Paneer Tikka', 'SENT', 1, 28_000],
        ['Lassi', 'REJECTED', 1, 8_000],
      ]),
    );
    expect(view.kots).toHaveLength(1);
    const items = await itemsOf(id('first'));
    expect(items.find((item) => item.name === 'Paneer Tikka')?.approvedById).toBe(kit.staff.WAITER);
    expect(items.find((item) => item.name === 'Lassi')?.endReason).toMatch(/agreement/);
    await until(
      async () =>
        (await prisma.alert.count({ where: { orderId: id('first'), status: 'OPEN' } })) === 0,
      5_000,
      'the alert cleared',
    );
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ORDER_APPROVED' } });
    expect(entry).toMatchObject({ actorId: kit.staff.WAITER, entityId: id('first') });
    const list = TabletOrdersResponse.parse(
      (await server().get('/api/v1/devices/current/orders').set(fromTablet())).body,
    );
    expect(list).toMatchObject({ runningTotal: 28_000, pendingTotal: 0 });
    const again = await server()
      .post(`/api/v1/orders/${id('first')}/approve`)
      .set(as(waiter))
      .send({});
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('ORDER_NOT_PENDING');
  });

  it('[ORD-003] rejects with a reason the diner sees', async () => {
    const second = await order([line('Lassi', 3)]);
    const response = await server()
      .post(`/api/v1/orders/${second}/reject`)
      .set(as(cashier))
      .send({ reason: 'Lassi is not available tonight' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const view = OrderView.parse(response.body);
    expect(view.status).toBe('CANCELLED');
    expect(view.items.map((item) => item.state)).toEqual(['REJECTED']);
    expect((await itemsOf(second))[0]?.endReason).toBe('Lassi is not available tonight');
    expect(
      await prisma.auditLog.count({ where: { action: 'ORDER_REJECTED', entityId: second } }),
    ).toBe(1);
  });

  it('refuses an approval when a dish ran out since it was ordered', async () => {
    const third = await order([line('Biryani')]);
    await prisma.stockLevel.update({ where: { itemId: id('Biryani') }, data: { quantity: 0 } });
    const response = await server()
      .post(`/api/v1/orders/${third}/approve`)
      .set(as(cashier))
      .send({});
    expect(response.status).toBe(409);
    expect(codeOf(response)).toBe('OUT_OF_STOCK');
    await prisma.stockLevel.update({ where: { itemId: id('Biryani') }, data: { quantity: 1 } });
    ids.third = third;
  });
});

describe('[ORD-004] approve at table', () => {
  const atTable = (orderId: string, body: object) =>
    server().post(`/api/v1/devices/current/orders/${orderId}/approve`).set(fromTablet()).send(body);

  it('takes the waiter’s PIN on the tablet and sends the order', async () => {
    const wrong = await atTable(id('third'), { staffId: kit.staff.WAITER, pin: '0000' });
    expect(wrong.status).toBe(401);
    expect(
      await prisma.auditLog.count({ where: { action: 'TABLE_APPROVAL_DENIED' } }),
    ).toBeGreaterThanOrEqual(1);
    const kitchen = await atTable(id('third'), {
      staffId: kit.staff.KITCHEN,
      pin: TEST_PINS.KITCHEN,
    });
    expect(kitchen.status).toBe(403);
    const notTheirs = await atTable(id('third'), { staffId: otherWaiterId, pin: '5656' });
    expect(notTheirs.status).toBe(403);
    const response = await atTable(id('third'), {
      staffId: kit.staff.WAITER,
      pin: TEST_PINS.WAITER,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(OrderView.parse(response.body).items[0]?.state).toBe('SENT');
    // Stock was taken off at approval (MENU-006).
    expect(
      (await prisma.stockLevel.findUniqueOrThrow({ where: { itemId: id('Biryani') } })).quantity,
    ).toBe(0);
  });
});

describe('[TAB-005] bestsellers', () => {
  it('ranks what reached the kitchen, up to the setting', async () => {
    app.get(BestSellers).invalidate();
    const response = await server().get('/api/v1/menu/bestsellers').set(fromTablet());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { itemIds } = BestSellersResponse.parse(response.body);
    // Paneer and Biryani were sent; the Lassi lines were rejected.
    expect(itemIds.sort()).toEqual([id('Biryani'), id('Paneer Tikka')].sort());
    await setSetting('menu.bestSellerCount', 1);
    expect(
      BestSellersResponse.parse(
        (await server().get('/api/v1/menu/bestsellers').set(fromTablet())).body,
      ).itemIds,
    ).toHaveLength(1);
    await setSetting('menu.bestSellerCount', 0);
    expect(
      BestSellersResponse.parse(
        (await server().get('/api/v1/menu/bestsellers').set(fromTablet())).body,
      ).itemIds,
    ).toEqual([]);
  });
});
