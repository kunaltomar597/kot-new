import type { INestApplication } from '@nestjs/common';
import {
  type LoginResponse,
  PagerAlertMessage,
  PagerCredentialResponse,
  PagerListResponse,
  PagerView,
  TableSessionView,
} from '@rp/contracts';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NOTIFICATION_CLOCK, NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { PAGER_OPTIONS, PagerBroker } from '../../src/pagers/pager-broker.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
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

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { mqtt: 'on', mqttPort: 0, host: '127.0.0.1' },
    overrides: [
      { provide: NOTIFICATION_CLOCK, useValue: { now: () => now } },
      { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
      { provide: PAGER_OPTIONS, useValue: { offlineCheckMs: 0 } },
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
  await server().post(`/api/v1/table-sessions/${session.id}/request-bill`).set(as(waiter));
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
    expect(await broker.checkOffline(new Date(now.getTime() + 91_000))).toBe(1);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: pagerA.deviceId } })).online).toBe(
      false,
    );
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
  });

  it('replaces a credential, after which the old one no longer signs in', async () => {
    const rotated = PagerCredentialResponse.parse(
      (await server().post(`/api/v1/pagers/${pagerB.deviceId}/credential`).set(as(manager))).body,
    );
    await expect(connect(pagerB)).rejects.toThrow();
    await connect(rotated);
  });
});
