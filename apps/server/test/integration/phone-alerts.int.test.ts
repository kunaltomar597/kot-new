import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  AlertView,
  DeviceAlertsResponse,
  type LoginResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NOTIFICATION_CLOCK, NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { DEFAULT_REALTIME_OPTIONS, REALTIME_OPTIONS } from '../../src/realtime/realtime.gateway.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
  signIn,
} from '../helpers/auth-kit.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * P2-06a: a waiter phone alerts its holder, the person who last signed in on it, and goes on
 * doing so after an inactivity sign-out, like a pager (WTR-006, AUTH-005).
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let url: string;
let manager: LoginResponse;
let phone: string;
let phoneLogin: LoginResponse;
const tables: Record<string, string> = {};
const clients: RealtimeTestClient[] = [];
const now = new Date('2026-09-26T12:00:00.000Z');

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [
      { provide: NOTIFICATION_CLOCK, useValue: { now: () => now } },
      { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
      {
        provide: REALTIME_OPTIONS,
        useValue: { ...DEFAULT_REALTIME_OPTIONS, sweepIntervalMs: 200 },
      },
    ],
    listen: true,
  });
  prisma = app.get(PrismaService);
  url = appUrl(app);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  phone = await addDevice(app, kit, 'WAITER_PHONE');
  const hall = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  for (const [index, label] of ['5', '6', '7'].entries()) {
    tables[label] = (
      await prisma.diningTable.create({
        data: { restaurantId: kit.restaurantId, sectionId: hall.id, label, displayOrder: index },
      })
    ).id;
  }
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));
const onPhone = (deviceId: string = phone) => authHeaders(deviceId);

async function phoneAlerts(deviceId: string = phone): Promise<DeviceAlertsResponse> {
  const response = await server().get('/api/v1/devices/current/alerts').set(onPhone(deviceId));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return DeviceAlertsResponse.parse(response.body);
}

