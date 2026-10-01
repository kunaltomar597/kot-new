import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  DeviceListResponse,
  KioskExitResponse,
  type LoginResponse,
  TableSessionView,
  TabletTableView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DevicePresenceMonitor } from '../../src/devices/device-presence.monitor.js';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
  signIn,
  TEST_PINS,
} from '../helpers/auth-kit.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * The table tablet's server side (P3-01a): its own table and session (TAB-002, TAB-003,
 * AUTH-009), health reports and their alerts (TAB-015), being offline (Appendix C) and the
 * manager's PIN that lets staff out of kiosk mode (TAB-001).
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';
const clients: RealtimeTestClient[] = [];

const server = () => request(httpServer(app));
const asDevice = (deviceId: string) => authHeaders(deviceId);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { restaurantId_key: { restaurantId: kit.restaurantId, key } },
    create: { restaurantId: kit.restaurantId, key, value: value as never },
    update: { value: value as never },
  });
  app.get(SettingsService).invalidate();
}

async function tableOf(deviceId: string): Promise<TabletTableView> {
  const response = await server().get('/api/v1/devices/current/table').set(asDevice(deviceId));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return TabletTableView.parse(response.body);
}

const openAlerts = (deviceId: string) =>
  prisma.alert.findMany({
    where: {
      type: 'DEVICE_LOW_BATTERY_OR_OFFLINE',
      status: 'OPEN',
      dedupeKey: { contains: deviceId },
    },
  });

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, listen: true });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  const base = { restaurantId: kit.restaurantId };
  const section = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: section.id, label } })
    ).id;
  }
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
  const taxGroup = await prisma.taxGroup.create({
    data: { ...base, name: 'GST 5 %', sacCode: '996331' },
  });
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
  for (const [name, extra] of [
    ['Biryani', {}],
    ['Lassi', {}],
    ['Old special', { archivedAt: new Date() }],
    ['Sold out', { available: false }],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: 20_000,
          taxGroupId: taxGroup.id,
          foodType: 'VEG',
          stationId: station.id,
          ...extra,
        },
      })
    ).id;
  }
  ids.tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: id('T1') });
  ids.unbound = await addDevice(app, kit, 'TABLE_TABLET');
  ids.kds = await addDevice(app, kit, 'KDS', { stationId: station.id });
});

afterAll(async () => {
  for (const client of clients) client.close();
  await app.close();
  await database.drop();
});

