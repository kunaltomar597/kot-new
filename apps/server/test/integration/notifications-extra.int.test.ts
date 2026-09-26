import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BreakView,
  type LoginResponse,
  NudgeResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NOTIFICATION_CLOCK, NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { PRESENCE } from '../../src/notifications/presence.js';
import { SystemAlerts } from '../../src/notifications/system-alerts.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { domainEvent, produce } from '../helpers/events.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/** P2-03b: nudges, "On break", device, printer and disk alerts. */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
let tableId: string;
const now = new Date('2026-09-26T12:00:00.000Z');

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [
      { provide: NOTIFICATION_CLOCK, useValue: { now: () => now } },
      { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
      { provide: PRESENCE, useValue: { reachable: () => true } },
    ],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  const hall = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  tableId = (
    await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: hall.id, label: '9', displayOrder: 1 },
    })
  ).id;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));
const openAlert = (where: object) =>
  until(
    () =>
      prisma.alert
        .findFirst({ where: { status: 'OPEN', ...where } })
        .then((found) => found ?? undefined),
    5_000,
    'an alert',
  );

describe('[NTF-008] manager nudge', () => {
  it('sends each chosen waiter their own alert with the message on the pager', async () => {
    const response = await server()
      .post('/api/v1/alerts/nudge')
      .set(as(manager))
      .send({ staffIds: [kit.staff.WAITER], message: 'Come to counter' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [alertId] = NudgeResponse.parse(response.body).alertIds;
    const alert = await prisma.alert.findUniqueOrThrow({ where: { id: alertId ?? '' } });
    expect(alert).toMatchObject({
      type: 'MANAGER_NUDGE',
      pagerText: 'MGR: Come to counter',
      recipientIds: [kit.staff.WAITER],
      raisedById: kit.staff.MANAGER,
      escalateAt: null,
    });
    expect(alert.nextRepeatAt).not.toBeNull();
    const acked = await server().post(`/api/v1/alerts/${alert.id}/acknowledge`).set(as(waiter));
    expect(acked.status).toBe(200);
  });

  it('is for managers only, to people who work here, with at most 40 characters', async () => {
    const byWaiter = await server()
      .post('/api/v1/alerts/nudge')
      .set(as(waiter))
      .send({ staffIds: [kit.staff.WAITER], message: 'Hi' });
    expect(byWaiter.status).toBe(403);
    const stranger = await server()
      .post('/api/v1/alerts/nudge')
      .set(as(manager))
      .send({ staffIds: [randomUUID()], message: 'Hi' });
    expect([stranger.status, ApiError.parse(stranger.body).code]).toEqual([422, 'STAFF_NOT_FOUND']);
    const long = await server()
      .post('/api/v1/alerts/nudge')
      .set(as(manager))
      .send({ staffIds: [kit.staff.WAITER], message: 'x'.repeat(41) });
    expect(long.status).toBe(400);
  });
});

describe('[NTF-009] on break', () => {
  it('sends the waiter’s alerts to the managers until they are back', async () => {
    const started = await server()
      .post('/api/v1/staff/me/break')
      .set(as(waiter))
      .send({ onBreak: true });
    expect(BreakView.parse(started.body)).toEqual({
      staffId: kit.staff.WAITER,
      onBreak: true,
      since: now.toISOString(),
    });
    const session = TableSessionView.parse(
      (
        await server()
          .post(`/api/v1/tables/${tableId}/open`)
          .set(as(waiter))
          .send({ covers: 2, waiterId: kit.staff.WAITER })
      ).body,
    );
    await server().post(`/api/v1/table-sessions/${session.id}/request-bill`).set(as(waiter));
    const alert = await openAlert({ type: 'BILL_REQUEST', tableSessionId: session.id });
    expect(alert.recipientIds).not.toContain(kit.staff.WAITER);
    expect(alert.recipientIds).toContain(kit.staff.MANAGER);
    expect(alert.escalatedAt).toEqual(now);

    const ended = await server()
      .post('/api/v1/staff/me/break')
      .set(as(waiter))
      .send({ onBreak: false });
    expect(BreakView.parse(ended.body)).toMatchObject({ onBreak: false, since: null });
    const again = await server()
      .post('/api/v1/staff/me/break')
      .set(as(waiter))
      .send({ onBreak: false });
    expect(BreakView.parse(again.body).onBreak).toBe(false);
  });
});

describe('[NTF-003] device, printer and disk alerts', () => {
  it('alerts once per state for a pager going offline or low, and clears when it is back', async () => {
    const pager = await prisma.device.create({
      data: {
        restaurantId: kit.restaurantId,
        type: 'PAGER',
        name: 'Pager 3',
        staffId: kit.staff.WAITER,
      },
    });
    const status = (online: boolean, batteryPercent: number) =>
      produce(app, [
        domainEvent('DeviceStatusChanged', kit.restaurantId, {
          deviceId: pager.id,
          deviceType: 'PAGER',
          online,
          batteryPercent,
        }),
      ]);
    await status(true, 15);
    const low = await openAlert({ dedupeKey: `device:${pager.id}:low` });
    expect(low).toMatchObject({ type: 'DEVICE_LOW_BATTERY_OR_OFFLINE', pagerText: 'LOW BATTERY' });
    expect(low.recipientIds).toEqual(expect.arrayContaining([kit.staff.MANAGER, kit.staff.WAITER]));
    // The same state again does not raise another.
    await status(true, 12);
    await status(false, 12);
    await openAlert({ dedupeKey: `device:${pager.id}:offline` });
    expect(await prisma.alert.count({ where: { dedupeKey: `device:${pager.id}:low` } })).toBe(1);
    await status(true, 90);
    await until(
      async () =>
        (await prisma.alert.count({
          where: { dedupeKey: { startsWith: `device:${pager.id}` }, status: 'OPEN' },
        })) === 0,
      5_000,
      'the device alerts to clear',
    );
  });

  it('alerts the managers and cashier while a printer is offline', async () => {
    const printerId = randomUUID();
    const printer = (online: boolean) =>
      produce(app, [
        domainEvent('PrinterStatusChanged', kit.restaurantId, {
          printerId,
          printerName: 'Bill printer',
          online,
          error: online ? null : 'No paper',
          queued: 2,
        }),
      ]);
    await printer(false);
    const alert = await openAlert({ dedupeKey: `printer:${printerId}` });
    expect(alert).toMatchObject({ type: 'PRINTER_OFFLINE' });
    expect(alert.recipientIds).toEqual(
      expect.arrayContaining([kit.staff.MANAGER, kit.staff.CASHIER]),
    );
    await printer(true);
    await until(
      async () =>
        (await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).status === 'CLEARED',
      5_000,
      'the printer alert to clear',
    );
  });

  it('alerts the Owner and managers when the data drive is 80 % full', async () => {
    const alerts = app.get(SystemAlerts);
    expect(await alerts.checkDisk({ totalBytes: 100, freeBytes: 15 })).toEqual({ usedPercent: 85 });
    const disk = await prisma.alert.findFirstOrThrow({
      where: { dedupeKey: 'disk', status: 'OPEN' },
    });
    expect(disk.recipientIds).toEqual(expect.arrayContaining([kit.staff.OWNER, kit.staff.MANAGER]));
    // Still full: no second alert.
    await alerts.checkDisk({ totalBytes: 100, freeBytes: 10 });
    expect(await prisma.alert.count({ where: { dedupeKey: 'disk' } })).toBe(1);
    await alerts.checkDisk({ totalBytes: 100, freeBytes: 50 });
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: disk.id } })).status).toBe(
      'CLEARED',
    );
    expect(await alerts.checkDisk({ totalBytes: 0, freeBytes: 0 })).toBeNull();
  });
});
