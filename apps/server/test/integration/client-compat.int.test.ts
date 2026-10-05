import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  CLIENT_API_VERSION,
  CLIENT_HEADER,
  DeviceListResponse,
  type LoginResponse,
  SystemStatusResponse,
  VersionResponse,
  type VersionMatrix,
} from '@rp/contracts';
import type { ReleaseInfo } from '@rp/contracts/control-plane';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveOfferedUpdate } from '../../src/cloud/control-plane-state.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
  renewDeviceToken,
  signIn,
} from '../helpers/auth-kit.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { api, appUrl, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * N-1 (UPD-006, P7-04d): the server serves its own client API and the one before it. An older
 * app is refused with 426 CLIENT_TOO_OLD over REST and the socket, except where it finds and
 * checks the server; each device's app version and API are kept, and the manager sees which apps
 * need updating, also before an update that would leave them behind.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;

/** An app one major behind: older than any 1.x server serves. */
const TOO_OLD = 'waiter-app/0.9.0 api/0.9';
const CURRENT = `waiter-app/2.0.0 api/${CLIENT_API_VERSION}`;
const NEWER = 'table-tablet/9.0.0 api/1.999';

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const asManager = () => authHeaders(kit.deviceId, manager.accessToken);

describe('[UPD-006] the client API the server serves', () => {
  it('says which client API it speaks and the oldest it still serves', async () => {
    const response = await api(app).get('/api/v1/version').set(CLIENT_HEADER, TOO_OLD);
    expect(response.status).toBe(200);
    const version = VersionResponse.parse(response.body);
    expect(version.clientApi).toEqual({ current: CLIENT_API_VERSION, oldest: CLIENT_API_VERSION });
  });

  it('refuses an app older than that with 426 CLIENT_TOO_OLD, saying what to do', async () => {
    const response = await api(app)
      .get('/api/v1/auth/staff-tiles')
      .set({ ...authHeaders(kit.deviceId), [CLIENT_HEADER]: TOO_OLD });
    expect(response.status).toBe(426);
    const error = ApiError.parse(response.body);
    expect(error.code).toBe('CLIENT_TOO_OLD');
    expect(error.message).toMatch(/Update the app/);
    expect(error.details).toMatchObject({
      kind: 'waiter-app',
      appVersion: '0.9.0',
      clientApi: '0.9',
      served: { current: CLIENT_API_VERSION },
    });
    expect(error.correlationId).toBe(response.headers['x-correlation-id']);
    // Pairing too: the app is updated before it pairs.
    const pairing = await api(app)
      .post('/api/v1/devices/pair')
      .set(CLIENT_HEADER, TOO_OLD)
      .send({ code: 'ABCD2345' });
    expect(pairing.status).toBe(426);
  });

  it('still lets an old app find and check the server and report its errors', async () => {
    for (const path of ['/api/v1/health', '/api/v1/version', '/api/v1/tls/ca']) {
      const response = await api(app).get(path).set(CLIENT_HEADER, TOO_OLD);
      expect(response.status, path).not.toBe(426);
    }
  });

  it('serves the current API, a newer app, a malformed identity and none at all', async () => {
    for (const client of [CURRENT, NEWER, 'something else', undefined]) {
      const response = await api(app)
        .get('/api/v1/auth/staff-tiles')
        .set({
          ...authHeaders(kit.deviceId),
          ...(client !== undefined && { [CLIENT_HEADER]: client }),
        });
      expect(response.status, String(client)).toBe(200);
    }
  });

  it('refuses an old app on the live connection too, and lets a current one in', async () => {
    const refused = await RealtimeTestClient.refused(appUrl(app), {
      deviceToken: deviceTokenOf(kit.deviceId),
      client: TOO_OLD,
    });
    expect(refused.code).toBe('CLIENT_TOO_OLD');
    const connected = await RealtimeTestClient.connect(appUrl(app), {
      deviceToken: deviceTokenOf(kit.deviceId),
      client: CURRENT,
    });
    expect(connected.syncs).toHaveLength(1);
    connected.close();
  });
});

