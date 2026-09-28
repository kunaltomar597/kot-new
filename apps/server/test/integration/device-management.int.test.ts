import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  DeviceListResponse,
  DeviceSummary,
  type DeviceView,
  type LoginResponse,
  PairingCodeResponse,
  pairingProofMessage,
} from '@rp/contracts';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DEFAULT_REALTIME_OPTIONS, REALTIME_OPTIONS } from '../../src/realtime/realtime.gateway.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
  signAsDevice,
  signIn,
} from '../helpers/auth-kit.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/** Managing devices (P4-02c, MGR-006): their state now, renaming, locating and announcements. */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let url: string;
let tables: [string, string];
const clients: RealtimeTestClient[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [
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
  const hall = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  const created = [];
  for (const label of ['1', '2']) {
    created.push(
      await prisma.diningTable.create({
        data: { restaurantId: kit.restaurantId, sectionId: hall.id, label },
      }),
    );
  }
  tables = created.map((table) => table.id) as [string, string];
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));
const asManager = () => authHeaders(kit.deviceId, manager.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

async function connect(deviceId: string, accessToken?: string): Promise<RealtimeTestClient> {
  const client = await RealtimeTestClient.connect(url, {
    deviceToken: deviceTokenOf(deviceId),
    ...(accessToken !== undefined && { accessToken }),
  });
  clients.push(client);
  return client;
}

async function listed(deviceId: string): Promise<DeviceView> {
  const response = await server().get('/api/v1/devices').set(asManager());
  expect(response.status).toBe(200);
  const device = DeviceListResponse.parse(response.body).devices.find(
    (entry) => entry.id === deviceId,
  );
  if (device === undefined) throw new Error(`Device ${deviceId} is not listed`);
  return device;
}

/** `RestaurantChanged` `DEVICES` announced for this device. */
function changesAnnounced(deviceId: string): Promise<number> {
  return prisma.outboxEvent.count({
    where: {
      eventType: 'RestaurantChanged',
      aggregateId: deviceId,
      payload: { path: ['payload', 'part'], equals: 'DEVICES' },
    },
  });
}

describe('[MGR-006] [TAB-015] the device list', () => {
  it('says whether each device is connected now, and its battery against its type’s level', async () => {
    const kds = await addDevice(app, kit, 'KDS');
    expect((await listed(kds)).online).toBe(false);
    const screen = await connect(kds);
    expect((await listed(kds)).online).toBe(true);
    // Last seen as it connected (at most once a minute), and again as it left (MGR-006).
    const connectedAt = (await listed(kds)).lastSeenAt ?? '';
    expect(connectedAt).not.toBe('');
    screen.close();
    await until(async () => !(await listed(kds)).online, 5_000, 'the screen to show as gone');
    await until(
      async () => ((await listed(kds)).lastSeenAt ?? '') > connectedAt,
      5_000,
      'last seen as it left',
    );

    // Pagers report through heartbeats (the broker keeps `online`); 15 % is low for a pager…
    const pager = await addDevice(app, kit, 'PAGER');
    await prisma.device.update({
      where: { id: pager },
      data: { online: true, batteryPercent: 15, firmwareVersion: '1.0.3', serial: 'WP-0042' },
    });
    expect(await listed(pager)).toMatchObject({
      type: 'PAGER',
      online: true,
      batteryPercent: 15,
      batteryLow: true,
      firmwareVersion: '1.0.3',
      serial: 'WP-0042',
    });
    // …while tablets and the rest share 20 % (TAB-015).
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: tables[0] });
    await prisma.device.update({ where: { id: tablet }, data: { batteryPercent: 20 } });
    expect(await listed(tablet)).toMatchObject({ batteryPercent: 20, batteryLow: true });
    await prisma.device.update({ where: { id: tablet }, data: { batteryPercent: 21 } });
    expect(await listed(tablet)).toMatchObject({ batteryLow: false });
    expect((await listed(kds)).batteryLow).toBe(false);

    // An unpaired device is never connected, whatever it last reported.
    await server()
      .post(`/api/v1/devices/${pager}/revoke`)
      .set(asManager())
      .send({ reason: 'Strap broke' })
      .expect(200);
    expect(await listed(pager)).toMatchObject({ status: 'REVOKED', online: false });
  });
});

describe('[MGR-006] [AUD-001] renaming', () => {
  it('renames a device, audited, and tells every screen and the device itself', async () => {
    const kds = await addDevice(app, kit, 'KDS');
    const screen = await connect(kds);
    const response = await server()
      .patch(`/api/v1/devices/${kds}`)
      .set(asManager())
      .send({ name: '  Grill screen ' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(DeviceSummary.parse(response.body).name).toBe('Grill screen');
    const current = DeviceSummary.parse(
      (await server().get('/api/v1/devices/current').set(authHeaders(kds))).body,
    );
    expect(current.name).toBe('Grill screen');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'DEVICE_RENAMED', entityId: kds },
    });
    expect(audit.actorId).toBe(kit.staff.MANAGER);
    await screen.waitFor(() =>
      screen.received.find(
        (event) => event.type === 'RestaurantChanged' && event.payload.part === 'DEVICES',
      ),
    );

    // The same name again changes nothing.
    await server()
      .patch(`/api/v1/devices/${kds}`)
      .set(asManager())
      .send({ name: 'Grill screen' })
      .expect(200);
    expect(
      await prisma.auditLog.count({ where: { action: 'DEVICE_RENAMED', entityId: kds } }),
    ).toBe(1);
    expect(await changesAnnounced(kds)).toBe(1);
  });

  it('refuses a blank name, an unpaired device, an unknown one and anyone but managers', async () => {
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    expect(
      (await server().patch(`/api/v1/devices/${phone}`).set(asManager()).send({ name: ' ' }))
        .status,
    ).toBe(400);
    const waiter = await signIn(app, kit, 'WAITER');
    expect(
      (
        await server()
          .patch(`/api/v1/devices/${phone}`)
          .set(authHeaders(kit.deviceId, waiter.accessToken))
          .send({ name: 'Mine' })
      ).status,
    ).toBe(403);
    expect(
      codeOf(
        await server()
          .patch('/api/v1/devices/0199a3e4-0000-7000-8000-000000000000')
          .set(asManager())
          .send({ name: 'Nobody' }),
      ),
    ).toBe('NOT_FOUND');
    await server()
      .post(`/api/v1/devices/${phone}/revoke`)
      .set(asManager())
      .send({ reason: 'Returned' })
      .expect(200);
    expect(
      codeOf(
        await server().patch(`/api/v1/devices/${phone}`).set(asManager()).send({ name: 'Old' }),
      ),
    ).toBe('DEVICE_REVOKED');
  });
});

