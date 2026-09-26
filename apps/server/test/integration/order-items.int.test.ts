import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type LoginResponse,
  OrderView,
  OverrideResponse,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
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
let waiter: LoginResponse;
let cashier: LoginResponse;
let kitchen: LoginResponse;
let manager: LoginResponse;
let session: TableSessionView;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  cashier = await signIn(app, kit, 'CASHIER');
  kitchen = await signIn(app, kit, 'KITCHEN');
  manager = await signIn(app, kit, 'MANAGER');
  const base = { restaurantId: kit.restaurantId };
  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  ids.kitchen = (
    await prisma.station.create({ data: { ...base, name: 'Kitchen', mode: 'BOTH' } })
  ).id;
  const tax = await prisma.taxGroup.create({ data: { ...base, name: 'Nil' } });
  for (const [name, price] of [
    ['Dal', 18_000],
    ['Roti', 3_000],
    ['Thali', 30_000],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: tax.id,
          foodType: 'VEG',
          stationId: id('kitchen'),
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
  await prisma.item.update({ where: { id: id('Dal') }, data: { trackStock: true } });
  await prisma.stockLevel.create({ data: { ...base, itemId: id('Dal'), quantity: 20 } });
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  const table = await prisma.diningTable.create({
    data: { ...base, sectionId: hall.id, label: 'T1' },
  });
  session = TableSessionView.parse(
    (await server().post(`/api/v1/tables/${table.id}/open`).set(as(waiter)).send({ covers: 2 }))
      .body,
  );
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));

async function order(lines: object[]): Promise<OrderView> {
  const response = await server()
    .post('/api/v1/orders')
    .set(as(waiter))
    .send({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: lines.map((line) => ({ clientLineId: randomUUID(), quantity: 1, ...line })),
    });
  const result = SubmitOrderResponse.parse(response.body);
  if (result.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return OrderView.parse(
    (await server().get(`/api/v1/orders/${result.orderId}`).set(as(waiter))).body,
  );
}

const step = (login: LoginResponse, orderItemId: string, event: string) =>
  server().post(`/api/v1/order-items/${orderItemId}/status`).set(as(login)).send({ event });

async function stock() {
  return (await prisma.stockLevel.findUniqueOrThrow({ where: { itemId: id('Dal') } })).quantity;
}

async function kotKinds(orderId: string) {
  return (await prisma.kot.findMany({ where: { orderId }, orderBy: { kotNumber: 'asc' } })).map(
    (kot) => kot.kind,
  );
}

describe('[ORD-010] item status', () => {
  it('lets the kitchen prepare and ready items and the floor serve them, each by its grant', async () => {
    const placed = await order([{ itemId: id('Dal') }]);
    const dal = placed.items[0]?.id ?? '';
    const byWaiter = await step(waiter, dal, 'START_PREPARING');
    expect([byWaiter.status, codeOf(byWaiter)]).toEqual([403, 'FORBIDDEN']);

    expect((await step(kitchen, dal, 'START_PREPARING')).status).toBe(200);
    const ready = await step(kitchen, dal, 'MARK_READY');
    expect(OrderView.parse(ready.body).items[0]?.state).toBe('READY');
    const byKitchen = await step(kitchen, dal, 'SERVE');
    expect([byKitchen.status, codeOf(byKitchen)]).toEqual([403, 'FORBIDDEN']);
    const served = await step(waiter, dal, 'SERVE');
    expect(OrderView.parse(served.body).items[0]?.state).toBe('SERVED');
    // Serving straight from READY records the implied pick-up time (ADR-0006).
    const row = await prisma.orderItem.findUniqueOrThrow({ where: { id: dal } });
    expect(row.pickedUpAt).not.toBeNull();

    const backwards = await step(kitchen, dal, 'MARK_READY');
    expect([backwards.status, codeOf(backwards)]).toEqual([409, 'INVALID_TRANSITION']);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'ItemStatusChanged' } })).toBe(3);
  });

  it('moves the parts of a combo with the combo line', async () => {
    const placed = await order([{ itemId: id('Thali') }]);
    const thali = placed.items.find((item) => item.name === 'Thali');
    const response = await step(kitchen, thali?.id ?? '', 'MARK_READY');
    expect(OrderView.parse(response.body).items.map((item) => item.state)).toEqual([
      'READY',
      'READY',
      'READY',
    ]);
  });
});

