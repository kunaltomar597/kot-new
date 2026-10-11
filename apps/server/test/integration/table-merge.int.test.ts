import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  KdsTicketsResponse,
  type LoginResponse,
  OrderView,
  SubmitOrderResponse,
  TableSessionView,
  TableStateView,
  TransferItemsResponse,
} from '@rp/contracts';
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
let waiter: LoginResponse;
let cashier: LoginResponse;
let kitchen: LoginResponse;
let manager: LoginResponse;
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
    ['Lassi', 8_000],
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
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) {
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

async function open(label: string, login = waiter, covers = 2): Promise<TableSessionView> {
  const response = await server()
    .post(`/api/v1/tables/${id(label)}/open`)
    .set(as(login))
    .send({ covers });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return TableSessionView.parse(response.body);
}

async function order(session: TableSessionView, lines: object[]): Promise<OrderView> {
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

const lineOf = (placed: OrderView, itemId: string) =>
  placed.items.find((item) => item.itemId === itemId && item.parentOrderItemId === null)?.id ?? '';

async function stateOf(label: string) {
  return (await prisma.diningTable.findUniqueOrThrow({ where: { id: id(label) } })).state;
}

async function tickets() {
  const response = await server()
    .get('/api/v1/kds/tickets')
    .query({ stationId: id('kitchen') })
    .set(as(kitchen));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return KdsTicketsResponse.parse(response.body).tickets;
}

const merge = (from: TableSessionView, into: TableSessionView, login = cashier) =>
  server()
    .post(`/api/v1/table-sessions/${from.id}/merge`)
    .set(as(login))
    .send({ intoTableSessionId: into.id });

const transfer = (from: TableSessionView, body: object, login = cashier) =>
  server().post(`/api/v1/table-sessions/${from.id}/transfer`).set(as(login)).send(body);

describe('[TBL-006] merging tables into one bill', () => {
  it('moves orders, tickets and guests to the other table and closes this one, audited', async () => {
    const t1 = await open('T1');
    const t2 = await open('T2', waiter, 3);
    await order(t1, [{ itemId: id('Dal') }]);
    const second = await order(t2, [{ itemId: id('Thali') }, { itemId: id('Lassi') }]);

    expect([(await merge(t2, t2)).status, codeOf(await merge(t2, t2))]).toEqual([
      409,
      'TABLE_SAME',
    ]);
    const merged = await merge(t2, t1);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(TableSessionView.parse(merged.body)).toMatchObject({
      id: t1.id,
      tableLabel: 'T1',
      covers: 5,
      state: 'OCCUPIED',
    });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
      tableSessionId: t1.id,
      tableId: id('T1'),
    });
    expect(await prisma.tableSession.findUniqueOrThrow({ where: { id: t2.id } })).toMatchObject({
      status: 'CLOSED',
      closeReason: 'Merged into T1',
      mergedIntoSessionId: t1.id,
    });
    expect([await stateOf('T1'), await stateOf('T2')]).toEqual(['OCCUPIED', 'FREE']);

    // One bill for both: the overview shows T1 with everything, T2 free.
    const overview = (await server().get('/api/v1/tables/overview').set(as(cashier))).body as {
      tables: { label: string; session: { amountSoFar: number } | null }[];
    };
    expect(overview.tables.find((table) => table.label === 'T1')?.session?.amountSoFar).toBe(
      18_000 + 30_000 + 8_000,
    );
    expect(overview.tables.find((table) => table.label === 'T2')?.session).toBeNull();

    // The kitchen's ticket for T2's order now says T1, moved from T2; the printer got a note.
    const ticket = (await tickets()).find((entry) => entry.orderId === second.id);
    expect(ticket).toMatchObject({ tableLabel: 'T1', movedFrom: 'T2' });
    expect(await prisma.printNotice.findFirstOrThrow({ where: { title: 'MERGED' } })).toMatchObject(
      {
        stationId: id('kitchen'),
        lines: ['T2 joined T1', `Orders ${String(second.orderNumber)}`],
      },
    );

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'OrdersMoved' },
    });
    expect(event.payload).toMatchObject({
      payload: { kind: 'MERGE', fromTableId: id('T2'), toTableId: id('T1'), orderIds: [second.id] },
    });
    expect(event.audience).toMatchObject({ stationIds: [id('kitchen')] });
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'TABLES_MERGED' } }),
    ).toMatchObject({
      entityId: t2.id,
      before: { tableLabel: 'T2', covers: 3 },
      after: { tableLabel: 'T1', covers: 5, orderIds: [second.id] },
    });
    expect(await prisma.outboxEvent.count({ where: { eventType: 'TableClosed' } })).toBe(1);
  });

  it('lets a waiter merge only their own tables, and never into a closed session', async () => {
    const mine = await open('T3');
    const theirs = await open('T4', manager);
    await prisma.tableSession.update({
      where: { id: theirs.id },
      data: { waiterId: kit.staff.CASHIER },
    });
    const refused = await merge(mine, theirs, waiter);
    expect([refused.status, codeOf(refused)]).toEqual([403, 'FORBIDDEN']);
    expect((await merge(mine, theirs, kitchen)).status).toBe(403);
    const closed = await prisma.tableSession.findFirstOrThrow({ where: { status: 'CLOSED' } });
    const gone = await server()
      .post(`/api/v1/table-sessions/${mine.id}/merge`)
      .set(as(cashier))
      .send({ intoTableSessionId: closed.id });
    expect([gone.status, codeOf(gone)]).toEqual([404, 'TABLE_SESSION_NOT_FOUND']);
    expect((await merge(mine, theirs)).status).toBe(200);
  });
});