/** The waiter looks after the table; its bill is asked for, which alerts them (Appendix C). */
async function billAlert(label: string) {
  const session = TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${tables[label] ?? ''}/open`)
        .set(authHeaders(kit.deviceId, manager.accessToken))
        .send({ covers: 2, waiterId: kit.staff.WAITER })
    ).body,
  );
  await server()
    .post(`/api/v1/table-sessions/${session.id}/request-bill`)
    .set(authHeaders(kit.deviceId, manager.accessToken));
  return until(
    () =>
      prisma.alert
        .findFirst({ where: { tableSessionId: session.id, type: 'BILL_REQUEST' } })
        .then((found) => found ?? undefined),
    5_000,
    'the bill alert',
  );
}

describe('[WTR-006] [AUTH-005] a waiter phone alerts its holder, signed in or not', () => {
  it('makes the person who signs in on it the holder, and lists their alerts with labels', async () => {
    expect(await phoneAlerts()).toEqual({ holder: null, alerts: [] });
    phoneLogin = await signIn(app, kit, 'WAITER', phone);
    const alert = await billAlert('5');
    const listed = await phoneAlerts();
    expect(listed.holder).toEqual({ staffId: kit.staff.WAITER, displayName: 'Test waiter' });
    expect(listed.alerts).toHaveLength(1);
    expect(listed.alerts[0]).toMatchObject({
      id: alert.id,
      type: 'BILL_REQUEST',
      tableLabel: '5',
      pagerText: 'T5 BILL',
      // The manager asked for it at the POS (P2-06d names who asked).
      raisedByName: 'Test manager',
      status: 'OPEN',
    });
    // Neither pager nor app was connected, so the managers had it at once (NTF-007).
    expect(listed.alerts[0]?.escalatedTo).toEqual([kit.staff.MANAGER]);
  });

  it('keeps alerting after an inactivity sign-out, and acknowledges as the holder', async () => {
    const [alert] = (await phoneAlerts()).alerts;
    if (alert === undefined) throw new Error('No alert on the phone');
    await prisma.session.update({
      where: { id: phoneLogin.session.id },
      data: { lastActiveAt: new Date(Date.now() - 60 * 60_000) },
    });
    const signedOut = await server()
      .get('/api/v1/alerts')
      .set(authHeaders(phone, phoneLogin.accessToken));
    expect(ApiError.parse(signedOut.body).code).toBe('SESSION_EXPIRED');

    expect((await phoneAlerts()).alerts.map((open) => open.id)).toEqual([alert.id]);
    const acknowledged = await server()
      .post(`/api/v1/devices/current/alerts/${alert.id}/acknowledge`)
      .set(onPhone());
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    expect(AlertView.parse(acknowledged.body)).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedById: kit.staff.WAITER,
      tableLabel: '5',
    });
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: 'AlertAcknowledged', aggregateId: alert.id },
      }),
    ).toBe(1);
    // Again returns it as it is; the phone no longer lists it.
    const again = await server()
      .post(`/api/v1/devices/current/alerts/${alert.id}/acknowledge`)
      .set(onPhone());
    expect(AlertView.parse(again.body).acknowledgedById).toBe(kit.staff.WAITER);
    expect((await phoneAlerts()).alerts).toEqual([]);
  });

  it('acknowledges only what the phone shows its holder', async () => {
    const nudge = await server()
      .post('/api/v1/alerts/nudge')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ staffIds: [kit.staff.CASHIER], message: 'Count the float' });
    expect(nudge.status).toBe(201);
    const [cashiers] = (nudge.body as { alertIds: string[] }).alertIds;
    const refused = await server()
      .post(`/api/v1/devices/current/alerts/${cashiers ?? ''}/acknowledge`)
      .set(onPhone());
    expect(refused.status).toBe(404);
    expect(ApiError.parse(refused.body).code).toBe('ALERT_NOT_FOUND');
    // A nudge for the holder is listed with the manager's name.
    await server()
      .post('/api/v1/alerts/nudge')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ staffIds: [kit.staff.WAITER], message: 'Come to counter' });
    const [mine] = (await phoneAlerts()).alerts;
    expect(mine).toMatchObject({
      type: 'MANAGER_NUDGE',
      raisedByName: 'Test manager',
      pagerText: 'MGR: Come to counter',
      payload: { message: 'Come to counter' },
    });
    await server()
      .post(`/api/v1/devices/current/alerts/${mine?.id ?? ''}/acknowledge`)
      .set(onPhone());
  });

  it('[NTF-006] [NTF-007] keeps a timed-out phone in its holder’s alerts, counting as their app', async () => {
    const live = await RealtimeTestClient.connect(url, { deviceToken: deviceTokenOf(phone) });
    clients.push(live);
    const alert = await billAlert('6');
    const raised = await live.waitFor(() =>
      live.received.find(
        (event) => event.type === 'AlertRaised' && event.payload.alertId === alert.id,
      ),
    );
    expect(raised.type).toBe('AlertRaised');
    // The phone is connected, so the waiter counts as reachable: no escalation yet (NTF-007).
    expect(alert.escalatedAt).toBeNull();
    // The alert room hears alerts, not the tables its holder looks after.
    expect(live.received.map((event) => event.type)).not.toContain('TableOpened');
  });

  it('stops alerting when the holder signs in on another phone or signs out there', async () => {
    const live = await RealtimeTestClient.connect(url, { deviceToken: deviceTokenOf(phone) });
    clients.push(live);
    const other = await addDevice(app, kit, 'WAITER_PHONE');
    const elsewhere = await signIn(app, kit, 'WAITER', other);
    expect(await phoneAlerts()).toEqual({ holder: null, alerts: [] });
    expect((await phoneAlerts(other)).holder?.staffId).toBe(kit.staff.WAITER);
    // The first phone's connection is closed so it reconnects without the waiter's alerts.
    await live.waitFor(() => live.endings.find((ending) => ending.reason === 'DEVICE_CHANGED'));

    const out = await server()
      .post('/api/v1/auth/logout')
      .set(authHeaders(other, elsewhere.accessToken));
    expect(out.status).toBe(204);
    expect(await phoneAlerts(other)).toEqual({ holder: null, alerts: [] });
  });

  it('is only for waiter phones', async () => {
    const response = await server()
      .get('/api/v1/devices/current/alerts')
      .set(onPhone(kit.deviceId));
    expect(response.status).toBe(403);
    expect((await server().get('/api/v1/devices/current/alerts')).status).toBe(401);
  });
});
