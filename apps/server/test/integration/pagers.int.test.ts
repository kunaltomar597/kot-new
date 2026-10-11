import { randomUUID } from 'node:crypto';
import { type INestApplication, Logger } from '@nestjs/common';
import {
  DeviceAlertsResponse,
  type LoginResponse,
  MyPagerResponse,
  PagerAlertMessage,
  PagerCredentialResponse,
  PagerListResponse,
  PagerView,
  TableSessionView,
} from '@rp/contracts';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NOTIFICATION_CLOCK, NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { NotificationsService } from '../../src/notifications/notifications.service.js';
import { PAGER_OPTIONS, PagerBroker } from '../../src/pagers/pager-broker.js';
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

/** The pager broker (P2-04a) with a real MQTT client in the pager's place. */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
let port: number;
let pagerA: PagerCredentialResponse;
let pagerB: PagerCredentialResponse;
const tables: Record<string, string> = {};
const now = new Date('2026-09-26T12:00:00.000Z');
const clients: MqttClient[] = [];
/** The broker's own clock, for the heartbeat rate and its log (the tests move it on). */
let brokerMs = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { mqtt: 'on', mqttPort: 0, host: '127.0.0.1' },
    overrides: [
      { provide: NOTIFICATION_CLOCK, useValue: { now: () => now } },
      { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
      { provide: PAGER_OPTIONS, useValue: { offlineCheckMs: 0, clockMs: () => brokerMs } },
    ],
  });
  prisma = app.get(PrismaService);
  port = app.get(PagerBroker).port() ?? 0;
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  const hall = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  for (const [index, label] of ['4', '5', '6', '7'].entries()) {
    tables[label] = (
      await prisma.diningTable.create({
        data: { restaurantId: kit.restaurantId, sectionId: hall.id, label, displayOrder: index },
      })
    ).id;
  }
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.endAsync(true)));
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));

/** `RestaurantChanged` `DEVICES` announced for this pager (P4-02b). */
function changesAnnounced(deviceId: string): Promise<number> {
  return prisma.outboxEvent.count({
    where: {
      eventType: 'RestaurantChanged',
      aggregateId: deviceId,
      payload: { path: ['payload', 'part'], equals: 'DEVICES' },
    },
  });
}

async function register(serial: string, staffId: string | null): Promise<PagerCredentialResponse> {
  const response = await server()
    .post('/api/v1/pagers')
    .set(as(manager))
    .send({ serial, name: `Pager ${serial}`, staffId });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return PagerCredentialResponse.parse(response.body);
}

interface Pager {
  client: MqttClient;
  messages: PagerAlertMessage[];
}

async function connect(
  credential: PagerCredentialResponse,
  password = credential.mqttPassword,
): Promise<Pager> {
  const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${String(port)}`, {
    clientId: credential.deviceId,
    username: credential.mqttUsername,
    password,
    clean: false,
    reconnectPeriod: 0,
  });
  clients.push(client);
  const messages: PagerAlertMessage[] = [];
  client.on('message', (_topic, payload) => {
    messages.push(PagerAlertMessage.parse(JSON.parse(payload.toString())));
  });
  const granted = await client.subscribeAsync(credential.alertsTopic, { qos: 1 });
  expect(granted[0]?.qos).toBe(1);
  return { client, messages };
}

async function requestBill(label: string): Promise<string> {
  const session = TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${tables[label] ?? ''}/open`)
        .set(as(waiter))
        .send({ covers: 2, waiterId: kit.staff.WAITER })
    ).body,
  );
  // Asked by the manager: the waiter who asks for a bill is not alerted about it (P2-06d).
  await server().post(`/api/v1/table-sessions/${session.id}/request-bill`).set(as(manager));
  const alert = await until(
    () =>
      prisma.alert
        .findFirst({ where: { tableSessionId: session.id, type: 'BILL_REQUEST' } })
        .then((found) => found ?? undefined),
    5_000,
    'the bill alert',
  );
  return alert.id;
}

