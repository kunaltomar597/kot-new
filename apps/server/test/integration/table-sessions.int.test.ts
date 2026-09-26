import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type LoginResponse,
  TableOverviewResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbDate } from '../../src/common/business-dates.js';
import { allocateDailyNumber } from '../../src/database/numbering.js';
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
const tables: Record<string, string> = {};
let hallId: string;
let menu: { itemId: string; stationId: string; taxGroupId: string };

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
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  hallId = hall.id;
  for (const [index, label] of ['T1', 'T2', 'T3', 'T4', 'T7'].entries()) {
    tables[label] = (
      await prisma.diningTable.create({
        data: { ...base, sectionId: hall.id, label, displayOrder: index },
      })
    ).id;
  }
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
  const taxGroup = await prisma.taxGroup.create({ data: { ...base, name: 'GST 5 %' } });
  const item = await prisma.item.create({
    data: {
      ...base,
      categoryId: category.id,
      name: 'Dal Makhani',
      basePrice: 25_000,
      taxGroupId: taxGroup.id,
      foodType: 'VEG',
      stationId: station.id,
    },
  });
  menu = { itemId: item.id, stationId: station.id, taxGroupId: taxGroup.id };
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));

function open(login: LoginResponse, label: string, body: Record<string, unknown> = { covers: 2 }) {
  return server()
    .post(`/api/v1/tables/${tables[label] ?? ''}/open`)
    .set(as(login))
    .send(body);
}

async function stateOf(label: string) {
  return (await prisma.diningTable.findUniqueOrThrow({ where: { id: tables[label] ?? '' } })).state;
}

/** An order with one item in `state` (and a KOT when it was sent), as the order engine will make. */
async function order(session: TableSessionView, state: 'SENT' | 'PENDING_APPROVAL', quantity = 2) {
  const businessDate = session.businessDate;
  const created = await prisma.order.create({
    data: {
      restaurantId: kit.restaurantId,
      businessDate: dbDate(businessDate),
      orderNumber: await prisma.$transaction((tx) =>
        allocateDailyNumber(tx, { restaurantId: kit.restaurantId, businessDate, kind: 'ORDER' }),
      ),
      orderType: 'DINE_IN',
      source: state === 'SENT' ? 'POS' : 'TABLE_TABLET',
      tableSessionId: session.id,
      tableId: session.tableId,
      items: {
        create: {
          restaurantId: kit.restaurantId,
          businessDate: dbDate(businessDate),
          itemId: menu.itemId,
          name: 'Dal Makhani',
          quantity,
          unitPrice: 25_000,
          lineTotal: 25_000 * quantity,
          taxGroupId: menu.taxGroupId,
          taxRates: [],
          stationId: menu.stationId,
          state,
        },
      },
    },
  });
  if (state === 'SENT') {
    await prisma.kot.create({
      data: {
        restaurantId: kit.restaurantId,
        businessDate: dbDate(businessDate),
        kotNumber: created.orderNumber,
        orderId: created.id,
        stationId: menu.stationId,
      },
    });
  }
  return created;
}