describe('[UPD-006] which apps need updating', () => {
  let phone: string;
  let tablet: string;
  let pager: string;

  beforeAll(async () => {
    phone = await addDevice(app, kit, 'WAITER_PHONE');
    tablet = await addDevice(app, kit, 'TABLE_TABLET');
    pager = await addDevice(app, kit, 'PAGER');
  });

  /** The device asks for a new token as the app it is (about hourly in real life). */
  const renewAs = (deviceId: string, client: string) =>
    renewDeviceToken(app, deviceId, { [CLIENT_HEADER]: client });

  it('keeps the app version and client API each device last said', async () => {
    await renewAs(phone, CURRENT);
    await renewAs(tablet, NEWER);
    const row = await prisma.device.findUniqueOrThrow({ where: { id: phone } });
    expect(row).toMatchObject({ appVersion: '2.0.0', clientApi: CLIENT_API_VERSION });
    const list = DeviceListResponse.parse(
      (await api(app).get('/api/v1/devices').set(asManager())).body,
    );
    const byId = new Map(list.devices.map((device) => [device.id, device]));
    expect(byId.get(phone)).toMatchObject({
      appVersion: '2.0.0',
      clientApi: CLIENT_API_VERSION,
      compatibility: 'CURRENT',
    });
    expect(byId.get(tablet)).toMatchObject({ clientApi: '1.999', compatibility: 'NEWER' });
    // Pagers speak MQTT; the POS never said.
    expect(byId.get(pager)?.compatibility).toBe('UNKNOWN');
    expect(byId.get(kit.deviceId)?.compatibility).toBe('UNKNOWN');
  });

  it('counts the apps by how they stand, and the ones an offered update leaves behind', async () => {
    // An app paired long ago that still speaks 1.0, against an offered release that speaks 1.2.
    await prisma.device.update({ where: { id: phone }, data: { clientApi: '1.0' } });
    const matrix: VersionMatrix = {
      release: '1.4.0',
      clientApi: { current: '1.2', oldest: '1.1' },
      components: [{ name: 'server', version: '1.4.0' }],
      clients: [{ kind: 'waiter-app', version: '1.4.0', minimumVersion: '1.3.0' }],
      pagerProtocol: 1,
    };
    await saveOfferedUpdate(prisma, release('1.4.0', matrix));
    const status = SystemStatusResponse.parse(
      (await api(app).get('/api/v1/system').set(asManager())).body,
    );
    expect(status.clients.api.current).toBe(CLIENT_API_VERSION);
    expect(status.clients.counts).toEqual([
      { compatibility: 'CURRENT', devices: 1 },
      { compatibility: 'NEWER', devices: 1 },
      { compatibility: 'UNKNOWN', devices: 1 },
    ]);
    expect(status.update.offered).toMatchObject({
      version: '1.4.0',
      clientApi: { current: '1.2', oldest: '1.1' },
      // The phone on 1.0; the tablet on 1.999 is newer, the POS never said, pagers do not count.
      leavesBehind: 1,
    });
    await saveOfferedUpdate(prisma, release('1.4.1', null));
    const without = SystemStatusResponse.parse(
      (await api(app).get('/api/v1/system').set(asManager())).body,
    );
    expect(without.update.offered).toMatchObject({ clientApi: null, leavesBehind: null });
  });
});

function release(version: string, matrix: VersionMatrix | null): ReleaseInfo {
  return {
    component: 'RESTAURANT_PC',
    channel: 'STABLE',
    version,
    url: `https://downloads.example.com/RestaurantPlatform-Setup-${version}.exe`,
    sha256: 'b'.repeat(64),
    sizeBytes: 100_000_000,
    notes: null,
    publishedAt: '2026-10-05T00:00:00.000Z',
    securityCritical: false,
    matrix,
  };
}
