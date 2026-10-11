import type { INestApplication } from '@nestjs/common';
import { ApiError, DeviceView, LoginResponse, StaffTilesResponse } from '@rp/contracts';
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

describe('[PC-S5] [PC-D2] lockouts reach the managers', () => {
  it('alerts the managers and the Owner when a login locks, and clears it when it is unlocked', async () => {
    const deviceId = await addDevice(app, kit);
    const staffId = await addStaff(app, kit, 'CASHIER');
    for (let attempt = 1; attempt <= 5; attempt += 1) await pinLogin(deviceId, staffId, '9999');
    const alert = await prisma.alert.findFirstOrThrow({
      where: { type: 'SIGN_IN_LOCKED', dedupeKey: `lockout:staff:${staffId}` },
    });
    expect(alert.status).toBe('OPEN');
    expect(alert.recipientIds).toEqual(expect.arrayContaining([kit.staff.OWNER]));
    expect(alert.payload).toMatchObject({
      scope: 'PERSON',
      staffId,
      staffName: 'Extra cashier',
      deviceId,
      method: 'PIN',
    });

    const manager = await signIn(app, kit, 'MANAGER');
    const unlocked = await server()
      .post('/api/v1/auth/unlock')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ staffId });
    expect(unlocked.status).toBe(204);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe(
      'CLEARED',
    );
  });
});

describe('[PC-S5] [SEC-009] wrong PINs counted per device', () => {
  it('stops a device taking any PIN after 10 wrong ones for anyone, spread over people', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const deviceId = await addDevice(app, kit);
    const people: string[] = [];
    for (let person = 1; person <= 5; person += 1) people.push(await addStaff(app, kit, 'WAITER'));
    const codes: string[] = [];
    let last: ApiError | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // Two wrong PINs each: far from any one person's lockout.
      last = ApiError.parse((await pinLogin(deviceId, people[attempt % 5] ?? '', '9999')).body);
      codes.push(last.code);
      vi.setSystemTime(Date.now() + 30_000);
    }
    expect(codes.slice(0, 9).every((code) => code === 'INVALID_CREDENTIALS')).toBe(true);
    expect(codes[9]).toBe('DEVICE_LOCKED');
    expect(last?.details).toHaveProperty('lockedUntil');
    expect(await auditCount('DEVICE_PINS_LOCKED', deviceId)).toBe(1);
    for (const person of people) expect(await auditCount('LOGIN_LOCKED', person)).toBe(0);

    // The right PIN is refused here too, and audited; on another device it works.
    const right = await pinLogin(deviceId, kit.staff.MANAGER, TEST_PINS.MANAGER);
    expect(right.status).toBe(423);
    expect(ApiError.parse(right.body).code).toBe('DEVICE_LOCKED');
    expect(
      await prisma.auditLog.count({
        where: { action: 'LOGIN_FAILED', deviceId, reason: 'This device takes no PINs for now' },
      }),
    ).toBe(1);
    expect((await pinLogin(kit.deviceId, people[0] ?? '', TEST_PINS.WAITER)).status).toBe(200);
    const alert = await prisma.alert.findFirstOrThrow({
      where: { type: 'SIGN_IN_LOCKED', dedupeKey: `lockout:device:${deviceId}` },
    });
    expect(alert.payload).toMatchObject({ scope: 'DEVICE', deviceId });

    // After the lockout time it takes PINs again by itself.
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect((await pinLogin(deviceId, kit.staff.MANAGER, TEST_PINS.MANAGER)).status).toBe(200);
  });

  it('says when the device, not the person, is about to stop taking PINs', async () => {
    const deviceId = await addDevice(app, kit);
    await prisma.device.update({
      where: { id: deviceId },
      data: { pinFailures: 8, pinFailureWindowStartedAt: new Date() },
    });
    const response = await pinLogin(deviceId, await addStaff(app, kit, 'WAITER'), '9999');
    const error = ApiError.parse(response.body);
    expect(error.details).toEqual({ attemptsRemaining: 1 });
    expect(error.message).toContain('this device stops taking PINs');
  });

  it('lets a manager, not a waiter, let a device take PINs again at once', async () => {
    const deviceId = await addDevice(app, kit);
    await prisma.device.update({
      where: { id: deviceId },
      data: { pinsLockedUntil: new Date(Date.now() + 15 * 60_000) },
    });
    expect((await pinLogin(deviceId, kit.staff.WAITER, TEST_PINS.WAITER)).status).toBe(423);
    const unlock = async (role: 'WAITER' | 'MANAGER') =>
      server()
        .post(`/api/v1/devices/${deviceId}/pins/unlock`)
        .set(authHeaders(kit.deviceId, (await signIn(app, kit, role)).accessToken));
    expect((await unlock('WAITER')).status).toBe(403);
    const response = await unlock('MANAGER');
    expect(response.status).toBe(200);
    expect(DeviceView.parse(response.body).pinsLockedUntil).toBeNull();
    expect(await auditCount('DEVICE_PINS_UNLOCKED', deviceId)).toBe(1);
    expect((await pinLogin(deviceId, kit.staff.WAITER, TEST_PINS.WAITER)).status).toBe(200);
    const missing = await server()
      .post(`/api/v1/devices/${newId()}/pins/unlock`)
      .set(authHeaders(kit.deviceId, (await signIn(app, kit, 'MANAGER')).accessToken));
    expect(missing.status).toBe(404);
  });
});

