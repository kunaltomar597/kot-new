import type { INestApplication } from '@nestjs/common';
import {
  ApiClient,
  ApiRequestError,
  type ConnectionStatus,
  type DeviceKey,
  generateWebCryptoDeviceKey,
  type ResumePoint,
  type StoredCredentials,
} from '@rp/api-client';
import type { DomainEvent, RealtimeEndReason, RealtimeSync } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TokenService } from '../../src/auth/tokens.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { EventBus } from '../../src/events/event-bus.js';
import { DEFAULT_REALTIME_OPTIONS, REALTIME_OPTIONS } from '../../src/realtime/realtime.gateway.js';
import {
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
  TEST_PINS,
} from '../helpers/auth-kit.js';
import { domainEvent, produce } from '../helpers/events.js';
import { appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * `@rp/api-client` against the real server (P0-14): the same client the console, waiter app and
 * tablet use, with a WebCrypto device key, over real HTTP and Socket.io.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let url: string;
let restaurantId: string;
let key: DeviceKey;
let deviceId: string;
let kit: AuthKit;
let client: ApiClient;
const saved: StoredCredentials[] = [];

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
  restaurantId = (await prisma.restaurant.create({ data: { displayName: 'Client Dhaba' } })).id;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[AUTH-007] [ONB-001] pairing and signing in through the client', () => {
  it('pairs a WebCrypto key with the bootstrap code, then signs a manager in', async () => {
    const { code } = await new ApiClient({ baseUrl: url }).api.createBootstrapPairingCode();
    ({ key } = await generateWebCryptoDeviceKey());
    client = new ApiClient({
      baseUrl: url,
      onCredentialsChange: (credentials) => saved.push(credentials),
    });

    const paired = await client.pair({ code, key, appVersion: '0.1.0-test' });
    deviceId = paired.deviceId;
    expect(paired.type).toBe('POS');
    expect(client.device?.deviceToken).toBeDefined();

    kit = await createAuthKit(app, { restaurantId });
    const tiles = await client.api.listStaffTiles();
    expect(tiles.staff.map((tile) => tile.staffId)).toContain(kit.staff.MANAGER);

    const session = await client.signInWithPin({
      staffId: kit.staff.MANAGER,
      pin: TEST_PINS.MANAGER,
    });
    expect(session.staff.role).toBe('MANAGER');
    const { devices } = await client.api.listDevices();
    expect(devices.find((device) => device.id === deviceId)?.appVersion).toBe('0.1.0-test');
    expect(saved.at(-1)?.session?.accessToken).toBe(session.accessToken);
  });

  it('maps a refused PIN to the server’s error', async () => {
    const other = new ApiClient({
      baseUrl: url,
      signer: key,
      credentials: { device: client.device },
    });
    const error = await other
      .signInWithPin({ staffId: kit.staff.CASHIER, pin: '9999' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
  });
});

describe('[AUTH-005] tokens renew themselves', () => {
  it('refreshes an expired access token and retries the call', async () => {
    const cashier = new ApiClient({
      baseUrl: url,
      signer: key,
      credentials: { device: client.device },
    });
    const session = await cashier.signInWithPin({
      staffId: kit.staff.CASHIER,
      pin: TEST_PINS.CASHIER,
    });
    const expired = await app.get(TokenService).signAccessToken(
      {
        staffId: session.staff.id,
        role: session.staff.role,
        restaurantId,
        deviceId,
        sessionId: session.session.id,
      },
      60,
      new Date(Date.now() - 3_600_000),
    );
    // The client believes the token is fresh; the server says it expired.
    const stale = new ApiClient({
      baseUrl: url,
      signer: key,
      credentials: { device: client.device, session: { ...session, accessToken: expired.token } },
    });

    await expect(stale.api.logout()).resolves.toBeUndefined();
    expect(stale.session?.refreshToken).not.toBe(session.refreshToken);
  });

  it('gets a new device token with the key when the server no longer accepts the old one', async () => {
    const device = client.device;
    if (device === undefined) throw new Error('Not paired');
    const forgetful = new ApiClient({
      baseUrl: url,
      signer: key,
      credentials: {
        device: {
          deviceId: device.deviceId,
          deviceToken: 'not-a-device-token',
          deviceTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    });
    const { staff } = await forgetful.api.listStaffTiles();
    expect(staff.length).toBeGreaterThan(0);
    expect(forgetful.device?.deviceToken).not.toBe('not-a-device-token');
  });
});

describe('[NFR-P11] [NTF-006] the live connection through the client', () => {
  it('receives events, then resumes from the stored point after a restart', async () => {
    const received: DomainEvent[] = [];
    let point: ResumePoint | undefined;
    const statuses: ConnectionStatus[] = [];
    const connection = client.connectRealtime({
      onEvent: (event) => received.push(event),
      onResumePoint: (resume) => {
        point = resume;
      },
      onStatus: (status) => statuses.push(status),
    });
    connection.start();
    await until(() => connection.status === 'online', 5_000, 'the connection');

    const live = domainEvent('MenuPublished', restaurantId, { menuVersion: 2 });
    await produce(app, [live]);
    await until(() => received.some((event) => event.eventId === live.eventId));
    connection.stop();
    expect(statuses).toEqual(['connecting', 'online', 'stopped']);

    const missed = domainEvent('MenuPublished', restaurantId, { menuVersion: 3 });
    await produce(app, [missed]);
    await app.get(EventBus).drain();

    const again: DomainEvent[] = [];
    const syncs: RealtimeSync[] = [];
    const resumed = client.connectRealtime({
      ...(point !== undefined && { resume: point }),
      onEvent: (event) => again.push(event),
      onSync: (sync) => syncs.push(sync),
    });
    resumed.start();
    await until(() => syncs[0], 5_000, 'the resync');
    expect(syncs[0]).toMatchObject({ fullRefresh: false, replayed: 1 });
    expect(again.map((event) => event.eventId)).toEqual([missed.eventId]);
    resumed.stop();
  });

  it('keeps the device connected when the person’s session ends on the server', async () => {
    const endedCodes: string[] = [];
    const waiterDevice = new ApiClient({
      baseUrl: url,
      signer: key,
      credentials: { device: client.device },
      onSessionEnded: (code) => endedCodes.push(code),
    });
    const session = await waiterDevice.signInWithPin({
      staffId: kit.staff.WAITER,
      pin: TEST_PINS.WAITER,
    });
    const endings: RealtimeEndReason[] = [];
    const syncs: RealtimeSync[] = [];
    const connection = waiterDevice.connectRealtime({
      onEvent: () => undefined,
      onEnded: (reason) => endings.push(reason),
      onSync: (sync) => syncs.push(sync),
    });
    connection.start();
    await until(() => syncs.length === 1, 5_000, 'the first sync');

    await prisma.session.update({
      where: { id: session.session.id },
      data: { revokedAt: new Date() },
    });

    await until(() => syncs.length === 2, 5_000, 'the reconnection');
    expect(endings).toEqual(['SESSION_ENDED']);
    expect(endedCodes).toEqual(['SESSION_ENDED']);
    expect(waiterDevice.session).toBeUndefined();
    expect(connection.status).toBe('online');
    connection.stop();
  });

  it('[AUTH-008] stops and tells the app when a manager unpairs the device', async () => {
    const revoked = vi.fn();
    const doomed = new ApiClient({
      baseUrl: url,
      signer: key,
      credentials: client.credentials,
      onDeviceRevoked: revoked,
    });
    const connection = doomed.connectRealtime({ onEvent: () => undefined });
    connection.start();
    await until(() => connection.status === 'online', 5_000, 'the connection');

    const manager = await signIn(app, kit, 'MANAGER');
    await request(httpServer(app))
      .post(`/api/v1/devices/${deviceId}/revoke`)
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ reason: 'Replaced by a new till' })
      .expect(200);

    await until(() => connection.status === 'stopped', 5_000, 'the connection to stop');
    expect(revoked).toHaveBeenCalledOnce();
    expect(doomed.credentials).toEqual({});
    await expect(
      new ApiClient({
        baseUrl: url,
        signer: key,
        credentials: client.credentials,
      }).api.listStaffTiles(),
    ).rejects.toMatchObject({ code: 'DEVICE_AUTH_FAILED' });
  });
});