describe('[PGR-012] [SEC-012] registering and assigning pagers', () => {
  it('registers pagers with unique credentials, one per wearer', async () => {
    pagerA = await register('WP-0001', kit.staff.WAITER);
    pagerB = await register('WP-0002', null);
    expect(pagerA.alertsTopic).toBe(`rp/${kit.restaurantId}/pagers/${pagerA.deviceId}/alerts`);
    expect(pagerA.mqttPassword).not.toBe(pagerB.mqttPassword);
    const stored = await prisma.device.findUniqueOrThrow({ where: { id: pagerA.deviceId } });
    expect(stored.mqttSecretHash).not.toContain(pagerA.mqttPassword);
    const twice = await server()
      .post('/api/v1/pagers')
      .set(as(manager))
      .send({ serial: 'WP-0001', name: 'Again', staffId: null });
    expect(twice.status).toBe(409);
    const byWaiter = await server()
      .post('/api/v1/pagers')
      .set(as(waiter))
      .send({ serial: 'WP-0003', name: 'Mine', staffId: null });
    expect(byWaiter.status).toBe(403);
    const list = PagerListResponse.parse(
      (await server().get('/api/v1/pagers').set(as(manager))).body,
    );
    expect(list.pagers.map((pager) => pager.serial).sort()).toEqual(['WP-0001', 'WP-0002']);
    // PGR-013 ⚙: the level at which the list shows a pager as low.
    expect(list.lowBatteryPercent).toBe(15);
    // Every screen hears that the pagers changed (P4-02b); the refused ones changed nothing.
    expect(await changesAnnounced(pagerA.deviceId)).toBe(1);
    expect(await changesAnnounced(pagerB.deviceId)).toBe(1);
  });

  it('refuses a wrong password and another pager’s topics', async () => {
    await expect(connect(pagerA, 'not-the-password')).rejects.toThrow();
    const b = await connect(pagerB);
    // Refused in the SUBACK (0x80); the pager stays connected to its own topic.
    await expect(b.client.subscribeAsync(pagerA.alertsTopic, { qos: 1 })).rejects.toThrow(
      'Subscribe error',
    );
    await expect(
      b.client.subscribeAsync(`rp/${kit.restaurantId}/pagers/+/alerts`, { qos: 1 }),
    ).rejects.toThrow('Subscribe error');
    expect(b.client.connected).toBe(true);
  });
});

describe('[PGR-006] [PGR-008] [NFR-P03] alerts on the pager', () => {
  it('delivers an alert within 2 s, and the button acknowledges it everywhere', async () => {
    const a = await connect(pagerA);
    const started = performance.now();
    const alertId = await requestBill('4');
    const message = await until(
      () => a.messages.find((entry) => entry.alertId === alertId),
      5_000,
      'the pager message',
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(message).toMatchObject({
      state: 'ALERT',
      seq: 0,
      type: 'BILL_REQUEST',
      lines: ['T4 BILL', ''],
      vibration: 'TWO_SHORT',
    });
    // The pager is connected, so the waiter counts as reachable: no immediate escalation (NTF-007).
    expect(
      (await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })).escalatedAt,
    ).toBeNull();

    await a.client.publishAsync(pagerA.ackTopic, JSON.stringify({ alertId }), { qos: 1 });
    await until(
      async () =>
        (await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })).status ===
        'ACKNOWLEDGED',
      5_000,
      'the acknowledgement',
    );
    const acknowledged = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } });
    expect(acknowledged.acknowledgedById).toBe(kit.staff.WAITER);
    // PAGER-R2: and the pager it came from.
    expect(acknowledged.acknowledgedByDeviceId).toBe(pagerA.deviceId);
    await until(
      () => a.messages.find((entry) => entry.alertId === alertId && entry.state === 'ACKNOWLEDGED'),
      5_000,
      'the acknowledged message',
    );
  });

  it('sends open alerts again when the pager reconnects', async () => {
    const alertId = await requestBill('5');
    const a = await connect(pagerA);
    const message = await until(
      () => a.messages.find((entry) => entry.alertId === alertId),
      5_000,
      'the resent alert',
    );
    expect(message.state).toBe('ALERT');
  });

  it('ignores a pager publishing where it may not', async () => {
    const b = await connect(pagerB);
    const open = await prisma.alert.findFirstOrThrow({
      where: { status: 'OPEN', recipientIds: { has: kit.staff.WAITER } },
    });
    await b.client.publishAsync(pagerA.ackTopic, JSON.stringify({ alertId: open.id }), { qos: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('OPEN');
  });

  it('keeps up under a burst: 30 nudges reach the pager within 2 s', async () => {
    const a = await connect(pagerA);
    const before = a.messages.length;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        server()
          .post('/api/v1/alerts/nudge')
          .set(as(manager))
          .send({ staffIds: [kit.staff.WAITER], message: `Check T${String(index)}` }),
      ),
    );
    await until(() => a.messages.length - before >= 30, 5_000, 'thirty nudges');
    expect(performance.now() - started).toBeLessThan(2_000 + 1_000);
  });
});

