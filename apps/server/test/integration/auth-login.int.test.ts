import type { INestApplication } from '@nestjs/common';
import { ApiError, LoginResponse, StaffTilesResponse } from '@rp/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authSettingKey, AuthSettingsService } from '../../src/auth/auth-settings.js';
import { newId } from '../../src/common/ids.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  addDevice,
  addStaff,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
  TEST_PINS,
} from '../helpers/auth-kit.js';
import { AuthProbeController } from '../helpers/auth-probe.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, controllers: [AuthProbeController] });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

afterEach(() => {
  vi.useRealTimers();
});

const server = () => request(httpServer(app));

function pinLogin(deviceId: string, staffId: string, pin: string) {
  return server().post('/api/v1/auth/pin-login').set(authHeaders(deviceId)).send({ staffId, pin });
}

async function auditCount(action: string, entityId?: string) {
  return prisma.auditLog.count({ where: { action, ...(entityId !== undefined && { entityId }) } });
}

describe('[AUTH-007] only paired devices reach the login screen', () => {
  it('refuses the staff tiles and PIN login to an unknown device, even with a valid PIN', async () => {
    const tiles = await server().get('/api/v1/auth/staff-tiles');
    expect(tiles.status).toBe(401);
    expect(ApiError.parse(tiles.body).code).toBe('DEVICE_NOT_RECOGNISED');
    const login = await pinLogin(newId(), kit.staff.CASHIER, TEST_PINS.CASHIER);
    expect(login.status).toBe(401);
    expect(ApiError.parse(login.body).code).toBe('DEVICE_NOT_RECOGNISED');
  });

  it('refuses a revoked device', async () => {
    const deviceId = await addDevice(app, kit);
    await prisma.device.update({ where: { id: deviceId }, data: { status: 'REVOKED' } });
    expect((await pinLogin(deviceId, kit.staff.CASHIER, TEST_PINS.CASHIER)).status).toBe(401);
  });
});

describe('[AUTH-001] staff tiles', () => {
  it('lists active staff with a PIN, with names and roles but nothing about PINs', async () => {
    const response = await server().get('/api/v1/auth/staff-tiles').set(authHeaders(kit.deviceId));
    expect(response.status).toBe(200);
    const body = StaffTilesResponse.parse(response.body);
    expect(body.staff.map((tile) => tile.role).sort()).toEqual([
      'CASHIER',
      'KITCHEN',
      'MANAGER',
      'OWNER',
      'WAITER',
    ]);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/secret|hash|pin/i);
  });
});

describe('[AUTH-001] [AUTH-002] [AUTH-005] PIN login', () => {
  it('signs in and returns tokens bound to the person, role, restaurant and device', async () => {
    const response = await pinLogin(kit.deviceId, kit.staff.CASHIER, TEST_PINS.CASHIER);
    expect(response.status).toBe(200);
    const body = LoginResponse.parse(response.body);
    expect(body.staff).toMatchObject({ id: kit.staff.CASHIER, role: 'CASHIER' });
    expect(body.session.inactivityTimeoutSeconds).toBe(600);
    const expiresIn = Date.parse(body.accessTokenExpiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(14 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(15 * 60_000);
    expect(body.secondFactorValidUntil).toBeNull();

    const me = await server()
      .get('/api/v1/probe-auth/me')
      .set(authHeaders(kit.deviceId, body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      principal: {
        staffId: kit.staff.CASHIER,
        role: 'CASHIER',
        restaurantId: kit.restaurantId,
        deviceId: kit.deviceId,
        sessionId: body.session.id,
      },
    });
    expect(await auditCount('LOGIN', body.session.id)).toBe(1);
  });

  it('stores only a hash of the refresh token', async () => {
    const body = await signIn(app, kit, 'WAITER');
    const session = await prisma.session.findUniqueOrThrow({ where: { id: body.session.id } });
    expect(session.tokenHash).not.toBe(body.refreshToken);
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a wrong PIN, an unknown person and an archived person alike', async () => {
    const deviceId = await addDevice(app, kit);
    const waiter = await addStaff(app, kit, 'WAITER');
    const wrong = await pinLogin(deviceId, waiter, '0000');
    expect(wrong.status).toBe(401);
    expect(ApiError.parse(wrong.body)).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      details: { attemptsRemaining: 4 },
    });
    const unknown = await pinLogin(deviceId, newId(), '1234');
    expect(ApiError.parse(unknown.body).code).toBe('INVALID_CREDENTIALS');

    const archived = await prisma.staff.create({
      data: {
        restaurantId: kit.restaurantId,
        roleId: (await prisma.role.findFirstOrThrow({ where: { key: 'WAITER' } })).id,
        displayName: 'Former waiter',
        active: false,
      },
    });
    expect(ApiError.parse((await pinLogin(deviceId, archived.id, '4444')).body).code).toBe(
      'INVALID_CREDENTIALS',
    );
    expect(await auditCount('LOGIN_FAILED', waiter)).toBe(1);
  });

  it('keeps kitchen staff in station mode unless individual kitchen logins are on', async () => {
    await prisma.setting.update({
      where: {
        restaurantId_key: {
          restaurantId: kit.restaurantId,
          key: authSettingKey('kitchenIndividualLogins'),
        },
      },
      data: { value: false },
    });
    app.get(AuthSettingsService).invalidate();
    const response = await pinLogin(kit.deviceId, kit.staff.KITCHEN, TEST_PINS.KITCHEN);
    expect(response.status).toBe(403);
    expect(ApiError.parse(response.body).code).toBe('KITCHEN_STATION_MODE');
    await prisma.setting.update({
      where: {
        restaurantId_key: {
          restaurantId: kit.restaurantId,
          key: authSettingKey('kitchenIndividualLogins'),
        },
      },
      data: { value: true },
    });
    app.get(AuthSettingsService).invalidate();
    expect((await pinLogin(kit.deviceId, kit.staff.KITCHEN, TEST_PINS.KITCHEN)).status).toBe(200);
  });

  it('rejects malformed requests before checking anything', async () => {
    const response = await server()
      .post('/api/v1/auth/pin-login')
      .set(authHeaders(kit.deviceId))
      .send({ staffId: kit.staff.CASHIER, pin: '12a4', extra: true });
    expect(response.status).toBe(400);
  });
});