describe('[TBL-006] moving dishes to another table', () => {
  it('moves whole lines with their combo parts; the kitchen sees where they go now', async () => {
    const t5 = await open('T5');
    const t6 = await open('T6');
    const placed = await order(t5, [
      { itemId: id('Thali') },
      { itemId: id('Lassi') },
      { itemId: id('Dal') },
    ]);
    const thali = lineOf(placed, id('Thali'));
    const part = placed.items.find((item) => item.parentOrderItemId === thali)?.id ?? '';

    const partOnly = await transfer(t5, { toTableSessionId: t6.id, orderItemIds: [part] });
    expect([partOnly.status, codeOf(partOnly)]).toEqual([409, 'ITEM_NOT_MOVABLE']);
    const elsewhere = await transfer(t6, { toTableSessionId: t5.id, orderItemIds: [thali] });
    expect([elsewhere.status, codeOf(elsewhere)]).toEqual([404, 'ORDER_ITEM_NOT_FOUND']);

    const moved = await transfer(t5, {
      toTableSessionId: t6.id,
      orderItemIds: [thali, lineOf(placed, id('Lassi'))],
      reason: 'Friend joined T6',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const result = TransferItemsResponse.parse(moved.body);
    expect(result.orderItemIds).toHaveLength(2 + 2);
    expect([result.from.tableLabel, result.to.tableLabel]).toEqual(['T5', 'T6']);

    // The dal stays on T5's order; the rest is a new order at T6 by the same waiter.
    const atT6 = await prisma.order.findMany({ where: { tableSessionId: t6.id } });
    expect(atT6).toHaveLength(1);
    expect(atT6[0]).toMatchObject({
      tableId: id('T6'),
      source: 'WAITER_APP',
      createdById: kit.staff.WAITER,
      notes: 'Moved from T5',
    });
    const left = await prisma.orderItem.findMany({ where: { orderId: placed.id } });
    expect(left.map((item) => item.name)).toEqual(['Dal']);

    // The ticket stays as it was raised, each moved dish saying where it goes now.
    const ticket = (await tickets()).find((entry) => entry.orderId === placed.id);
    expect(ticket?.tableLabel).toBe('T5');
    expect(ticket?.lines.map((line) => [line.name, line.movedTo])).toEqual(
      expect.arrayContaining([
        ['Dal', null],
        ['Lassi', 'T6'],
        ['Dal', 'T6'],
        ['Roti', 'T6'],
      ]),
    );
    const notice = await prisma.printNotice.findFirstOrThrow({ where: { title: 'MOVED' } });
    expect(notice.lines).toEqual(expect.arrayContaining(['T5 to T6', '1 × Thali', '1 × Lassi']));
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'ITEMS_TRANSFERRED' } }),
    ).toMatchObject({ reason: 'Friend joined T6', after: { tableLabel: 'T6' } });
  });

  it('moves a whole order when every dish goes, and refuses dishes that cannot move', async () => {
    const t5 = await prisma.tableSession.findFirstOrThrow({
      where: { tableId: id('T5'), status: 'OPEN' },
    });
    const t6 = await prisma.tableSession.findFirstOrThrow({
      where: { tableId: id('T6'), status: 'OPEN' },
    });
    const from = { id: t5.id } as TableSessionView;
    const dal = await prisma.orderItem.findFirstOrThrow({
      where: { order: { tableSessionId: t5.id }, name: 'Dal', parentOrderItemId: null },
    });
    await prisma.orderItem.update({
      where: { id: dal.id },
      data: { state: 'CANCELLED', endedAt: new Date(), endReason: 'Changed mind' },
    });
    const ended = await transfer(from, { toTableSessionId: t6.id, orderItemIds: [dal.id] });
    expect([ended.status, codeOf(ended)]).toEqual([409, 'ITEM_NOT_MOVABLE']);
    await prisma.orderItem.update({
      where: { id: dal.id },
      data: { state: 'SENT', endedAt: null, endReason: null },
    });
    await prisma.diningTable.update({ where: { id: id('T6') }, data: { state: 'BILL_PRINTED' } });
    const printed = await transfer(from, { toTableSessionId: t6.id, orderItemIds: [dal.id] });
    expect([printed.status, codeOf(printed)]).toEqual([409, 'TABLE_BILL_PRINTED']);
    await prisma.diningTable.update({ where: { id: id('T6') }, data: { state: 'OCCUPIED' } });

    const whole = await transfer(from, { toTableSessionId: t6.id, orderItemIds: [dal.id] });
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: dal.id } })).orderId).toBe(
      dal.orderId,
    );
    expect(await prisma.order.findUniqueOrThrow({ where: { id: dal.orderId } })).toMatchObject({
      tableSessionId: t6.id,
      tableId: id('T6'),
    });
  });
});