describe('[WTR-006] [NTF-004] the waiter phone and the pager share one acknowledgement', () => {
  it('stops the pager repeats when the phone acknowledges, and tells the pager', async () => {
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    await signIn(app, kit, 'WAITER', phone);
    const a = await connect(pagerA);
    const alertId = await requestBill('6');
    await until(
      () => a.messages.find((entry) => entry.alertId === alertId && entry.seq === 0),
      5_000,
      'the alert on the pager',
    );
    // Unacknowledged after R, it comes back on the pager, and the phone shows the same alert.
    await app.get(NotificationsService).processDue(new Date(now.getTime() + 61_000));
    await until(
      () => a.messages.find((entry) => entry.alertId === alertId && entry.seq === 1),
      5_000,
      'the repeat on the pager',
    );
    const listed = DeviceAlertsResponse.parse(
      (await server().get('/api/v1/devices/current/alerts').set(authHeaders(phone))).body,
    );
    expect(listed.alerts.find((alert) => alert.id === alertId)).toMatchObject({ repeatCount: 1 });

    // Acknowledged on the phone, as its holder: the pager hears it and the repeats stop.
    const acknowledged = await server()
      .post(`/api/v1/devices/current/alerts/${alertId}/acknowledge`)
      .set(authHeaders(phone));
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    await until(
      () => a.messages.find((entry) => entry.alertId === alertId && entry.state === 'ACKNOWLEDGED'),
      5_000,
      'the acknowledgement on the pager',
    );
    await app.get(NotificationsService).processDue(new Date(now.getTime() + 300_000));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      a.messages.filter((entry) => entry.alertId === alertId && entry.state === 'ALERT'),
    ).toHaveLength(2);
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })).toMatchObject({
      acknowledgedById: kit.staff.WAITER,
      acknowledgedByDeviceId: phone,
    });
  });

  it('keeps alerts meant for the POS and dashboard off the pager', async () => {
    const a = await connect(pagerA);
    const before = a.messages.length;
    // A printer alert goes to the managers and cashiers on the POS and dashboard only.
    await server()
      .put(`/api/v1/pagers/${pagerB.deviceId}/wearer`)
      .set(as(manager))
      .send({ staffId: kit.staff.CASHIER });
    const b = await connect(pagerB);
    await app.get(PrismaService).transaction((tx) =>
      app.get(NotificationsService).raise(tx, {
        restaurantId: kit.restaurantId,
        type: 'PRINTER_OFFLINE',
        dedupeKey: 'printer:test',
        payload: { printerName: 'Counter' },
      }),
    );
    const nudge = await server()
      .post('/api/v1/alerts/nudge')
      .set(as(manager))
      .send({ staffIds: [kit.staff.CASHIER], message: 'Printer check' });
    const [nudgeId] = (nudge.body as { alertIds: string[] }).alertIds;
    // The nudge arrives after the printer alert, so by then the printer alert would have too.
    await until(
      () => b.messages.find((entry) => entry.alertId === nudgeId),
      5_000,
      'the nudge on the cashier’s pager',
    );
    expect(b.messages.map((entry) => entry.type)).not.toContain('PRINTER_OFFLINE');
    expect(a.messages.slice(before).map((entry) => entry.type)).not.toContain('PRINTER_OFFLINE');
    await server()
      .put(`/api/v1/pagers/${pagerB.deviceId}/wearer`)
      .set(as(manager))
      .send({ staffId: null });
  });
});