describe('[AUTH-003] [AUTH-013] lockout', () => {
  it('locks after 5 failures in 10 minutes, for 15 minutes, and audits it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const deviceId = await addDevice(app, kit);
    const staffId = await addStaff(app, kit, 'CASHIER');
    const codes: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await pinLogin(deviceId, staffId, '9999');
      codes.push(ApiError.parse(response.body).code);
      vi.setSystemTime(Date.now() + 60_000);
    }
    expect(codes).toEqual([
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'ACCOUNT_LOCKED',
    ]);
    const locked = await pinLogin(deviceId, staffId, TEST_PINS.CASHIER);
    expect(locked.status).toBe(423);
    expect(ApiError.parse(locked.body).details).toHaveProperty('lockedUntil');
    expect(await auditCount('LOGIN_LOCKED', staffId)).toBe(1);

    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect((await pinLogin(deviceId, staffId, TEST_PINS.CASHIER)).status).toBe(200);
  });

  it('starts a new window when failures are more than 10 minutes apart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const deviceId = await addDevice(app, kit);
    const staffId = await addStaff(app, kit, 'WAITER');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await pinLogin(deviceId, staffId, '9999');
    }
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const response = await pinLogin(deviceId, staffId, '9999');
    expect(ApiError.parse(response.body).details).toEqual({ attemptsRemaining: 4 });
  });

  it('lets a manager unlock a locked login, and nobody else', async () => {
    const deviceId = await addDevice(app, kit);
    const locked = await addStaff(app, kit, 'KITCHEN');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await pinLogin(deviceId, locked, '9999');
    }
    expect((await pinLogin(deviceId, locked, TEST_PINS.KITCHEN)).status).toBe(423);

    const waiter = await signIn(app, kit, 'WAITER');
    const refused = await server()
      .post('/api/v1/auth/unlock')
      .set(authHeaders(kit.deviceId, waiter.accessToken))
      .send({ staffId: locked });
    expect(refused.status).toBe(403);

    const manager = await signIn(app, kit, 'MANAGER');
    const unlocked = await server()
      .post('/api/v1/auth/unlock')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ staffId: locked });
    expect(unlocked.status).toBe(204);
    expect(await auditCount('STAFF_UNLOCKED', locked)).toBe(1);
    expect((await pinLogin(deviceId, locked, TEST_PINS.KITCHEN)).status).toBe(200);
  });
});

describe('[SEC-009] rate limiting per device', () => {
  it('refuses the 11th attempt within a minute from one device, but not from another', async () => {
    const deviceId = await addDevice(app, kit);
    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      statuses.push((await pinLogin(deviceId, newId(), '1234')).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const other = await addDevice(app, kit);
    expect((await pinLogin(other, kit.staff.MANAGER, TEST_PINS.MANAGER)).status).toBe(200);
  });
});

describe('[AUTH-005] auth settings', () => {
  it('falls back to the default when a stored value is invalid', async () => {
    await prisma.setting.create({
      data: {
        restaurantId: kit.restaurantId,
        key: authSettingKey('accessTokenMinutes'),
        value: 60,
      },
    });
    const settings = app.get(AuthSettingsService);
    settings.invalidate();
    expect((await settings.get(kit.restaurantId)).accessTokenMinutes).toBe(15);
  });
});