describe('[TAB-002] [TAB-003] [AUTH-009] the tablet’s own table', () => {
  it('[TAB-003] shows the idle screen while the table is free, with the pinned dishes', async () => {
    await setSetting('reco.itemPreferences', {
      [id('Lassi')]: 'PIN',
      [id('Old special')]: 'PIN',
      [id('Sold out')]: 'PIN',
      [id('Biryani')]: 'PIN',
    });
    expect(await tableOf(id('tablet'))).toEqual({
      tableId: id('T1'),
      label: 'T1',
      state: 'FREE',
      session: null,
      // Archived and unavailable dishes are not promoted; the rest in menu order.
      promotions: { show: true, itemIds: [id('Biryani'), id('Lassi')] },
    });
    await setSetting('tablet.idleShowsPromotions', false);
    expect((await tableOf(id('tablet'))).promotions).toEqual({ show: false, itemIds: [] });
    await setSetting('tablet.idleShowsPromotions', true);
  });

  it('[TAB-003] unlocks when the table is opened, and the tablet hears it', async () => {
    const live = await RealtimeTestClient.connect(appUrl(app), {
      deviceToken: deviceTokenOf(id('tablet')),
    });
    clients.push(live);
    const opened = await server()
      .post(`/api/v1/tables/${id('T1')}/open`)
      .set(authHeaders(kit.deviceId, waiter.accessToken))
      .send({ covers: 3 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const session = TableSessionView.parse(opened.body);
    await live.waitFor(() => live.received.find((event) => event.type === 'TableOpened'));
    expect((await tableOf(id('tablet'))).session).toEqual({
      id: session.id,
      openedAt: session.openedAt,
      covers: 3,
    });
    live.close();
  });

  it('[AUTH-009] is only for a table tablet bound to a table', async () => {
    const kds = await server()
      .get('/api/v1/devices/current/table')
      .set(asDevice(id('kds')));
    expect(kds.status).toBe(403);
    expect(codeOf(kds)).toBe('NOT_A_TABLE_TABLET');
    const unbound = await server()
      .get('/api/v1/devices/current/table')
      .set(asDevice(id('unbound')));
    expect(unbound.status).toBe(409);
    expect(codeOf(unbound)).toBe('TABLET_NOT_BOUND');
    const nobody = await server().get('/api/v1/devices/current/table');
    expect(nobody.status).toBe(401);
  });

  it('[AUTH-009] still refuses the tablet another table’s actions', async () => {
    const other = await server()
      .post(`/api/v1/tables/${id('T2')}/open`)
      .set(asDevice(id('tablet')))
      .send({ covers: 2 });
    expect([401, 403]).toContain(other.status);
  });
});

describe('[TAB-015] device health', () => {
  const report = (deviceId: string, body: object) =>
    server().post('/api/v1/devices/current/health').set(asDevice(deviceId)).send(body);

  it('records battery, charging, connection and version for the dashboard', async () => {
    const response = await report(id('tablet'), {
      batteryPercent: 64,
      charging: false,
      network: 'WIFI',
      rssi: -58,
      appVersion: '1.5.0',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    const devices = DeviceListResponse.parse(
      (await server().get('/api/v1/devices').set(authHeaders(kit.deviceId, manager.accessToken)))
        .body,
    ).devices;
    expect(devices.find((device) => device.id === id('tablet'))).toMatchObject({
      batteryPercent: 64,
      charging: false,
      network: 'WIFI',
      rssi: -58,
      appVersion: '1.5.0',
    });
  });

  it('[NTF-003] a low, unplugged tablet alerts the managers once; charging clears it', async () => {
    await report(id('tablet'), {
      batteryPercent: 19,
      charging: false,
      network: 'WIFI',
      rssi: null,
    });
    await until(async () => (await openAlerts(id('tablet'))).length === 1, 5_000, 'the alert');
    const [alert] = await openAlerts(id('tablet'));
    expect(alert?.payload).toMatchObject({ deviceType: 'TABLE_TABLET', batteryPercent: 19 });
    expect(alert?.recipientIds).toContain(kit.staff.MANAGER);
    // Lower still, no new alert (once per state change).
    await report(id('tablet'), {
      batteryPercent: 15,
      charging: false,
      network: 'WIFI',
      rssi: null,
    });
    expect(await openAlerts(id('tablet'))).toHaveLength(1);
    await report(id('tablet'), { batteryPercent: 15, charging: true, network: 'WIFI', rssi: null });
    await until(async () => (await openAlerts(id('tablet'))).length === 0, 5_000, 'the clear');
  });

  it('refuses pagers, which report in their heartbeat, and bad reports', async () => {
    const pager = await addDevice(app, kit, 'PAGER', { staffId: kit.staff.WAITER });
    const fromPager = await report(pager, {
      batteryPercent: 50,
      charging: null,
      network: 'WIFI',
      rssi: null,
    });
    expect(fromPager.status).toBe(403);
    const bad = await report(id('tablet'), {
      batteryPercent: 140,
      charging: null,
      network: 'WIFI',
    });
    expect(bad.status).toBe(400);
  });
});

describe('[TAB-015] [NTF-003] offline tablets and kitchen screens', () => {
  it('goes online when it connects, and offline after the setting’s time away', async () => {
    const monitor = app.get(DevicePresenceMonitor);
    const start = Date.now();
    const live = await RealtimeTestClient.connect(appUrl(app), {
      deviceToken: deviceTokenOf(id('kds')),
    });
    clients.push(live);
    await monitor.check(start);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: id('kds') } })).online).toBe(true);
    live.close();
    await until(
      () => !app.get(RealtimeGateway).connectedDeviceIds(kit.restaurantId).has(id('kds')),
      5_000,
      'the disconnect',
    );
    await monitor.check(start + 1_000);
    await monitor.check(start + 60_000);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: id('kds') } })).online).toBe(true);
    await monitor.check(start + 122_000);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: id('kds') } })).online).toBe(
      false,
    );
    await until(async () => (await openAlerts(id('kds'))).length === 1, 5_000, 'the alert');
    const [alert] = await openAlerts(id('kds'));
    expect(alert?.payload).toMatchObject({ deviceType: 'KDS', online: false });

    const back = await RealtimeTestClient.connect(appUrl(app), {
      deviceToken: deviceTokenOf(id('kds')),
    });
    clients.push(back);
    await monitor.check(start + 130_000);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: id('kds') } })).online).toBe(true);
    await until(async () => (await openAlerts(id('kds'))).length === 0, 5_000, 'the clear');
    back.close();
  });

  it('never alerts when the setting is 0', async () => {
    await setSetting('devices.offlineAlertSeconds', 0);
    const monitor = app.get(DevicePresenceMonitor);
    const start = Date.now();
    await monitor.check(start);
    await monitor.check(start + 3_600_000);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: id('kds') } })).online).toBe(true);
    await setSetting('devices.offlineAlertSeconds', 120);
  });
});

