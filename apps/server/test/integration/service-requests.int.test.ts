import type { INestApplication } from '@nestjs/common';
import {
  AlertListResponse,
  ApiError,
  type LoginResponse,
  ServiceRequestListResponse,
  ServiceRequestView,
  TableOverviewResponse,
  TableServiceRequestsResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NOTIFICATION_CLOCK, NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { NotificationsService } from '../../src/notifications/notifications.service.js';
import { PRESENCE } from '../../src/notifications/presence.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * Service requests (P2-06d) end to end: a table tablet raises Water, Waiter and Bill; the alerts
 * repeat and escalate on a fake clock; the waiter's inbox acknowledges and resolves; the tablet's
 * Cancel works like a cabin call button; the alert and the request stay in step through the bus.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
let kitchen: LoginResponse;
const tables: Record<string, string> = {};
const tablets: Record<string, string> = {};
let now = new Date('2026-09-27T12:00:00.000Z');
const clock = { now: () => now };
const connected = new Set<string>();
const presence = { reachable: (_restaurantId: string, staffId: string) => connected.has(staffId) };
const later = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
  return now;
};

const LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [
      { provide: NOTIFICATION_CLOCK, useValue: clock },
      { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
      { provide: PRESENCE, useValue: presence },
    ],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  kitchen = await signIn(app, kit, 'KITCHEN');
  await signIn(app, kit, 'CASHIER');
  const hall = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  for (const [index, label] of LABELS.entries()) {
    const table = await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: hall.id, label, displayOrder: index },
    });
    tables[label] = table.id;
    tablets[label] = await addDevice(app, kit, 'TABLE_TABLET', { tableId: table.id });
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

beforeEach(() => {
  connected.clear();
  connected.add(kit.staff.WAITER);
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));
const notifications = () => app.get(NotificationsService);
const idOf = (label: string) => tables[label] ?? '';
const tabletOf = (label: string) => authHeaders(tablets[label] ?? '');
const codeOf = (response: { body: unknown }) => ApiError.parse(response.body).code;

async function openTable(label: string): Promise<TableSessionView> {
  const response = await server()
    .post(`/api/v1/tables/${idOf(label)}/open`)
    .set(as(waiter))
    .send({ covers: 2, waiterId: kit.staff.WAITER });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return TableSessionView.parse(response.body);
}

/** The tablet at `label` presses a button. */
async function press(label: string, type: 'WATER' | 'WAITER' | 'BILL') {
  const response = await server()
    .post('/api/v1/devices/current/service-requests')
    .set(tabletOf(label))
    .send({ type });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return ServiceRequestView.parse(response.body);
}

const rowOf = (id: string) => prisma.serviceRequest.findUniqueOrThrow({ where: { id } });

async function alertOf(requestId: string) {
  const { alertId } = await rowOf(requestId);
  if (alertId === null) throw new Error('The request has no alert');
  return prisma.alert.findUniqueOrThrow({ where: { id: alertId } });
}

const outbox = (aggregateId: string, eventType: string) =>
  prisma.outboxEvent.findMany({
    where: { aggregateId, eventType },
    orderBy: { writeOrder: 'asc' },
  });

