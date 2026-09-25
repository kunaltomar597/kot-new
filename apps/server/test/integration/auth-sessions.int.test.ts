import type { INestApplication } from '@nestjs/common';
import { ApiError, LoginResponse } from '@rp/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authSettingKey, AuthSettingsService } from '../../src/auth/auth-settings.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
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
const minutes = (count: number) => {
  vi.setSystemTime(Date.now() + count * 60_000);
};

function me(deviceId: string, token: string) {
  return server().get('/api/v1/probe-auth/me').set(authHeaders(deviceId, token));
}

function refresh(deviceId: string, refreshToken: string) {
  return server().post('/api/v1/auth/refresh').set(authHeaders(deviceId)).send({ refreshToken });
}

const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

describe('[AUTH-005] access tokens', () => {
  it('are required, and only accepted from the device they were issued to', async () => {
    expect(codeOf(await server().get('/api/v1/probe-auth/me').set(authHeaders(kit.deviceId)))).toBe(
      'UNAUTHENTICATED',
    );
    const session = await signIn(app, kit, 'CASHIER');
    const otherDevice = await addDevice(app, kit);
    expect(codeOf(await me(otherDevice, session.accessToken))).toBe('DEVICE_MISMATCH');
    expect((await me(kit.deviceId, session.accessToken)).status).toBe(200);
    expect(codeOf(await me(kit.deviceId, 'not.a.token'))).toBe('TOKEN_INVALID');
    const garbage = await server()
      .get('/api/v1/probe-auth/me')
      .set(authHeaders(kit.deviceId))
      .set('authorization', 'Basic abc');
    expect(codeOf(garbage)).toBe('UNAUTHENTICATED');
  });

  it('expire after 15 minutes and are renewed with a rotated refresh token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const session = await signIn(app, kit, 'CASHIER');
    minutes(9);
    const renewed = LoginResponse.parse((await refresh(kit.deviceId, session.refreshToken)).body);
    expect(renewed.refreshToken).not.toBe(session.refreshToken);
    minutes(7);
    expect(codeOf(await me(kit.deviceId, session.accessToken))).toBe('TOKEN_EXPIRED');
    expect((await me(kit.deviceId, renewed.accessToken)).status).toBe(200);
  });
});

describe('[AUTH-005] inactivity', () => {
  it('ends a POS session after 10 idle minutes; activity keeps it alive', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const session = await signIn(app, kit, 'WAITER');
    minutes(8);
    expect((await me(kit.deviceId, session.accessToken)).status).toBe(200);
    minutes(8);
    // 16 minutes since sign-in but only 8 idle: still signed in (the token itself is renewed).
    const renewed = LoginResponse.parse((await refresh(kit.deviceId, session.refreshToken)).body);
    minutes(11);
    expect(codeOf(await me(kit.deviceId, renewed.accessToken))).toBe('SESSION_EXPIRED');
    expect(codeOf(await refresh(kit.deviceId, renewed.refreshToken))).toBe('SESSION_REVOKED');
    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.session.id } });
    expect(row.revokeReason).toBe('INACTIVITY');
  });

  it('gives manager browsers 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const browser = await addDevice(app, kit, 'MANAGER_BROWSER');
    const session = await signIn(app, kit, 'MANAGER', browser);
    expect(session.session.inactivityTimeoutSeconds).toBe(1800);
    minutes(12);
    expect((await me(browser, session.accessToken)).status).toBe(200);
  });
});