describe('[ORD-011] [ORD-012] cancel, void and modify', () => {
  it('cancels an item not yet started, with a CANCELLED slip and the stock back', async () => {
    const before = await stock();
    const placed = await order([{ itemId: id('Dal'), quantity: 3 }]);
    expect(await stock()).toBe(before - 3);
    const dal = placed.items[0]?.id ?? '';
    const cancelled = await server()
      .post(`/api/v1/order-items/${dal}/cancel`)
      .set(as(waiter))
      .send({ reason: 'Guest changed mind' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(OrderView.parse(cancelled.body).items[0]?.state).toBe('CANCELLED');
    expect(await kotKinds(placed.id)).toEqual(['NEW', 'CANCELLED']);
    expect(await stock()).toBe(before);
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'ORDER_ITEM_CANCELLED' } }),
    ).toMatchObject({ reason: 'Guest changed mind', actorId: kit.staff.WAITER });
  });

  it('refuses a cancel once cooking started, and a waiter cancelling another waiter’s table', async () => {
    const placed = await order([{ itemId: id('Roti') }]);
    const roti = placed.items[0]?.id ?? '';
    await step(kitchen, roti, 'START_PREPARING');
    const started = await server()
      .post(`/api/v1/order-items/${roti}/cancel`)
      .set(as(waiter))
      .send({ reason: 'Too slow' });
    expect([started.status, codeOf(started)]).toEqual([409, 'INVALID_TRANSITION']);

    const other = await order([{ itemId: id('Roti') }]);
    await prisma.tableSession.update({
      where: { id: session.id },
      data: { waiterId: kit.staff.CASHIER },
    });
    const notTheirs = await server()
      .post(`/api/v1/order-items/${other.items[0]?.id ?? ''}/cancel`)
      .set(as(waiter))
      .send({ reason: 'Wrong item' });
    expect([notTheirs.status, codeOf(notTheirs)]).toEqual([403, 'FORBIDDEN']);
    await prisma.tableSession.update({
      where: { id: session.id },
      data: { waiterId: kit.staff.WAITER },
    });
  });

  it("voids an item in preparation only with a manager's approval, recorded with the approver", async () => {
    const placed = await order([{ itemId: id('Roti'), quantity: 2 }]);
    const roti = placed.items[0]?.id ?? '';
    const notStarted = await server()
      .post(`/api/v1/order-items/${roti}/void`)
      .set(as(manager))
      .send({ reason: 'Burnt' });
    expect([notStarted.status, codeOf(notStarted)]).toEqual([409, 'ITEM_NOT_STARTED']);
    await step(kitchen, roti, 'START_PREPARING');

    const withoutPin = await server()
      .post(`/api/v1/order-items/${roti}/void`)
      .set(as(cashier))
      .send({ reason: 'Burnt' });
    expect([withoutPin.status, codeOf(withoutPin)]).toEqual([403, 'OVERRIDE_REQUIRED']);

    const override = OverrideResponse.parse(
      (
        await server().post('/api/v1/auth/override').set(as(cashier)).send({
          approverStaffId: kit.staff.MANAGER,
          pin: TEST_PINS.MANAGER,
          capability: 'ITEM_VOID_AFTER_PREP',
        })
      ).body,
    );
    const voided = await server()
      .post(`/api/v1/order-items/${roti}/void`)
      .set({ ...as(cashier), 'x-override-token': override.overrideToken })
      .send({ reason: 'Burnt' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(OrderView.parse(voided.body).items[0]?.state).toBe('VOIDED');
    expect(await kotKinds(placed.id)).toEqual(['NEW', 'CANCELLED']);
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'ORDER_ITEM_VOIDED' } }),
    ).toMatchObject({ actorId: kit.staff.CASHIER, approverId: kit.staff.MANAGER, reason: 'Burnt' });
  });

  it('changes quantity and instructions before cooking with a MODIFIED ticket, and follows stock', async () => {
    const before = await stock();
    const placed = await order([{ itemId: id('Dal'), quantity: 2 }]);
    const dal = placed.items[0]?.id ?? '';
    const changed = await server()
      .patch(`/api/v1/order-items/${dal}`)
      .set(as(waiter))
      .send({ quantity: 4, instructions: 'No butter' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(OrderView.parse(changed.body).items[0]).toMatchObject({
      quantity: 4,
      lineTotal: 72_000,
      instructions: 'No butter',
    });
    expect(await stock()).toBe(before - 4);
    expect(await kotKinds(placed.id)).toEqual(['NEW', 'MODIFIED']);
    const modified = await prisma.kot.findFirstOrThrow({
      where: { orderId: placed.id, kind: 'MODIFIED' },
      include: { lines: true },
    });
    expect(modified.lines.map((line) => line.quantity)).toEqual([4]);

    const smaller = await server()
      .patch(`/api/v1/order-items/${dal}`)
      .set(as(waiter))
      .send({ quantity: 1 });
    expect(smaller.status).toBe(200);
    expect(await stock()).toBe(before - 1);
    expect(await prisma.auditLog.count({ where: { action: 'ORDER_ITEM_MODIFIED' } })).toBe(2);

    await step(kitchen, dal, 'START_PREPARING');
    const late = await server()
      .patch(`/api/v1/order-items/${dal}`)
      .set(as(waiter))
      .send({ quantity: 2 });
    expect([late.status, codeOf(late)]).toEqual([409, 'ITEM_ALREADY_STARTED']);
  });

  it('treats a combo as one line: parts cannot be cancelled alone, the combo cancels them all', async () => {
    const placed = await order([{ itemId: id('Thali') }]);
    const thali = placed.items.find((item) => item.name === 'Thali');
    const part = placed.items.find((item) => item.parentOrderItemId !== null);
    const alone = await server()
      .post(`/api/v1/order-items/${part?.id ?? ''}/cancel`)
      .set(as(waiter))
      .send({ reason: 'No dal' });
    expect([alone.status, codeOf(alone)]).toEqual([409, 'COMBO_PART']);
    const modify = await server()
      .patch(`/api/v1/order-items/${thali?.id ?? ''}`)
      .set(as(waiter))
      .send({ quantity: 2 });
    expect([modify.status, codeOf(modify)]).toEqual([409, 'COMBO_NOT_MODIFIABLE']);

    const before = await stock();
    const cancelled = await server()
      .post(`/api/v1/order-items/${thali?.id ?? ''}/cancel`)
      .set(as(waiter))
      .send({ reason: 'Guest left' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(OrderView.parse(cancelled.body).items.map((item) => item.state)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
    ]);
    // The Dal part's portion goes back to stock; one CANCELLED slip lists both parts.
    expect(await stock()).toBe(before + 1);
    const slip = await prisma.kot.findFirstOrThrow({
      where: { orderId: placed.id, kind: 'CANCELLED' },
      include: { lines: true },
    });
    expect(slip.lines).toHaveLength(2);
  });
});