/** Waits until the bus has handed every committed event to `consumer`. */
async function settled(consumer: string): Promise<void> {
  const last = await until(
    async () => {
      const pending = await prisma.outboxEvent.count({ where: { sequence: null } });
      if (pending > 0) return undefined;
      const newest = await prisma.outboxEvent.findFirst({
        where: { sequence: { not: null } },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      return newest?.sequence ?? 0n;
    },
    5_000,
    'the events to be numbered',
  );
  await until(
    async () => {
      const cursor = await prisma.eventConsumerCursor.findUnique({ where: { consumer } });
      return cursor !== null && cursor.lastSequence >= last;
    },
    5_000,
    `${consumer} to catch up`,
  );
}

const inbox = async (login: LoginResponse = waiter) =>
  ServiceRequestListResponse.parse(
    (await server().get('/api/v1/service-requests').set(as(login))).body,
  ).requests;

const tabletView = async (label: string) =>
  TableServiceRequestsResponse.parse(
    (await server().get('/api/v1/devices/current/service-requests').set(tabletOf(label))).body,
  );

describe('[TAB-004] [NTF-003] a diner calls from the table tablet', () => {
  it('raises a water request that alerts the responsible waiter, and refuses a duplicate', async () => {
    const session = await openTable('1');
    const water = await press('1', 'WATER');
    expect(water).toMatchObject({
      type: 'WATER',
      state: 'ACTIVE',
      source: 'TABLE_TABLET',
      tableId: idOf('1'),
      tableLabel: '1',
      tableSessionId: session.id,
      createdAt: now.toISOString(),
      acknowledgedAt: null,
      closedAt: null,
    });
    const alert = await alertOf(water.id);
    expect(alert).toMatchObject({
      type: 'WATER_REQUEST',
      status: 'OPEN',
      pagerText: 'T1 WATER',
      recipientIds: [kit.staff.WAITER],
      channels: ['PAGER', 'WAITER_APP'],
      dedupeKey: `service:${water.id}`,
      tableSessionId: session.id,
    });
    const raised = await outbox(water.id, 'ServiceRequestRaised');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.audience).toEqual({ tableIds: [idOf('1')] });

    // The tablet, the inbox and the floor all show it.
    expect(await tabletView('1')).toEqual({ tableSessionId: session.id, requests: [water] });
    expect((await inbox()).map((entry) => entry.id)).toEqual([water.id]);
    const overview = TableOverviewResponse.parse(
      (await server().get('/api/v1/tables/overview').set(as(waiter))).body,
    );
    expect(overview.tables.find((table) => table.tableId === idOf('1'))).toMatchObject({
      activeServiceRequests: 1,
    });

    // Anti-spam: the same button again is refused while the request is open; another is fine.
    const again = await server()
      .post('/api/v1/devices/current/service-requests')
      .set(tabletOf('1'))
      .send({ type: 'WATER' });
    expect([again.status, codeOf(again)]).toEqual([409, 'SERVICE_REQUEST_ACTIVE']);
    expect(ApiError.parse(again.body).details).toEqual({ serviceRequestId: water.id });
    const call = await press('1', 'WAITER');
    expect(call.state).toBe('ACTIVE');
    expect(await prisma.serviceRequest.count({ where: { tableSessionId: session.id } })).toBe(2);
  });

  it('[NTF-002] [NTF-005] repeats every R, escalates after N, and stops when acknowledged', async () => {
    await openTable('2');
    const call = await press('2', 'WAITER');
    // Other tests' alerts are due at the same times, so this one is looked at on its own.
    later(59);
    await notifications().processDue();
    expect((await alertOf(call.id)).repeatCount).toBe(0);
    later(1);
    await notifications().processDue();
    const escalated = await alertOf(call.id);
    expect(escalated).toMatchObject({ repeatCount: 1, escalatedAt: now });
    expect(escalated.recipientIds).toEqual(
      expect.arrayContaining([kit.staff.WAITER, kit.staff.MANAGER]),
    );
    // The request follows its alert: escalated, and the managers hear of it.
    const row = await until(
      async () => {
        const found = await rowOf(call.id);
        return found.state === 'ESCALATED' ? found : undefined;
      },
      5_000,
      'the request to escalate',
    );
    expect(row.escalatedAt).toEqual(now);
    expect(await outbox(call.id, 'ServiceRequestEscalated')).toHaveLength(1);

    // The waiter says they are on the way in the inbox: the request and the alert stop.
    const acknowledged = await server()
      .post(`/api/v1/service-requests/${call.id}/acknowledge`)
      .set(as(waiter));
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    expect(ServiceRequestView.parse(acknowledged.body)).toMatchObject({
      state: 'ACKNOWLEDGED',
      acknowledgedById: kit.staff.WAITER,
      acknowledgedByName: 'Test waiter',
      acknowledgedAt: now.toISOString(),
      escalatedAt: now.toISOString(),
    });
    expect(await alertOf(call.id)).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedById: kit.staff.WAITER,
    });
    later(600);
    await notifications().processDue();
    expect(await alertOf(call.id)).toMatchObject({ repeatCount: 1, status: 'ACKNOWLEDGED' });
    // The tablet shows "Waiter is on the way".
    expect((await tabletView('2')).requests[0]?.state).toBe('ACKNOWLEDGED');

    // Acknowledging again changes nothing; the waiter arrives and presses Cancel: resolved.
    const twice = await server()
      .post(`/api/v1/service-requests/${call.id}/acknowledge`)
      .set(as(manager));
    expect(ServiceRequestView.parse(twice.body).acknowledgedById).toBe(kit.staff.WAITER);
    const cancelled = await server()
      .post(`/api/v1/devices/current/service-requests/${call.id}/cancel`)
      .set(tabletOf('2'));
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(ServiceRequestView.parse(cancelled.body)).toMatchObject({
      state: 'RESOLVED',
      closedAt: now.toISOString(),
    });
    expect(await rowOf(call.id)).toMatchObject({
      closedById: null,
      closedByDeviceId: tablets['2'],
    });
    expect((await inbox()).map((entry) => entry.id)).not.toContain(call.id);
    expect((await tabletView('2')).requests).toEqual([]);
  });

  it('[NTF-004] acknowledges the request when its alert is acknowledged on a pager or phone', async () => {
    await openTable('3');
    const water = await press('3', 'WATER');
    const alert = await alertOf(water.id);
    const acknowledged = await server()
      .post(`/api/v1/alerts/${alert.id}/acknowledge`)
      .set(as(waiter));
    expect(acknowledged.status).toBe(200);
    const row = await until(
      async () => {
        const found = await rowOf(water.id);
        return found.state === 'ACKNOWLEDGED' ? found : undefined;
      },
      5_000,
      'the request to be acknowledged',
    );
    expect(row).toMatchObject({ acknowledgedById: kit.staff.WAITER, acknowledgedAt: now });
    const events = await outbox(water.id, 'ServiceRequestAcknowledged');
    expect(events).toHaveLength(1);
    expect(events[0]?.audience).toEqual({ tableIds: [idOf('3')] });
  });

  it('cancels a request nobody has come for yet and clears its alert, so it can be raised again', async () => {
    await openTable('4');
    const water = await press('4', 'WATER');
    const cancelled = await server()
      .post(`/api/v1/devices/current/service-requests/${water.id}/cancel`)
      .set(tabletOf('4'));
    expect(ServiceRequestView.parse(cancelled.body)).toMatchObject({
      state: 'CANCELLED',
      acknowledgedAt: null,
      closedAt: now.toISOString(),
    });
    const alert = await alertOf(water.id);
    expect(alert.status).toBe('CLEARED');
    expect(await outbox(alert.id, 'AlertCleared')).toHaveLength(1);
    const cancelledEvents = await outbox(water.id, 'ServiceRequestCancelled');
    expect(cancelledEvents.map((row) => row.payload)).toEqual([
      expect.objectContaining({
        payload: { serviceRequestId: water.id, resolution: 'CANCELLED' },
      }),
    ]);
    // Pressing Cancel again returns it as it is; Water works again.
    const again = await server()
      .post(`/api/v1/devices/current/service-requests/${water.id}/cancel`)
      .set(tabletOf('4'));
    expect(ServiceRequestView.parse(again.body).state).toBe('CANCELLED');
    expect((await press('4', 'WATER')).state).toBe('ACTIVE');
  });
});