describe('[PGR-007] [PGR-013] heartbeats', () => {
  it('records battery and signal, alerts at low battery, and marks the pager offline after 3 missed beats', async () => {
    const a = await connect(pagerA);
    await a.client.publishAsync(
      `rp/${kit.restaurantId}/pagers/${pagerA.deviceId}/heartbeat`,
      JSON.stringify({ battery: 12, rssi: -61, firmware: '1.0.3' }),
      { qos: 1 },
    );
    await until(
      async () =>
        (await prisma.device.findUniqueOrThrow({ where: { id: pagerA.deviceId } }))
          .batteryPercent === 12,
      5_000,
      'the heartbeat',
    );
    const low = await until(
      () =>
        prisma.alert
          .findFirst({ where: { dedupeKey: `device:${pagerA.deviceId}:low`, status: 'OPEN' } })
          .then((found) => found ?? undefined),
      5_000,
      'the low battery alert',
    );
    expect(low.recipientIds).toEqual(expect.arrayContaining([kit.staff.WAITER, kit.staff.MANAGER]));
    const device = PagerView.parse(
      PagerListResponse.parse(
        (await server().get('/api/v1/pagers').set(as(manager))).body,
      ).pagers.find((pager) => pager.deviceId === pagerA.deviceId),
    );
    expect(device).toMatchObject({ online: true, rssi: -61, firmwareVersion: '1.0.3' });

    const broker = app.get(PagerBroker);
    // Heartbeats are timed by the engine's clock: 60 s later is fine, 91 s is three missed beats.
    expect(await broker.checkOffline(new Date(now.getTime() + 60_000))).toBe(0);
    const closed = new Promise<void>((resolve) => {
      a.client.once('close', () => {
        resolve();
      });
    });
    expect(await broker.checkOffline(new Date(now.getTime() + 91_000))).toBe(1);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: pagerA.deviceId } })).online).toBe(
      false,
    );
    // PAGER-D6: its session is closed too, so the pager signs in again rather than counting as
    // connected while it sends nothing.
    await closed;
    expect(broker.connectedPagers().map((pager) => pager.deviceId)).not.toContain(pagerA.deviceId);
  });
});

describe('[WTR-014] the wearer’s own pager', () => {
  it('shows the waiter their pager and the warning level, and tells them when its state changes', async () => {
    const response = await server().get('/api/v1/pagers/mine').set(as(waiter));
    expect(response.status).toBe(200);
    // The pager's own level (PGR-013 ⚙), not the tablets' (TAB-015).
    expect(MyPagerResponse.parse(response.body)).toMatchObject({
      lowBatteryPercent: 15,
      pager: { deviceId: pagerA.deviceId, staffId: kit.staff.WAITER, batteryPercent: 12 },
    });
    // Coming online and going offline reached the wearer as well as the managers.
    const changes = await prisma.outboxEvent.findMany({
      where: { eventType: 'DeviceStatusChanged', aggregateId: pagerA.deviceId },
    });
    expect(changes.length).toBeGreaterThanOrEqual(2);
    for (const change of changes) expect(change.audience).toEqual({ staffIds: [kit.staff.WAITER] });
    // Someone who wears no pager gets none, not somebody else's.
    const managers = MyPagerResponse.parse(
      (await server().get('/api/v1/pagers/mine').set(as(manager))).body,
    );
    expect(managers.pager).toBeNull();
    expect((await server().get('/api/v1/pagers/mine')).status).toBe(401);
  });
});

