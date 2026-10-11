import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DEVICE_LIVENESS_OPTIONS, DeviceLiveness } from '../../src/devices/device-liveness.js';
import { NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { PRESENCE } from '../../src/notifications/presence.js';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { addDevice, type AuthKit, createAuthKit, deviceTokenOf } from '../helpers/auth-kit.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { appUrl, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/** P4-04a: kitchen screens and table tablets announced offline after the grace, online at once. */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let liveness: DeviceLiveness;
let gateway: RealtimeGateway;
let kit: AuthKit;
let url: string;
let stationId: string;
let tableId: string;
const clients: RealtimeTestClient[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [
      { provide: DEVICE_LIVENESS_OPTIONS, useValue: { checkMs: 0 } },
      { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
      { provide: PRESENCE, useValue: { reachable: () => true } },
    ],
    listen: true,
  });
  prisma = app.get(PrismaService);
  liveness = app.get(DeviceLiveness);
  gateway = app.get(RealtimeGateway);
  url = appUrl(app);
  kit = await createAuthKit(app);
  stationId = (
    await prisma.station.create({ data: { restaurantId: kit.restaurantId, name: 'Tandoor' } })
  ).id;
  const hall = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  tableId = (
    await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: hall.id, label: '4' },
    })
  ).id;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

async function connect(deviceId: string): Promise<RealtimeTestClient> {
  const client = await RealtimeTestClient.connect(url, { deviceToken: deviceTokenOf(deviceId) });
  clients.push(client);
  return client;
}

async function disconnect(client: RealtimeTestClient, deviceId: string): Promise<void> {
  client.close();
  await until(
    () => !gateway.isDeviceConnected(kit.restaurantId, deviceId),
    5_000,
    'the connection to close',
  );
}

const onlineOf = async (deviceId: string) =>
  (await prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).online;

/** The `online` of each `DeviceStatusChanged` announced for the device, oldest first. */
async function announced(deviceId: string): Promise<boolean[]> {
  const events = await prisma.outboxEvent.findMany({
    where: { eventType: 'DeviceStatusChanged', aggregateId: deviceId },
    orderBy: { writeOrder: 'asc' },
  });
  return events.map((event) => (event.payload as { payload: { online: boolean } }).payload.online);
}

const offlineAlert = (deviceId: string, status: 'OPEN' | 'CLEARED') =>
  until(
    () =>
      prisma.alert
        .findFirst({ where: { dedupeKey: `device:${deviceId}:offline`, status } })
        .then((found) => found ?? undefined),
    5_000,
    `a ${status.toLowerCase()} offline alert`,
  );

const later = (seconds: number) => new Date(Date.now() + seconds * 1_000);