describe('[AUTH-005] [MOBILE-E3] inactivity as the app sees it', () => {
  const me = (deviceId: string, accessToken: string, idleSeconds?: number) => {
    const call = server().get('/api/v1/probe-auth/me').set(authHeaders(deviceId, accessToken));
    return idleSeconds === undefined ? call : call.set('x-rp-idle-seconds', String(idleSeconds));
  };

  it('does not keep a session alive with calls the app made by itself while the person was away', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const deviceId = await addDevice(app, kit, 'WAITER_PHONE');
    const session = await signIn(app, kit, 'WAITER', deviceId);
    // The phone reads every minute by itself; nobody touches it after signing in.
    for (let minute = 1; minute <= 9; minute += 1) {
      vi.setSystemTime(start + minute * 60_000);
      expect((await me(deviceId, session.accessToken, minute * 60)).status).toBe(200);
    }
    const refreshed = await server()
      .post('/api/v1/auth/refresh')
      .set(authHeaders(deviceId))
      .set('x-rp-idle-seconds', String(9 * 60))
      .send({ refreshToken: session.refreshToken });
    expect(refreshed.status).toBe(200);
    const renewed = LoginResponse.parse(refreshed.body);
    vi.setSystemTime(start + 10 * 60_000 + 5_000);
    const late = await me(deviceId, renewed.accessToken, 605);
    expect(late.status).toBe(401);
    expect(ApiError.parse(late.body).code).toBe('SESSION_EXPIRED');
  });

  it('keeps it alive as of the last touch, and every call counts without the header', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const deviceId = await addDevice(app, kit, 'WAITER_PHONE');
    const session = await signIn(app, kit, 'WAITER', deviceId);
    // Touched 30 s before this call: active as of 7:30.
    vi.setSystemTime(start + 8 * 60_000);
    expect((await me(deviceId, session.accessToken, 30)).status).toBe(200);
    // 9:30 after that touch the person taps again; the refresh counts it.
    vi.setSystemTime(start + 17 * 60_000);
    const refreshed = await server()
      .post('/api/v1/auth/refresh')
      .set(authHeaders(deviceId))
      .set('x-rp-idle-seconds', '0')
      .send({ refreshToken: session.refreshToken });
    expect(refreshed.status).toBe(200);
    vi.setSystemTime(start + 26 * 60_000);
    const renewed = LoginResponse.parse(refreshed.body);
    expect((await me(deviceId, renewed.accessToken, 0)).status).toBe(200);

    // An app that does not say: every call counts, as before; so does a header that is no number.
    const other = await addDevice(app, kit, 'WAITER_PHONE');
    const old = await signIn(app, kit, 'WAITER', other);
    for (const minute of [30, 34, 38]) {
      vi.setSystemTime(start + minute * 60_000);
      expect((await me(other, old.accessToken)).status).toBe(200);
    }
    vi.setSystemTime(start + 40 * 60_000);
    expect((await me(other, old.accessToken).set('x-rp-idle-seconds', 'soon')).status).toBe(200);
    const row = await prisma.session.findUniqueOrThrow({ where: { id: old.session.id } });
    expect(row.lastActiveAt.getTime()).toBe(Date.now());
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
