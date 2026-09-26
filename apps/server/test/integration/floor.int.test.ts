import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  FloorResponse,
  type LoginResponse,
  SectionView,
  TableView,
  WaiterAssignmentsResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbDate } from '../../src/common/business-dates.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { WaiterAssignmentsService } from '../../src/floor/waiter-assignments.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
let cashier: LoginResponse;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  cashier = await signIn(app, kit, 'CASHIER');
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));

let hall: SectionView;
let terrace: SectionView;
let t1: TableView;
let t2: TableView;
let t7: TableView;

async function addTable(label: string, sectionId: string, displayOrder = 0) {
  const response = await server()
    .post('/api/v1/tables')
    .set(as(manager))
    .send({ label, capacity: 4, sectionId, displayOrder });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return TableView.parse(response.body);
}

describe('[TBL-001] sections and tables', () => {
  it('lets managers lay out the floor, audited', async () => {
    const byWaiter = await server()
      .post('/api/v1/sections')
      .set(as(waiter))
      .send({ name: 'Main hall', displayOrder: 1 });
    expect(byWaiter.status).toBe(403);

    const created = await server()
      .post('/api/v1/sections')
      .set(as(manager))
      .send({ name: 'Main hall', displayOrder: 1 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    hall = SectionView.parse(created.body);
    terrace = SectionView.parse(
      (
        await server()
          .post('/api/v1/sections')
          .set(as(manager))
          .send({ name: 'Terrace', displayOrder: 2 })
      ).body,
    );
    t1 = await addTable('T1', hall.id, 1);
    t2 = await addTable('T2', hall.id, 2);
    t7 = await addTable('T7', terrace.id, 1);

    expect(
      await prisma.auditLog.count({
        where: { action: { in: ['SECTION_CREATED', 'TABLE_CREATED'] } },
      }),
    ).toBe(5);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'RestaurantChanged' } })).toBe(5);

    const floor = FloorResponse.parse((await server().get('/api/v1/floor').set(as(waiter))).body);
    expect(floor.sections.map((section) => section.name)).toEqual(['Main hall', 'Terrace']);
    expect(floor.sections[0]?.tables.map((table) => [table.label, table.state])).toEqual([
      ['T1', 'FREE'],
      ['T2', 'FREE'],
    ]);
  });

  it('keeps section names and table labels unambiguous', async () => {
    const section = await server()
      .post('/api/v1/sections')
      .set(as(manager))
      .send({ name: 'main HALL', displayOrder: 3 });
    expect([section.status, codeOf(section)]).toEqual([409, 'SECTION_NAME_TAKEN']);
    const table = await server()
      .post('/api/v1/tables')
      .set(as(manager))
      .send({ label: 't1', capacity: 2, sectionId: terrace.id, displayOrder: 0 });
    expect([table.status, codeOf(table)]).toEqual([409, 'TABLE_LABEL_TAKEN']);
  });

  it('moves, relabels and resizes a table; a repeat changes nothing', async () => {
    const body = { label: 'T2A', capacity: 6, sectionId: terrace.id, displayOrder: 5 };
    const moved = await server().put(`/api/v1/tables/${t2.id}`).set(as(manager)).send(body);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(TableView.parse(moved.body)).toMatchObject(body);
    const audits = await prisma.auditLog.count({ where: { action: 'TABLE_CHANGED' } });
    expect((await server().put(`/api/v1/tables/${t2.id}`).set(as(manager)).send(body)).status).toBe(
      200,
    );
    expect(await prisma.auditLog.count({ where: { action: 'TABLE_CHANGED' } })).toBe(audits);
    const back = { label: 'T2', capacity: 4, sectionId: hall.id, displayOrder: 2 };
    expect((await server().put(`/api/v1/tables/${t2.id}`).set(as(manager)).send(back)).status).toBe(
      200,
    );
  });

  it('archives only a free table without a tablet, and restores it', async () => {
    const archive = (id: string) =>
      server().post(`/api/v1/tables/${id}/archive`).set(as(manager)).send({ reason: 'Broken leg' });

    await prisma.diningTable.update({ where: { id: t1.id }, data: { state: 'OCCUPIED' } });
    const busy = await archive(t1.id);
    expect([busy.status, codeOf(busy)]).toEqual([409, 'TABLE_IN_USE']);
    await prisma.diningTable.update({ where: { id: t1.id }, data: { state: 'FREE' } });

    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: t1.id });
    const paired = await archive(t1.id);
    expect([paired.status, codeOf(paired)]).toEqual([409, 'TABLE_HAS_TABLET']);
    const floor = FloorResponse.parse((await server().get('/api/v1/floor').set(as(waiter))).body);
    expect(floor.sections[0]?.tables[0]?.tabletDeviceIds).toEqual([tablet]);

    const archived = await archive(t2.id);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(TableView.parse(archived.body).archivedAt).not.toBeNull();
    // Its label stays taken: restore it instead of adding a new T2.
    const again = await addTableRaw('T2', hall.id);
    expect([again.status, codeOf(again)]).toEqual([409, 'TABLE_LABEL_TAKEN']);
    const changed = await server()
      .put(`/api/v1/tables/${t2.id}`)
      .set(as(manager))
      .send({ label: 'T2', capacity: 4, sectionId: hall.id, displayOrder: 2 });
    expect([changed.status, codeOf(changed)]).toEqual([409, 'TABLE_ARCHIVED']);
    const restored = await server().post(`/api/v1/tables/${t2.id}/restore`).set(as(manager));
    expect(restored.status).toBe(200);
    expect(TableView.parse(restored.body).archivedAt).toBeNull();
    expect(await prisma.diningTable.count()).toBe(3);
  });

  it('archives a section only when it has no tables left', async () => {
    const full = await server()
      .post(`/api/v1/sections/${terrace.id}/archive`)
      .set(as(manager))
      .send({ reason: 'Monsoon' });
    expect([full.status, codeOf(full)]).toEqual([409, 'SECTION_NOT_EMPTY']);

    await server()
      .post(`/api/v1/tables/${t7.id}/archive`)
      .set(as(manager))
      .send({ reason: 'Monsoon' });
    const archived = await server()
      .post(`/api/v1/sections/${terrace.id}/archive`)
      .set(as(manager))
      .send({ reason: 'Monsoon' });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);

    const inArchived = await addTableRaw('T8', terrace.id);
    expect([inArchived.status, codeOf(inArchived)]).toEqual([422, 'SECTION_NOT_FOUND']);
    const table = await server().post(`/api/v1/tables/${t7.id}/restore`).set(as(manager));
    expect([table.status, codeOf(table)]).toEqual([409, 'SECTION_ARCHIVED']);

    expect(
      (await server().post(`/api/v1/sections/${terrace.id}/restore`).set(as(manager))).status,
    ).toBe(200);
    expect((await server().post(`/api/v1/tables/${t7.id}/restore`).set(as(manager))).status).toBe(
      200,
    );
  });

  it('answers 404 for unknown sections and tables', async () => {
    const id = '01926a3e-0000-7000-8000-000000000009';
    const section = await server()
      .put(`/api/v1/sections/${id}`)
      .set(as(manager))
      .send({ name: 'X', displayOrder: 0 });
    expect([section.status, codeOf(section)]).toEqual([404, 'SECTION_NOT_FOUND']);
    const table = await server().post(`/api/v1/tables/${id}/restore`).set(as(manager));
    expect([table.status, codeOf(table)]).toEqual([404, 'TABLE_NOT_FOUND']);
  });
});