describe('[TBL-003] [TBL-004] table sessions', () => {
  let session: TableSessionView;

  it('opens a table with covers and the assigned waiter, audited and announced', async () => {
    const today = (await prisma.restaurant.findUniqueOrThrow({ where: { id: kit.restaurantId } }))
      .businessDayCutoff;
    expect(today).toBe('04:00');
    // The hall is the waiter's today, so the cashier opening T1 gives it to the waiter.
    const put = await server()
      .put('/api/v1/waiter-assignments')
      .set(as(manager))
      .send({ assignments: [{ staffId: kit.staff.WAITER, sectionIds: [hallId], tableIds: [] }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const response = await open(cashier, 'T1', { covers: 4 });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    session = TableSessionView.parse(response.body);
    expect(session).toMatchObject({
      tableLabel: 'T1',
      state: 'OCCUPIED',
      status: 'OPEN',
      covers: 4,
      waiterId: kit.staff.WAITER,
      waiterName: 'Test waiter',
    });
    expect(await stateOf('T1')).toBe('OCCUPIED');
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'TABLE_OPENED' } }),
    ).toMatchObject({ actorId: kit.staff.CASHIER, entityId: session.id });
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: session.id },
      orderBy: { writeOrder: 'asc' },
    });
    expect(events.map((event) => event.eventType)).toEqual(['TableOpened', 'TableStateChanged']);
  });

  it('refuses a second open of an occupied table, kitchen staff and unknown tables', async () => {
    const again = await open(manager, 'T1');
    expect([again.status, codeOf(again)]).toEqual([409, 'TABLE_NOT_FREE']);
    expect((await open(kitchen, 'T2')).status).toBe(403);
    const unknown = await server()
      .post('/api/v1/tables/01926a3e-0000-7000-8000-00000000000b/open')
      .set(as(manager))
      .send({ covers: 2 });
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'TABLE_NOT_FOUND']);
    const badWaiter = await open(manager, 'T2', { covers: 2, waiterId: kit.staff.KITCHEN });
    expect([badWaiter.status, codeOf(badWaiter)]).toEqual([422, 'STAFF_NOT_ASSIGNABLE']);
  });

  it('lets exactly one of two devices open the same table at once', async () => {
    const [first, second] = await Promise.all([open(waiter, 'T3'), open(cashier, 'T3')]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(await prisma.tableSession.count({ where: { tableId: tables.T3, status: 'OPEN' } })).toBe(
      1,
    );
  });

  it('follows the table state machine: bill requested, more items, invalid moves refused', async () => {
    const requested = await server()
      .post(`/api/v1/table-sessions/${session.id}/request-bill`)
      .set(as(waiter));
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect(TableSessionView.parse(requested.body).state).toBe('BILL_REQUESTED');
    expect(await stateOf('T1')).toBe('BILL_REQUESTED');
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: 'BillRequested', aggregateId: session.id },
      }),
    ).toBe(1);

    // The bill cannot be requested twice, and a table with the bill asked for cannot be closed.
    const twice = await server()
      .post(`/api/v1/table-sessions/${session.id}/request-bill`)
      .set(as(waiter));
    expect([twice.status, codeOf(twice)]).toEqual([409, 'INVALID_TRANSITION']);
    const close = await server()
      .post(`/api/v1/table-sessions/${session.id}/close-without-bill`)
      .set(as(cashier))
      .send({ reason: 'Guests left' });
    expect([close.status, codeOf(close)]).toEqual([409, 'INVALID_TRANSITION']);
    await prisma.diningTable.update({ where: { id: tables.T1 }, data: { state: 'OCCUPIED' } });
  });

  it('closes a table opened by mistake only while nothing is ordered', async () => {
    const opened = TableSessionView.parse((await open(waiter, 'T2')).body);
    await order(opened, 'PENDING_APPROVAL');
    const close = () =>
      server()
        .post(`/api/v1/table-sessions/${opened.id}/close-without-bill`)
        .set(as(waiter))
        .send({ reason: 'Opened the wrong table' });
    const refused = await close();
    expect([refused.status, codeOf(refused)]).toEqual([409, 'TABLE_HAS_ITEMS']);

    await prisma.orderItem.updateMany({
      where: { order: { tableSessionId: opened.id } },
      data: { state: 'REJECTED' },
    });
    const closed = await close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(TableSessionView.parse(closed.body)).toMatchObject({
      status: 'CLOSED',
      state: 'FREE',
      closeReason: 'Opened the wrong table',
    });
    expect(await stateOf('T2')).toBe('FREE');
    expect(await prisma.auditLog.count({ where: { action: 'TABLE_CLOSED_WITHOUT_BILL' } })).toBe(1);
    // A closed session is not found for further changes.
    const after = await close();
    expect([after.status, codeOf(after)]).toEqual([404, 'TABLE_SESSION_NOT_FOUND']);
  });

  it('hands an open table to another waiter (managers only), audited', async () => {
    const byWaiter = await server()
      .put(`/api/v1/table-sessions/${session.id}/waiter`)
      .set(as(waiter))
      .send({ waiterId: kit.staff.CASHIER });
    expect(byWaiter.status).toBe(403);
    const changed = await server()
      .put(`/api/v1/table-sessions/${session.id}/waiter`)
      .set(as(manager))
      .send({ waiterId: kit.staff.CASHIER, reason: 'Shift change' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(TableSessionView.parse(changed.body).waiterId).toBe(kit.staff.CASHIER);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'TableWaiterChanged' } })).toBe(1);
    await server()
      .put(`/api/v1/table-sessions/${session.id}/waiter`)
      .set(as(manager))
      .send({ waiterId: kit.staff.WAITER });
  });
});