describe('[MGR-006] locating a device', () => {
  it('asks only that device to show itself, and never again after it reconnects', async () => {
    const kds = await addDevice(app, kit, 'KDS');
    const screen = await connect(kds);
    const dashboard = await connect(kit.deviceId, manager.accessToken);
    const response = await server().post(`/api/v1/devices/${kds}/locate`).set(asManager());
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    const heard = await screen.waitFor(() =>
      screen.events.find((message) => message.event.type === 'DeviceLocateRequested'),
    );
    expect(heard.event.payload).toEqual({ deviceId: kds, deviceType: 'KDS', name: 'Test KDS' });

    // The manager's own screen does not beep, and a screen that comes back later is not asked.
    const marker = await server()
      .patch(`/api/v1/devices/${kds}`)
      .set(asManager())
      .send({ name: 'Pass screen' });
    expect(marker.status).toBe(200);
    await dashboard.waitFor(() =>
      dashboard.received.find((event) => event.type === 'RestaurantChanged'),
    );
    expect(dashboard.received.map((event) => event.type)).not.toContain('DeviceLocateRequested');
    screen.close();
    const again = await RealtimeTestClient.connect(url, {
      deviceToken: deviceTokenOf(kds),
      lastSequence: heard.sequence - 1,
      streamId: screen.syncs[0]?.streamId,
    });
    clients.push(again);
    expect(again.syncs[0]?.fullRefresh).toBe(false);
    expect(again.received.map((event) => event.type)).not.toContain('DeviceLocateRequested');
  });

  it('refuses a device that is not connected or is unpaired, and a flood of requests', async () => {
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: tables[1] });
    const offline = await server().post(`/api/v1/devices/${tablet}/locate`).set(asManager());
    expect(offline.status).toBe(409);
    expect(codeOf(offline)).toBe('DEVICE_NOT_CONNECTED');
    expect(ApiError.parse(offline.body).message).toContain('not connected');

    await connect(tablet);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await server().post(`/api/v1/devices/${tablet}/locate`).set(asManager()).expect(204);
    }
    // Nobody keeps a tablet beeping at a table.
    expect((await server().post(`/api/v1/devices/${tablet}/locate`).set(asManager())).status).toBe(
      429,
    );

    await server()
      .post(`/api/v1/devices/${tablet}/revoke`)
      .set(asManager())
      .send({ reason: 'Moved out' })
      .expect(200);
    expect(codeOf(await server().post(`/api/v1/devices/${tablet}/locate`).set(asManager()))).toBe(
      'DEVICE_REVOKED',
    );
  });
});

describe('[AUTH-008] [AUTH-009] pairing, moving and unpairing are announced', () => {
  it('tells every screen when a device is paired, moved to another table or unpaired', async () => {
    const code = PairingCodeResponse.parse(
      (
        await server()
          .post('/api/v1/devices/pairing-codes')
          .set(asManager())
          .send({ type: 'TABLE_TABLET', name: 'Table 1 tablet', tableId: tables[0] })
          .expect(201)
      ).body,
    );
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const paired = await server()
      .post('/api/v1/devices/pair')
      .send({
        code: code.code,
        algorithm: 'Ed25519',
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        proof: signAsDevice(privateKey, pairingProofMessage(code.code)),
      });
    expect(paired.status, JSON.stringify(paired.body)).toBe(201);
    const tablet = (paired.body as { deviceId: string }).deviceId;
    expect(await changesAnnounced(tablet)).toBe(1);

    await server()
      .put(`/api/v1/devices/${tablet}/table`)
      .set(asManager())
      .send({ tableId: tables[1] })
      .expect(200);
    expect(await changesAnnounced(tablet)).toBe(2);
    // Moving it to the table it serves changes nothing.
    await server()
      .put(`/api/v1/devices/${tablet}/table`)
      .set(asManager())
      .send({ tableId: tables[1] })
      .expect(200);
    expect(
      await prisma.auditLog.count({ where: { action: 'DEVICE_TABLE_CHANGED', entityId: tablet } }),
    ).toBe(1);
    expect(await changesAnnounced(tablet)).toBe(2);

    await server()
      .post(`/api/v1/devices/${tablet}/revoke`)
      .set(asManager())
      .send({ reason: 'Table removed' })
      .expect(200);
    expect(await changesAnnounced(tablet)).toBe(3);
  });
});
