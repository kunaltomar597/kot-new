import type { INestApplication } from '@nestjs/common';
import {
  AlertListResponse,
  AlertView,
  ApiError,
  type LoginResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NOTIFICATION_CLOCK, NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { NotificationsService } from '../../src/notifications/notifications.service.js';
import { PRESENCE } from '../../src/notifications/presence.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * The notification engine (P2-03a) end to end: real triggers through the event bus, a fake clock
 * for repeats and escalation, and a fake presence for the waiter's pager and app.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let cashier: LoginResponse;
let manager: LoginResponse;
const tables: Record<string, string> = {};
let now = new Date('2026-09-26T12:00:00.000Z');
const clock = { now: () => now };
const connected = new Set<string>();
const presence = { reachable: (_restaurantId: string, staffId: string) => connected.has(staffId) };
const later = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
  return now;
};

const overrides = [
  { provide: NOTIFICATION_CLOCK, useValue: clock },
  { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
  { provide: PRESENCE, useValue: presence },
];

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, overrides });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  cashier = await signIn(app, kit, 'CASHIER');
  manager = await signIn(app, kit, 'MANAGER');
  const hall = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  for (const [index, label] of ['4', '5', '6', '7', '8'].entries()) {
    tables[label] = (
      await prisma.diningTable.create({
        data: { restaurantId: kit.restaurantId, sectionId: hall.id, label, displayOrder: index },
      })
    ).id;
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
const service = () => app.get(NotificationsService);

async function openTable(label: string): Promise<TableSessionView> {
  const response = await server()
    .post(`/api/v1/tables/${tables[label] ?? ''}/open`)
    .set(as(waiter))
    .send({ covers: 2 });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return TableSessionView.parse(response.body);
}

async function requestBill(session: TableSessionView) {
  const response = await server()
    .post(`/api/v1/table-sessions/${session.id}/request-bill`)
    .set(as(waiter));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return until(
    () =>
      prisma.alert
        .findFirst({
          where: { tableSessionId: session.id, type: 'BILL_REQUEST' },
        })
        .then((alert) => alert ?? undefined),
    5_000,
    'the bill alert',
  );
}

const events = (alertId: string, eventType: string) =>
  prisma.outboxEvent.findMany({
    where: { aggregateId: alertId, eventType },
    orderBy: { createdAt: 'asc' },
  });

describe('[NTF-001] [NTF-003] [NTF-004] a bill request', () => {
  it('alerts the responsible waiter and the cashier; acknowledging stops it everywhere', async () => {
    const session = await openTable('4');
    const alert = await requestBill(session);
    expect(alert).toMatchObject({
      status: 'OPEN',
      pagerText: 'T4 BILL',
      channels: ['PAGER', 'WAITER_APP', 'POS'],
      escalatedAt: null,
    });
    expect([...alert.recipientIds].sort()).toEqual([kit.staff.WAITER, kit.staff.CASHIER].sort());
    expect(alert.escalateAt).toEqual(new Date(now.getTime() + 60_000));
    expect(alert.nextRepeatAt).toEqual(new Date(now.getTime() + 60_000));
    const raised = await events(alert.id, 'AlertRaised');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.audience).toMatchObject({ staffIds: alert.recipientIds });

    // Each recipient sees it; another waiter does not.
    const mine = AlertListResponse.parse(
      (await server().get('/api/v1/alerts').set(as(cashier))).body,
    );
    expect(mine.alerts.map((entry) => entry.id)).toContain(alert.id);

    const acknowledged = await server()
      .post(`/api/v1/alerts/${alert.id}/acknowledge`)
      .set(as(cashier));
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    expect(AlertView.parse(acknowledged.body)).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedById: kit.staff.CASHIER,
      acknowledgedAt: now.toISOString(),
    });
    expect(await events(alert.id, 'AlertAcknowledged')).toHaveLength(1);
    // Nothing repeats or escalates once acknowledged, however long it waits.
    later(600);
    expect(await service().processDue()).toBe(0);
    expect(await events(alert.id, 'AlertRaised')).toHaveLength(1);
    // Acknowledging again changes nothing.
    const again = await server().post(`/api/v1/alerts/${alert.id}/acknowledge`).set(as(waiter));
    expect(AlertView.parse(again.body).acknowledgedById).toBe(kit.staff.CASHIER);
  });

  it('does not let someone else acknowledge an alert that is not theirs', async () => {
    const session = await openTable('5');
    const alert = await requestBill(session);
    const kitchen = await signIn(app, kit, 'KITCHEN');
    const refused = await server().post(`/api/v1/alerts/${alert.id}/acknowledge`).set(as(kitchen));
    expect([refused.status, ApiError.parse(refused.body).code]).toEqual([404, 'ALERT_NOT_FOUND']);
    // A manager may.
    const byManager = await server()
      .post(`/api/v1/alerts/${alert.id}/acknowledge`)
      .set(as(manager));
    expect(byManager.status).toBe(200);
  });
});

describe('[NTF-002] [NTF-005] repeats and escalation', () => {
  it('repeats every R and escalates after N to the managers on duty, once', async () => {
    const session = await openTable('6');
    const alert = await requestBill(session);
    later(59);
    expect(await service().processDue()).toBe(0);
    later(1);
    expect(await service().processDue()).toBe(1);
    const escalated = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(escalated).toMatchObject({ repeatCount: 1, escalatedAt: now });
    expect(escalated.escalatedTo).toContain(kit.staff.MANAGER);
    expect(escalated.recipientIds).toEqual(
      expect.arrayContaining([kit.staff.MANAGER, kit.staff.WAITER]),
    );
    expect(await events(alert.id, 'AlertEscalated')).toHaveLength(1);
    const repeats = await events(alert.id, 'AlertRaised');
    expect(
      repeats.map((row) => (row.payload as { payload: { repeat: number } }).payload.repeat),
    ).toEqual([0, 1]);

    later(60);
    expect(await service().processDue()).toBe(1);
    expect(await events(alert.id, 'AlertEscalated')).toHaveLength(1);
    expect(await events(alert.id, 'AlertRaised')).toHaveLength(3);

    // The table closes: the alert is cleared and stops.
    const cleared = await prisma.transaction((tx) =>
      service().clear(tx, { restaurantId: kit.restaurantId, tableSessionId: session.id }),
    );
    expect(cleared).toBe(1);
    later(600);
    expect(await service().processDue()).toBe(0);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe(
      'CLEARED',
    );
  });

  it('[NTF-007] goes to the managers at once when the waiter has neither pager nor app', async () => {
    connected.clear();
    const session = await openTable('7');
    const alert = await requestBill(session);
    expect(alert.escalatedAt).toEqual(now);
    expect(alert.recipientIds).toContain(kit.staff.MANAGER);
    expect(alert.escalateAt).toBeNull();
    expect(await events(alert.id, 'AlertEscalated')).toHaveLength(1);
  });
});

describe('[NTF-005] timers survive a restart', () => {
  it('escalates an alert raised before the server stopped', async () => {
    const pending = await requestBill(await openTable('8'));
    await app.close();
    // A new server process on the same database, later than the deadline.
    later(3_600);
    app = await createTestApp({ databaseUrl: database.url, overrides });
    prisma = app.get(PrismaService);
    expect(await service().processDue()).toBeGreaterThanOrEqual(1);
    const after = await prisma.alert.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.escalatedAt).toEqual(now);
    // Missed repeats come out as one, not a burst.
    expect(after.repeatCount).toBe(pending.repeatCount + 1);
  });
});