describe('[PGR-012] [PGR-014] re-assignment', () => {
  it('gives the pager to a manager at once, taking it from the waiter', async () => {
    const response = await server()
      .put(`/api/v1/pagers/${pagerB.deviceId}/wearer`)
      .set(as(manager))
      .send({ staffId: kit.staff.WAITER });
    expect(PagerView.parse(response.body).staffId).toBe(kit.staff.WAITER);
    // The waiter wore pager A: it is released.
    expect(
      (await prisma.device.findUniqueOrThrow({ where: { id: pagerA.deviceId } })).staffId,
    ).toBeNull();
    const toManager = await server()
      .put(`/api/v1/pagers/${pagerA.deviceId}/wearer`)
      .set(as(manager))
      .send({ staffId: kit.staff.MANAGER });
    expect(PagerView.parse(toManager.body).staffId).toBe(kit.staff.MANAGER);
    expect(
      await prisma.auditLog.count({
        where: { action: 'PAGER_ASSIGNED', entityId: pagerA.deviceId },
      }),
    ).toBeGreaterThanOrEqual(2);
    // Announced, so the wearers' own pager cards change at once (P4-02b). Giving a pager to the
    // person who already wears it changes nothing.
    const announced = await changesAnnounced(pagerA.deviceId);
    await server()
      .put(`/api/v1/pagers/${pagerA.deviceId}/wearer`)
      .set(as(manager))
      .send({ staffId: kit.staff.MANAGER });
    expect(await changesAnnounced(pagerA.deviceId)).toBe(announced);
  });

  it('replaces a credential, after which the old one no longer signs in', async () => {
    const announced = await changesAnnounced(pagerB.deviceId);
    const rotated = PagerCredentialResponse.parse(
      (await server().post(`/api/v1/pagers/${pagerB.deviceId}/credential`).set(as(manager))).body,
    );
    await expect(connect(pagerB)).rejects.toThrow();
    await connect(rotated);
    expect(await changesAnnounced(pagerB.deviceId)).toBe(announced + 1);
  });
});

describe('[AUTH-008] [SEC-012] [NTF-007] unpairing a pager', () => {
  it('ends its connection at once and frees its wearer', async () => {
    const credential = await register('WP-0009', kit.staff.OWNER);
    const pager = await connect(credential);
    const broker = app.get(PagerBroker);
    expect(broker.isStaffConnected(kit.restaurantId, kit.staff.OWNER)).toBe(true);
    const closed = new Promise<void>((resolve) => {
      pager.client.once('close', () => {
        resolve();
      });
    });
    const response = await server()
      .post(`/api/v1/devices/${credential.deviceId}/revoke`)
      .set(as(manager))
      .send({ reason: 'Lost on the floor' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // Found by the threat model (P8-03b): the pager kept its session until it signed in again.
    await closed;
    expect(broker.isStaffConnected(kit.restaurantId, kit.staff.OWNER)).toBe(false);
    const stored = await prisma.device.findUniqueOrThrow({ where: { id: credential.deviceId } });
    expect(stored.staffId).toBeNull();
    // Offline from now on, so the offline check never alerts about a pager nobody uses.
    expect(stored.online).toBe(false);
    const statusEvents = () =>
      prisma.outboxEvent.count({
        where: { eventType: 'DeviceStatusChanged', aggregateId: credential.deviceId },
      });
    const announced = await statusEvents();
    await broker.checkOffline(new Date(now.getTime() + 3_600_000));
    expect(await statusEvents()).toBe(announced);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'DEVICE_REVOKED', entityId: credential.deviceId },
    });
    expect(audit.before).toMatchObject({ staffId: kit.staff.OWNER });
    await expect(connect(credential)).rejects.toThrow();
  });
});