// Devices from earlier tests stay in the restaurant, so each test looks at its own devices.
describe('[NTF-003] [MGR-006] kitchen screens and table tablets that lose their connection', () => {
  it('is online as soon as it connects, and offline only once the grace has passed', async () => {
    const screen = await addDevice(app, kit, 'KDS', { stationId });
    const client = await connect(screen);
    await until(() => onlineOf(screen), 5_000, 'the screen to be online');
    expect(await announced(screen)).toEqual([true]);

    await disconnect(client, screen);
    // 60 s by default: a reload or a moment out of Wi-Fi raises nothing.
    await liveness.check(later(30));
    expect(await onlineOf(screen)).toBe(true);
    expect(await liveness.check(later(61))).toBeGreaterThanOrEqual(1);
    expect(await onlineOf(screen)).toBe(false);
    expect(await announced(screen)).toEqual([true, false]);
    const alert = await offlineAlert(screen, 'OPEN');
    expect(alert).toMatchObject({ type: 'DEVICE_LOW_BATTERY_OR_OFFLINE' });
    expect(alert.payload).toMatchObject({
      deviceType: 'KDS',
      deviceName: 'Test KDS',
      online: false,
    });
    // One alert per state: checking again announces nothing more.
    await liveness.check(later(120));
    expect(await announced(screen)).toEqual([true, false]);

    // Back on: announced at once, and the alert ends.
    await connect(screen);
    await until(() => onlineOf(screen), 5_000, 'the screen to be online again');
    expect(await announced(screen)).toEqual([true, false, true]);
    await offlineAlert(screen, 'CLEARED');
  });

  it('raises nothing for a tablet reloaded within the grace', async () => {
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId });
    const first = await connect(tablet);
    await until(() => onlineOf(tablet), 5_000, 'the tablet to be online');
    await disconnect(first, tablet);
    await connect(tablet);
    await liveness.check(later(61));
    expect(await onlineOf(tablet)).toBe(true);
    expect(await announced(tablet)).toEqual([true]);
  });

  it('keeps a device online while another of its connections is open', async () => {
    const screen = await addDevice(app, kit, 'KDS', { stationId });
    const tab = await connect(screen);
    await connect(screen);
    await until(() => onlineOf(screen), 5_000, 'the screen to be online');
    tab.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gateway.isDeviceConnected(kit.restaurantId, screen)).toBe(true);
    await liveness.check(later(61));
    expect(await announced(screen)).toEqual([true]);
  });

  it('follows the restaurant’s own grace', async () => {
    await prisma.setting.upsert({
      where: {
        restaurantId_key: { restaurantId: kit.restaurantId, key: 'devices.offlineAfterSeconds' },
      },
      create: { restaurantId: kit.restaurantId, key: 'devices.offlineAfterSeconds', value: 15 },
      update: { value: 15 },
    });
    app.get(SettingsService).invalidate();
    try {
      const screen = await addDevice(app, kit, 'KDS', { stationId });
      const client = await connect(screen);
      await until(() => onlineOf(screen), 5_000, 'the screen to be online');
      await disconnect(client, screen);
      await liveness.check(later(10));
      expect(await onlineOf(screen)).toBe(true);
      await liveness.check(later(16));
      expect(await onlineOf(screen)).toBe(false);
    } finally {
      await prisma.setting.delete({
        where: {
          restaurantId_key: { restaurantId: kit.restaurantId, key: 'devices.offlineAfterSeconds' },
        },
      });
      app.get(SettingsService).invalidate();
    }
  });

  it('gives a device stored online the grace from the start after a restart', async () => {
    // As the server finds it after a restart: online when it stopped, and not back yet.
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId });
    await prisma.device.update({ where: { id: tablet }, data: { online: true } });
    await liveness.check(new Date(liveness.startedAt + 30_000));
    expect(await onlineOf(tablet)).toBe(true);
    await liveness.check(new Date(liveness.startedAt + 61_000));
    expect(await onlineOf(tablet)).toBe(false);
    expect(await announced(tablet)).toEqual([false]);
    await offlineAlert(tablet, 'OPEN');

    // Stored offline but connected (the connection was missed): the check puts it right.
    const screen = await addDevice(app, kit, 'KDS', { stationId });
    await connect(screen);
    await until(() => onlineOf(screen), 5_000, 'the screen to be online');
    await prisma.device.update({ where: { id: screen }, data: { online: false } });
    await liveness.check();
    expect(await onlineOf(screen)).toBe(true);
    expect(await announced(screen)).toEqual([true, true]);
  });

  it('leaves pagers, phones and unpaired devices alone', async () => {
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    const client = await connect(phone);
    await disconnect(client, phone);
    const pager = await addDevice(app, kit, 'PAGER', { staffId: kit.staff.WAITER });
    await prisma.device.update({ where: { id: pager }, data: { online: true } });
    const unpaired = await addDevice(app, kit, 'KDS', { stationId });
    await prisma.device.update({
      where: { id: unpaired },
      data: { online: true, status: 'REVOKED', revokedAt: new Date() },
    });
    await liveness.check(later(600));
    expect(await onlineOf(phone)).toBe(false);
    expect(await onlineOf(pager)).toBe(true);
    expect(await onlineOf(unpaired)).toBe(true);
    expect(await announced(phone)).toEqual([]);
    expect(await announced(pager)).toEqual([]);
    expect(await announced(unpaired)).toEqual([]);
  });
});