describe('[TBL-004] "Needs cleaning"', () => {
  it('when on, a table the guests left waits to be marked clean before it opens again', async () => {
    const setting = (value: boolean) =>
      server()
        .put('/api/v1/settings/tables.needsCleaning')
        .set(as(manager))
        .send({ value, reason: 'Clean tables first' });
    const notDirty = await server()
      .post(`/api/v1/tables/${id('T2')}/clean`)
      .set(as(waiter));
    expect([notDirty.status, codeOf(notDirty)]).toEqual([409, 'TABLE_NOT_WAITING_FOR_CLEANING']);

    expect((await setting(true)).status).toBe(200);
    const t2 = await open('T2');
    const closed = await server()
      .post(`/api/v1/table-sessions/${t2.id}/close-without-bill`)
      .set(as(waiter))
      .send({ reason: 'Opened by mistake' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await stateOf('T2')).toBe('NEEDS_CLEANING');
    const reopen = await server()
      .post(`/api/v1/tables/${id('T2')}/open`)
      .set(as(waiter))
      .send({ covers: 2 });
    expect([reopen.status, codeOf(reopen)]).toEqual([409, 'TABLE_NEEDS_CLEANING']);

    // Merged away: the table the guests left needs cleaning too.
    const t5 = await prisma.tableSession.findFirstOrThrow({
      where: { tableId: id('T5'), status: 'OPEN' },
      include: { table: true },
    });
    const t6 = await prisma.tableSession.findFirstOrThrow({
      where: { tableId: id('T6'), status: 'OPEN' },
    });
    expect(
      (
        await server()
          .post(`/api/v1/table-sessions/${t5.id}/merge`)
          .set(as(cashier))
          .send({ intoTableSessionId: t6.id })
      ).status,
    ).toBe(200);
    expect(await stateOf('T5')).toBe('NEEDS_CLEANING');

    expect(
      (
        await server()
          .post(`/api/v1/tables/${id('T2')}/clean`)
          .set(as(kitchen))
      ).status,
    ).toBe(403);
    const cleaned = await server()
      .post(`/api/v1/tables/${id('T2')}/clean`)
      .set(as(waiter));
    expect(cleaned.status, JSON.stringify(cleaned.body)).toBe(200);
    expect(TableStateView.parse(cleaned.body)).toEqual({ tableId: id('T2'), state: 'FREE' });
    expect(await prisma.auditLog.count({ where: { action: 'TABLE_CLEANED' } })).toBe(1);
    expect((await open('T2')).state).toBe('OCCUPIED');
    expect((await setting(false)).status).toBe(200);
  });
});