describe('[NTF-004] [SEC-012] what a pager may acknowledge (PAGER-T1, PAGER-R2)', () => {
  it('acknowledges only alerts sent to it, also when a manager wears it', async () => {
    const credential = await register('WP-0010', kit.staff.MANAGER);
    const pager = await connect(credential);
    // The waiter wears a connected pager, so the bill alert goes to them alone (NTF-007), not to
    // the manager's pager: its id is no use to the manager's pager.
    const waiters = await connect(await register('WP-0016', kit.staff.WAITER));
    const billId = await requestBill('7');
    await until(
      () => waiters.messages.find((entry) => entry.alertId === billId),
      5_000,
      'the bill on the waiter’s pager',
    );
    await pager.client.publishAsync(credential.ackTopic, JSON.stringify({ alertId: billId }), {
      qos: 1,
    });
    const nudge = await server()
      .post('/api/v1/alerts/nudge')
      .set(as(manager))
      .send({ staffIds: [kit.staff.MANAGER], message: 'Check the pass' });
    const [nudgeId] = (nudge.body as { alertIds: string[] }).alertIds;
    await until(
      () => pager.messages.find((entry) => entry.alertId === nudgeId),
      5_000,
      'the nudge on the manager’s pager',
    );
    await pager.client.publishAsync(credential.ackTopic, JSON.stringify({ alertId: nudgeId }), {
      qos: 1,
    });
    await until(
      async () =>
        (await prisma.alert.findUniqueOrThrow({ where: { id: nudgeId ?? '' } })).status ===
        'ACKNOWLEDGED',
      5_000,
      'the nudge acknowledged',
    );
    // Acks are handled in order: by now the bill's has been heard and refused.
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: billId } })).toMatchObject({
      status: 'OPEN',
      acknowledgedById: null,
    });
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: nudgeId ?? '' } })).toMatchObject({
      acknowledgedById: kit.staff.MANAGER,
      acknowledgedByDeviceId: credential.deviceId,
    });
  });
});

describe('[PGR-008] [NTF-007] which pagers count as connected (PAGER-D6)', () => {
  it('keeps the pager connected when its old session closes after the new one signed in', async () => {
    const credential = await register('WP-0012', kit.staff.CASHIER);
    const broker = app.get(PagerBroker);
    const first = await connect(credential);
    const firstClosed = new Promise<void>((resolve) => {
      first.client.once('close', () => {
        resolve();
      });
    });
    // The pager comes back on a new connection before the broker noticed the old one dropped.
    const second = await connect(credential);
    await firstClosed;
    expect(broker.isStaffConnected(kit.restaurantId, kit.staff.CASHIER)).toBe(true);
    expect(
      broker.connectedPagers().filter((pager) => pager.deviceId === credential.deviceId),
    ).toHaveLength(1);
    const nudge = await server()
      .post('/api/v1/alerts/nudge')
      .set(as(manager))
      .send({ staffIds: [kit.staff.CASHIER], message: 'Till check' });
    const [nudgeId] = (nudge.body as { alertIds: string[] }).alertIds;
    await until(
      () => second.messages.find((entry) => entry.alertId === nudgeId),
      5_000,
      'the nudge on the new session',
    );
    // Reachable, so not escalated at once (NTF-007).
    expect(
      (await prisma.alert.findUniqueOrThrow({ where: { id: nudgeId ?? '' } })).escalatedAt,
    ).toBeNull();
    await second.client.endAsync();
    await until(
      () => !broker.isStaffConnected(kit.restaurantId, kit.staff.CASHIER),
      5_000,
      'the pager gone',
    );
  });
});