describe('[TAB-001] leaving kiosk mode', () => {
  const exit = (deviceId: string, body: object) =>
    server().post('/api/v1/devices/current/kiosk-exit').set(asDevice(deviceId)).send(body);

  it('takes a manager’s PIN and audits the exit', async () => {
    const response = await exit(id('tablet'), {
      staffId: kit.staff.MANAGER,
      pin: TEST_PINS.MANAGER,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(KioskExitResponse.parse(response.body).approver.id).toBe(kit.staff.MANAGER);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'TABLET_KIOSK_EXITED' },
    });
    expect(entry).toMatchObject({
      actorId: kit.staff.MANAGER,
      deviceId: id('tablet'),
      entityId: id('tablet'),
    });
  });

  it('refuses a wrong PIN (audited), a waiter, and any device but a tablet', async () => {
    const wrong = await exit(id('tablet'), { staffId: kit.staff.MANAGER, pin: '000000' });
    expect(wrong.status).toBe(401);
    expect(
      await prisma.auditLog.count({ where: { action: 'TABLET_KIOSK_EXIT_DENIED' } }),
    ).toBeGreaterThanOrEqual(1);
    const byWaiter = await exit(id('tablet'), { staffId: kit.staff.WAITER, pin: TEST_PINS.WAITER });
    expect(byWaiter.status).toBe(403);
    expect(codeOf(byWaiter)).toBe('APPROVER_NOT_ALLOWED');
    const fromKds = await exit(id('kds'), { staffId: kit.staff.MANAGER, pin: TEST_PINS.MANAGER });
    expect(fromKds.status).toBe(403);
    expect(codeOf(fromKds)).toBe('NOT_A_TABLE_TABLET');
  });
});

describe('[MGR-006] locate a tablet', () => {
  const locate = (deviceId: string, login = manager) =>
    server()
      .post(`/api/v1/devices/${deviceId}/locate`)
      .set(authHeaders(kit.deviceId, login.accessToken));

  it('makes a connected tablet show itself, and only that tablet hears it', async () => {
    const live = await RealtimeTestClient.connect(appUrl(app), {
      deviceToken: deviceTokenOf(id('tablet')),
    });
    clients.push(live);
    const response = await locate(id('tablet'));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ seconds: 15 });
    const heard = await live.waitFor(() =>
      live.received.find((event) => event.type === 'DeviceLocateRequested'),
    );
    expect(heard.payload).toEqual({ deviceId: id('tablet'), seconds: 15 });
    live.close();
  });

  it('refuses a tablet that is not connected, other devices and non-managers', async () => {
    await until(
      () => !app.get(RealtimeGateway).connectedDeviceIds(kit.restaurantId).has(id('tablet')),
      5_000,
      'the disconnect',
    );
    const away = await locate(id('tablet'));
    expect(away.status).toBe(409);
    expect(codeOf(away)).toBe('DEVICE_NOT_CONNECTED');
    const kds = await locate(id('kds'));
    expect(codeOf(kds)).toBe('LOCATE_NOT_SUPPORTED');
    const byWaiter = await locate(id('tablet'), waiter);
    expect(byWaiter.status).toBe(403);
  });
});