describe('[TBL-005] [WTR-008] move table (scenario S7)', () => {
  it('moves the session, its orders and tickets to a free table without new tickets', async () => {
    const session = TableSessionView.parse((await open(waiter, 'T4')).body);
    const sent = await order(session, 'SENT');
    const kotsBefore = await prisma.kot.count();

    const occupied = await server()
      .post(`/api/v1/table-sessions/${session.id}/move`)
      .set(as(waiter))
      .send({ toTableId: tables.T1 });
    expect([occupied.status, codeOf(occupied)]).toEqual([409, 'TABLE_NOT_FREE']);

    const moved = await server()
      .post(`/api/v1/table-sessions/${session.id}/move`)
      .set(as(waiter))
      .send({ toTableId: tables.T7 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(TableSessionView.parse(moved.body)).toMatchObject({
      tableId: tables.T7,
      tableLabel: 'T7',
      state: 'OCCUPIED',
    });
    expect([await stateOf('T4'), await stateOf('T7')]).toEqual(['FREE', 'OCCUPIED']);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: sent.id } })).tableId).toBe(
      tables.T7,
    );
    expect(await prisma.kot.count()).toBe(kotsBefore);

    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'TableMoved' } });
    expect(event.payload).toMatchObject({
      payload: { tableSessionId: session.id, fromTableId: tables.T4, toTableId: tables.T7 },
    });
    // The kitchen station holding its tickets hears about the move.
    expect(event.audience).toMatchObject({ stationIds: [menu.stationId] });
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'TABLE_MOVED' } }),
    ).toMatchObject({
      before: { tableLabel: 'T4' },
      after: { tableLabel: 'T7' },
    });
  });

  it('lets a waiter move only their own tables', async () => {
    const theirs = TableSessionView.parse(
      (await open(manager, 'T4', { covers: 2, waiterId: kit.staff.CASHIER })).body,
    );
    const refused = await server()
      .post(`/api/v1/table-sessions/${theirs.id}/move`)
      .set(as(waiter))
      .send({ toTableId: tables.T2 });
    expect([refused.status, codeOf(refused)]).toEqual([403, 'FORBIDDEN']);
    const byCashier = await server()
      .post(`/api/v1/table-sessions/${theirs.id}/move`)
      .set(as(cashier))
      .send({ toTableId: tables.T2 });
    expect(byCashier.status).toBe(200);
  });
});

describe('[TBL-007] table overview', () => {
  it('shows every active table with its session, waiter and amount so far', async () => {
    const response = await server().get('/api/v1/tables/overview').set(as(waiter));
    expect(response.status).toBe(200);
    const { tables: overview } = TableOverviewResponse.parse(response.body);
    expect(overview.map((table) => [table.label, table.state])).toEqual([
      ['T1', 'OCCUPIED'],
      ['T2', 'OCCUPIED'],
      ['T3', 'OCCUPIED'],
      ['T4', 'FREE'],
      ['T7', 'OCCUPIED'],
    ]);
    const t7 = overview.find((table) => table.label === 'T7');
    expect(t7?.session).toMatchObject({
      covers: 2,
      waiterName: 'Test waiter',
      amountSoFar: 50_000,
      pendingApprovals: 0,
    });
    expect(overview.find((table) => table.label === 'T4')?.session).toBeNull();
  });
});