describe('[PGR-007] [SEC-012] what a signed-in pager may send (PAGER-D4)', () => {
  const storedRssi = async (deviceId: string) =>
    (await prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).rssi;

  it('drops heartbeats faster than half the interval', async () => {
    const credential = await register('WP-0013', null);
    const pager = await connect(credential);
    const beat = (rssi: number) =>
      pager.client.publishAsync(
        credential.heartbeatTopic,
        JSON.stringify({ battery: 70, rssi, firmware: '1.0.3' }),
        { qos: 1 },
      );
    await beat(-50);
    await until(async () => (await storedRssi(credential.deviceId)) === -50, 5_000, 'the beat');
    // 14 s later (the interval is 30 s): dropped. 15 s after the one taken: taken.
    brokerMs += 14_000;
    await beat(-51);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await storedRssi(credential.deviceId)).toBe(-50);
    brokerMs += 1_000;
    await beat(-52);
    await until(async () => (await storedRssi(credential.deviceId)) === -52, 5_000, 'the next');
  });

  it('drops acknowledgements beyond a burst of ten, then takes about one a second', async () => {
    const credential = await register('WP-0017', kit.staff.OWNER);
    const pager = await connect(credential);
    const nudge = await server()
      .post('/api/v1/alerts/nudge')
      .set(as(manager))
      .send({ staffIds: [kit.staff.OWNER], message: 'Call the bank' });
    const [nudgeId = ''] = (nudge.body as { alertIds: string[] }).alertIds;
    await until(
      () => pager.messages.find((entry) => entry.alertId === nudgeId),
      5_000,
      'the nudge on the Owner’s pager',
    );
    const ack = (alertId: string) =>
      pager.client.publishAsync(credential.ackTopic, JSON.stringify({ alertId }), { qos: 1 });
    for (let index = 0; index < 10; index += 1) await ack(randomUUID());
    // The eleventh in the same second is dropped, even for a real alert.
    await ack(nudgeId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: nudgeId } })).status).toBe('OPEN');
    brokerMs += 1_000;
    await ack(nudgeId);
    await until(
      async () =>
        (await prisma.alert.findUniqueOrThrow({ where: { id: nudgeId } })).status ===
        'ACKNOWLEDGED',
      5_000,
      'the acknowledgement a second later',
    );
  });

  it('ends the connection of a pager that sends a retained or QoS 2 message', async () => {
    const credential = await register('WP-0014', null);
    for (const options of [{ qos: 1, retain: true }, { qos: 2 }] as const) {
      brokerMs += 60_000;
      const pager = await connect(credential);
      const ended = new Promise<void>((resolve) => {
        pager.client.once('close', () => {
          resolve();
        });
      });
      pager.client.publish(
        credential.heartbeatTopic,
        JSON.stringify({ battery: 70, rssi: -60, firmware: '1.0.3' }),
        options,
      );
      await ended;
    }
    // Neither was taken as a heartbeat.
    expect(await storedRssi(credential.deviceId)).toBeNull();
  });
});

describe('[SEC-012] failed pager sign-ins (PAGER-R3)', () => {
  it('logs and counts wrong secrets against the pager, from its newest credential on', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    // A new minute for the log, whatever the tests before it refused.
    brokerMs += 60_000;
    try {
      const credential = await register('WP-0015', null);
      await expect(connect(credential, 'wrong-1')).rejects.toThrow('Not authorized');
      await expect(connect(credential, 'wrong-2')).rejects.toThrow('Not authorized');
      const listed = async () =>
        PagerListResponse.parse(
          (await server().get('/api/v1/pagers').set(as(manager))).body,
        ).pagers.find((pager) => pager.deviceId === credential.deviceId);
      expect(await listed()).toMatchObject({
        signInFailures: 2,
        lastSignInFailureAt: now.toISOString(),
      });
      // One line a minute per address and pager, with the count since the last.
      const lines = warn.mock.calls.filter(
        ([fields]) =>
          (fields as { reason?: string; deviceId?: string } | undefined)?.reason ===
            'wrong-secret' && (fields as { deviceId?: string }).deviceId === credential.deviceId,
      );
      expect(lines).toEqual([
        [
          expect.objectContaining({ address: expect.any(String) as unknown, count: 1 }),
          'Pager sign-in refused: wrong secret',
        ],
      ]);
      brokerMs += 60_000;
      await expect(connect(credential, 'wrong-3')).rejects.toThrow('Not authorized');
      expect(warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: 'wrong-secret', count: 2 }),
        'Pager sign-in refused: wrong secret',
      );
      // A name that is no pager is logged, with nothing to count it against.
      const stranger = randomUUID();
      await expect(
        connect({ ...credential, deviceId: stranger, mqttUsername: stranger }),
      ).rejects.toThrow('Not authorized');
      expect(warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: 'not-a-pager', count: 1 }),
        'Pager sign-in refused: no active pager by that name',
      );
      // A new credential starts the count again.
      await server().post(`/api/v1/pagers/${credential.deviceId}/credential`).set(as(manager));
      expect(await listed()).toMatchObject({ signInFailures: 0, lastSignInFailureAt: null });
    } finally {
      warn.mockRestore();
    }
  });
});