describe('[WTR-005] the waiter resolves from the inbox', () => {
  it('acknowledges first when nobody has, then resolves, and the tablet clears', async () => {
    await openTable('5');
    const call = await press('5', 'WAITER');
    const listed = (await inbox()).find((entry) => entry.id === call.id);
    expect(listed).toMatchObject({ tableLabel: '5', type: 'WAITER', state: 'ACTIVE' });

    const resolved = await server()
      .post(`/api/v1/service-requests/${call.id}/resolve`)
      .set(as(waiter));
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(ServiceRequestView.parse(resolved.body)).toMatchObject({
      state: 'RESOLVED',
      acknowledgedById: kit.staff.WAITER,
      acknowledgedAt: now.toISOString(),
      closedAt: now.toISOString(),
    });
    expect(await rowOf(call.id)).toMatchObject({ closedById: kit.staff.WAITER });
    // The acknowledgement time is kept on the alert for reports (NTF-004).
    expect(await alertOf(call.id)).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedById: kit.staff.WAITER,
      acknowledgedAt: now,
    });
    expect(await outbox(call.id, 'ServiceRequestAcknowledged')).toHaveLength(1);
    expect(await outbox(call.id, 'ServiceRequestCancelled')).toHaveLength(1);
    expect((await tabletView('5')).requests).toEqual([]);

    // Resolving or acknowledging a closed request returns it as it is.
    for (const action of ['resolve', 'acknowledge']) {
      const again = await server()
        .post(`/api/v1/service-requests/${call.id}/${action}`)
        .set(as(waiter));
      expect([again.status, ServiceRequestView.parse(again.body).state]).toEqual([200, 'RESOLVED']);
    }
  });
});