function addTableRaw(label: string, sectionId: string) {
  return server()
    .post('/api/v1/tables')
    .set(as(manager))
    .send({ label, capacity: 4, sectionId, displayOrder: 0 });
}

describe('[TBL-002] waiter assignment', () => {
  const put = (login: LoginResponse, body: Record<string, unknown>) =>
    server().put('/api/v1/waiter-assignments').set(as(login)).send(body);

  it('assigns waiters to sections and single tables for the business day, audited', async () => {
    expect((await put(waiter, { assignments: [] })).status).toBe(403);

    const response = await put(manager, {
      assignments: [
        { staffId: kit.staff.WAITER, sectionIds: [hall.id], tableIds: [] },
        { staffId: kit.staff.CASHIER, sectionIds: [], tableIds: [t7.id] },
      ],
      reason: 'Lunch shift',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { current, previous } = WaiterAssignmentsResponse.parse(response.body);
    expect(previous).toBeNull();
    expect(current.assignments).toEqual([
      { staffId: kit.staff.WAITER, staffName: 'Test waiter', sectionIds: [hall.id], tableIds: [] },
      { staffId: kit.staff.CASHIER, staffName: 'Test cashier', sectionIds: [], tableIds: [t7.id] },
    ]);
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'WAITER_ASSIGNMENTS_CHANGED' } }),
    ).toMatchObject({ reason: 'Lunch shift', actorId: kit.staff.MANAGER });

    // A waiter reads them for "My tables".
    const read = await server().get('/api/v1/waiter-assignments').set(as(waiter));
    expect(WaiterAssignmentsResponse.parse(read.body).current.assignments).toHaveLength(2);

    // The domain view keeps the table's section for the responsible-waiter rule.
    const domain = await app
      .get(WaiterAssignmentsService)
      .assignmentsFor(prisma, kit.restaurantId, current.businessDate);
    expect(domain).toEqual([
      { staffId: kit.staff.WAITER, sectionId: hall.id, tableId: null },
      { staffId: kit.staff.CASHIER, sectionId: terrace.id, tableId: t7.id },
    ]);

    // The same set again records nothing.
    const count = await prisma.auditLog.count({ where: { action: 'WAITER_ASSIGNMENTS_CHANGED' } });
    await put(manager, {
      assignments: [
        { staffId: kit.staff.WAITER, sectionIds: [hall.id], tableIds: [] },
        { staffId: kit.staff.CASHIER, sectionIds: [], tableIds: [t7.id] },
      ],
    });
    expect(await prisma.auditLog.count({ where: { action: 'WAITER_ASSIGNMENTS_CHANGED' } })).toBe(
      count,
    );
  });

  it('refuses kitchen staff, unknown tables and a waiter listed twice', async () => {
    const kitchen = await put(manager, {
      assignments: [{ staffId: kit.staff.KITCHEN, sectionIds: [hall.id], tableIds: [] }],
    });
    expect([kitchen.status, codeOf(kitchen)]).toEqual([422, 'STAFF_NOT_ASSIGNABLE']);
    const unknown = await put(manager, {
      assignments: [
        {
          staffId: kit.staff.WAITER,
          sectionIds: [],
          tableIds: ['01926a3e-0000-7000-8000-00000000000a'],
        },
      ],
    });
    expect([unknown.status, codeOf(unknown)]).toEqual([422, 'TABLE_NOT_FOUND']);
    const twice = await put(manager, {
      assignments: [
        { staffId: kit.staff.WAITER, sectionIds: [hall.id], tableIds: [] },
        { staffId: kit.staff.WAITER, sectionIds: [terrace.id], tableIds: [] },
      ],
    });
    expect([twice.status, codeOf(twice)]).toEqual([400, 'VALIDATION_FAILED']);
    const empty = await put(manager, {
      assignments: [{ staffId: kit.staff.WAITER, sectionIds: [], tableIds: [] }],
    });
    expect(empty.status).toBe(400);
  });

  it('starts each business day empty and offers the previous set', async () => {
    // Move today's set to yesterday, as if the day had ended.
    const response = WaiterAssignmentsResponse.parse(
      (await server().get('/api/v1/waiter-assignments').set(as(cashier))).body,
    );
    const today = response.current.businessDate;
    const yesterday = new Date(dbDate(today).getTime() - 86_400_000);
    await prisma.shiftAssignment.updateMany({ data: { businessDate: yesterday } });

    const next = WaiterAssignmentsResponse.parse(
      (await server().get('/api/v1/waiter-assignments').set(as(cashier))).body,
    );
    expect(next.current).toEqual({ businessDate: today, assignments: [] });
    expect(next.previous?.assignments).toHaveLength(2);
    expect(next.previous?.businessDate).toBe(yesterday.toISOString().slice(0, 10));

    // Clearing today's (already empty) set keeps yesterday's history.
    expect((await put(manager, { assignments: [] })).status).toBe(200);
    expect(await prisma.shiftAssignment.count()).toBe(2);
  });
});