describe('[AUTH-005] refresh tokens', () => {
  it('revoke the whole session when a replaced refresh token is used again', async () => {
    const session = await signIn(app, kit, 'CASHIER');
    const renewed = LoginResponse.parse((await refresh(kit.deviceId, session.refreshToken)).body);
    const replay = await refresh(kit.deviceId, session.refreshToken);
    expect(codeOf(replay)).toBe('SESSION_REVOKED');
    expect(codeOf(await me(kit.deviceId, renewed.accessToken))).toBe('SESSION_REVOKED');
    expect(codeOf(await refresh(kit.deviceId, renewed.refreshToken))).toBe('SESSION_REVOKED');
    expect(
      await prisma.auditLog.count({
        where: { action: 'REFRESH_TOKEN_REUSED', entityId: session.session.id },
      }),
    ).toBe(1);
  });

  it('only work on the device they were issued to', async () => {
    const session = await signIn(app, kit, 'CASHIER');
    const other = await addDevice(app, kit);
    expect(codeOf(await refresh(other, session.refreshToken))).toBe('DEVICE_MISMATCH');
    expect(codeOf(await refresh(kit.deviceId, 'x'.repeat(43)))).toBe('SESSION_REVOKED');
  });

  it('stop at the absolute session length whatever the activity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const [name, value] of [
      ['sessionMaxHours', 1],
      ['inactivityMinutes', 240],
    ] as const) {
      await prisma.setting.upsert({
        where: { restaurantId_key: { restaurantId: kit.restaurantId, key: authSettingKey(name) } },
        create: { restaurantId: kit.restaurantId, key: authSettingKey(name), value },
        update: { value },
      });
    }
    app.get(AuthSettingsService).invalidate();
    const deviceId = await addDevice(app, kit);
    let tokens = await signIn(app, kit, 'MANAGER', deviceId);
    for (let step = 0; step < 4; step += 1) {
      minutes(14);
      tokens = LoginResponse.parse((await refresh(deviceId, tokens.refreshToken)).body);
    }
    // 56 minutes in: the access token is cut to the 4 minutes the session has left.
    expect(Date.parse(tokens.accessTokenExpiresAt)).toBeLessThanOrEqual(
      Date.parse(tokens.session.expiresAt),
    );
    minutes(5);
    expect(codeOf(await refresh(deviceId, tokens.refreshToken))).toBe('SESSION_EXPIRED');
    await prisma.setting.deleteMany({
      where: {
        key: { in: [authSettingKey('sessionMaxHours'), authSettingKey('inactivityMinutes')] },
      },
    });
    app.get(AuthSettingsService).invalidate();
  });
});

describe('[AUTH-005] [AUTH-013] logout and deactivation', () => {
  it('logout ends the session and is audited', async () => {
    const session = await signIn(app, kit, 'CASHIER');
    const response = await server()
      .post('/api/v1/auth/logout')
      .set(authHeaders(kit.deviceId, session.accessToken));
    expect(response.status).toBe(204);
    expect(codeOf(await me(kit.deviceId, session.accessToken))).toBe('SESSION_REVOKED');
    expect(codeOf(await refresh(kit.deviceId, session.refreshToken))).toBe('SESSION_REVOKED');
    expect(
      await prisma.auditLog.count({ where: { action: 'LOGOUT', entityId: session.session.id } }),
    ).toBe(1);
  });

  it('a deactivated person is signed out at their next request', async () => {
    const staff = await prisma.staff.create({
      data: {
        restaurantId: kit.restaurantId,
        roleId: (await prisma.role.findFirstOrThrow({ where: { key: 'WAITER' } })).id,
        displayName: 'Leaving waiter',
      },
    });
    await prisma.credential.create({
      data: {
        restaurantId: kit.restaurantId,
        staffId: staff.id,
        kind: 'PIN',
        secretHash: (
          await prisma.credential.findFirstOrThrow({
            where: { staffId: kit.staff.WAITER, kind: 'PIN' },
          })
        ).secretHash,
      },
    });
    const session = LoginResponse.parse(
      (
        await server()
          .post('/api/v1/auth/pin-login')
          .set(authHeaders(kit.deviceId))
          .send({ staffId: staff.id, pin: '4444' })
      ).body,
    );
    await prisma.staff.update({ where: { id: staff.id }, data: { active: false } });
    expect(codeOf(await me(kit.deviceId, session.accessToken))).toBe('SESSION_REVOKED');
  });

  it('a role change applies at the next request', async () => {
    const session = await signIn(app, kit, 'CASHIER');
    const waiterRole = await prisma.role.findFirstOrThrow({ where: { key: 'WAITER' } });
    const cashierRole = await prisma.role.findFirstOrThrow({ where: { key: 'CASHIER' } });
    await prisma.staff.update({
      where: { id: kit.staff.CASHIER },
      data: { roleId: waiterRole.id },
    });
    const response = await me(kit.deviceId, session.accessToken);
    expect(response.body).toMatchObject({ principal: { role: 'WAITER' } });
    await prisma.staff.update({
      where: { id: kit.staff.CASHIER },
      data: { roleId: cashierRole.id },
    });
  });
});