describe('[BILL-015] the bill', () => {
  it('from the tablet sets Bill requested and alerts the waiter and the cashier, once', async () => {
    const session = await openTable('6');
    const bill = await press('6', 'BILL');
    expect((await prisma.diningTable.findUniqueOrThrow({ where: { id: idOf('6') } })).state).toBe(
      'BILL_REQUESTED',
    );
    const requested = await outbox(bill.id, 'BillRequested');
    expect(requested.map((row) => row.payload)).toEqual([
      expect.objectContaining({
        payload: { tableSessionId: session.id, requestedFrom: 'TABLE_TABLET' },
      }),
    ]);
    expect(await outbox(bill.id, 'TableStateChanged')).toHaveLength(1);
    const alert = await alertOf(bill.id);
    expect(alert).toMatchObject({ type: 'BILL_REQUEST', pagerText: 'T6 BILL' });
    expect([...alert.recipientIds].sort()).toEqual([kit.staff.WAITER, kit.staff.CASHIER].sort());
    // The notification triggers see BillRequested too, but raise no second bill alert.
    await settled('notifications.triggers');
    expect(
      await prisma.alert.count({ where: { tableSessionId: session.id, type: 'BILL_REQUEST' } }),
    ).toBe(1);
  });

  it('asked for on the waiter’s phone does not alert that waiter; the cashier still hears', async () => {
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    const onPhone = await signIn(app, kit, 'WAITER', phone);
    const session = await openTable('7');
    // The waiter's pager is off: they asked, so the managers are not called at once either.
    connected.clear();
    const asked = await server()
      .post(`/api/v1/table-sessions/${session.id}/request-bill`)
      .set(authHeaders(phone, onPhone.accessToken));
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const alert = await until(
      () =>
        prisma.alert
          .findFirst({ where: { tableSessionId: session.id, type: 'BILL_REQUEST' } })
          .then((found) => found ?? undefined),
      5_000,
      'the bill alert',
    );
    expect(alert.recipientIds).toEqual([kit.staff.CASHIER]);
    expect(alert.escalatedAt).toBeNull();
    expect(alert.payload).toEqual({ requestedFrom: 'WAITER_APP' });
    const cashier = await signIn(app, kit, 'CASHIER');
    const cashierAlerts = AlertListResponse.parse(
      (await server().get('/api/v1/alerts').set(as(cashier))).body,
    );
    expect(cashierAlerts.alerts.map((entry) => entry.id)).toContain(alert.id);
  });
});

describe('[TBL-007] closing the table ends its requests', () => {
  it('cancels what nobody came for and resolves what someone did', async () => {
    const session = await openTable('8');
    const water = await press('8', 'WATER');
    const call = await press('8', 'WAITER');
    await server().post(`/api/v1/service-requests/${call.id}/acknowledge`).set(as(waiter));
    const closed = await server()
      .post(`/api/v1/table-sessions/${session.id}/close-without-bill`)
      .set(as(manager))
      .send({ reason: 'Guests left' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await settled('service-requests.alerts');
    expect(await rowOf(water.id)).toMatchObject({ state: 'CANCELLED', closedById: null });
    expect(await rowOf(call.id)).toMatchObject({ state: 'RESOLVED' });
    expect((await alertOf(water.id)).status).toBe('CLEARED');
    expect((await tabletView('8')).tableSessionId).toBeNull();
  });
});

describe('[AUTH-009] [SEC-009] who may call and how often', () => {
  it('lets a tablet act only for its own table, and only tablets raise requests', async () => {
    await openTable('9');
    const water = await press('9', 'WATER');
    // Another table's tablet cannot cancel it, or see it.
    const other = await server()
      .post(`/api/v1/devices/current/service-requests/${water.id}/cancel`)
      .set(tabletOf('1'));
    expect([other.status, codeOf(other)]).toEqual([404, 'SERVICE_REQUEST_NOT_FOUND']);
    expect((await tabletView('1')).requests.map((entry) => entry.id)).not.toContain(water.id);
    // A POS is not a table tablet; a table nobody opened cannot call.
    const pos = await server()
      .post('/api/v1/devices/current/service-requests')
      .set(authHeaders(kit.deviceId))
      .send({ type: 'WATER' });
    expect([pos.status, codeOf(pos)]).toEqual([403, 'NOT_A_TABLE_TABLET']);
    const free = await prisma.diningTable.create({
      data: {
        restaurantId: kit.restaurantId,
        sectionId: (await prisma.section.findFirstOrThrow()).id,
        label: '10',
      },
    });
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: free.id });
    const closed = await server()
      .post('/api/v1/devices/current/service-requests')
      .set(authHeaders(tablet))
      .send({ type: 'WATER' });
    expect([closed.status, codeOf(closed)]).toEqual([409, 'TABLE_NOT_OPEN']);
    expect((await tabletView('9')).requests).toHaveLength(1);
    // The kitchen takes no orders, so it has no inbox either.
    const refused = await server().get('/api/v1/service-requests').set(as(kitchen));
    expect(refused.status).toBe(403);
  });

  it('refuses a tablet that raises more than its limit in a minute', async () => {
    const changed = await server()
      .put('/api/v1/settings/tablet.serviceRequestsPerMinute')
      .set(as(manager))
      .send({ value: 3 });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const table = await prisma.diningTable.create({
      data: {
        restaurantId: kit.restaurantId,
        sectionId: (await prisma.section.findFirstOrThrow()).id,
        label: '11',
      },
    });
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: table.id });
    await server()
      .post(`/api/v1/tables/${table.id}/open`)
      .set(as(waiter))
      .send({ covers: 2, waiterId: kit.staff.WAITER });
    const raise = (type: string) =>
      server()
        .post('/api/v1/devices/current/service-requests')
        .set(authHeaders(tablet))
        .send({ type });
    expect((await raise('WATER')).status).toBe(201);
    expect((await raise('WAITER')).status).toBe(201);
    expect((await raise('WATER')).status).toBe(409);
    const limited = await raise('BILL');
    expect([limited.status, codeOf(limited)]).toEqual([429, 'RATE_LIMITED']);
  });
});
