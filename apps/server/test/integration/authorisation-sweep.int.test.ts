import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type DeviceType,
  HTTP_DEVICE_TYPES,
  ROUTES,
  type RouteDefinition,
  STAFF_DEVICE_TYPES,
} from '@rp/contracts';
import {
  CAPABILITIES,
  type Capability,
  DEFAULT_PERMISSION_MATRIX,
  OWNER_SECOND_FACTOR_CAPABILITIES,
  ROLES,
  type Role,
} from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authSettingKey, AuthSettingsService } from '../../src/auth/auth-settings.js';
import type { RouteAccess } from '../../src/auth/decorators.js';
import { randomToken, sha256Hex, TokenService } from '../../src/auth/tokens.js';
import { newId } from '../../src/common/ids.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
  TEST_PINS,
} from '../helpers/auth-kit.js';
import { servedRoutes } from '../helpers/served-routes.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * The authorisation sweep (SEC-017 "automated authorisation tests", SEC-003, AUTH-010): every
 * endpoint in the route registry is called the way an attacker would, and must be refused by the
 * permission guard before any work is done. Calls that would be allowed are not made here; each
 * feature's own tests cover what an allowed caller may do, including the object-level checks
 * (a waiter's own tables, a cashier's own shift, a tablet's own table).
 */

type Route = RouteDefinition;
const routes: readonly Route[] = ROUTES;

/** The capability a route needs, if it names one (not `SESSION`, `DEVICE` or `PUBLIC`). */
const capabilityOf = (route: Route): Capability | undefined =>
  (CAPABILITIES as readonly string[]).includes(route.capability)
    ? (route.capability as Capability)
    : undefined;

/**
 * The endpoints anyone may call, each reviewed: widening this list is a security decision
 * (docs/security/authorisation.md). Each says why in its registry description.
 */
const PUBLIC_ROUTES = [
  'GET /api/v1/health',
  'GET /api/v1/version',
  'GET /api/v1/first-run',
  'POST /api/v1/first-run',
  'GET /api/v1/tls/ca',
  'POST /api/v1/devices/pairing-codes/bootstrap',
  'POST /api/v1/devices/pair',
  'POST /api/v1/devices/challenge',
  'POST /api/v1/devices/token',
  'GET /api/v1/photos/:id/:width',
  'GET /api/v1/pager-firmware/:token',
].sort();

const DEVICE_TYPES: readonly DeviceType[] = [...HTTP_DEVICE_TYPES, 'PAGER'];

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
/** One paired device of every kind, the POS being the kit's own. */
const devices = {} as Record<DeviceType, string>;
/** One person of every role, signed in on the kit's POS. */
const sessions = {} as Record<Role, string>;
/** Served access per route, for what the registry does not say (station mode). */
const access = new Map<string, RouteAccess | undefined>();

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  const section = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Sweep' },
  });
  const table = await prisma.diningTable.create({
    data: { restaurantId: kit.restaurantId, sectionId: section.id, label: 'S1' },
  });
  devices.POS = kit.deviceId;
  devices.MANAGER_BROWSER = await addDevice(app, kit, 'MANAGER_BROWSER');
  devices.KDS = await addDevice(app, kit, 'KDS');
  devices.WAITER_PHONE = await addDevice(app, kit, 'WAITER_PHONE');
  devices.TABLE_TABLET = await addDevice(app, kit, 'TABLE_TABLET', { tableId: table.id });
  // A pager never gets a device key (no pairing code makes one); this one has one anyway, to show
  // it would still reach nothing.
  devices.PAGER = await addDevice(app, kit, 'PAGER', { staffId: kit.staff.WAITER });
  for (const role of ROLES) sessions[role] = (await signIn(app, kit, role)).accessToken;
  for (const route of servedRoutes(app)) access.set(`${route.method} ${route.path}`, route.access);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const key = (route: Route) => `${route.method} ${route.path}`;

/** The route's path with a fresh id for every parameter: the guard decides before any lookup. */
const pathOf = (route: Route) => route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, () => newId());

function call(route: Route, headers: Record<string, string>): Promise<request.Response> {
  const agent = request(httpServer(app));
  const path = pathOf(route);
  const pending =
    route.method === 'GET'
      ? agent.get(path)
      : route.method === 'POST'
        ? agent.post(path)
        : route.method === 'PUT'
          ? agent.put(path)
          : route.method === 'PATCH'
            ? agent.patch(path)
            : agent.delete(path);
  return pending.set(headers);
}

interface Expectation {
  readonly route: Route;
  readonly headers: Record<string, string>;
  readonly status: number;
  readonly code: string;
}

/**
 * Makes every call (a few at a time) and returns the ones that did not get exactly the expected
 * refusal, as readable lines, so a failure names each endpoint and what it answered.
 */
async function mismatches(expectations: readonly Expectation[]): Promise<string[]> {
  const found: string[] = [];
  const queue = [...expectations];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const response = await call(next.route, next.headers);
      const parsed = ApiError.safeParse(response.body);
      const code = parsed.success ? parsed.data.code : '(no API error)';
      if (response.status !== next.status || code !== next.code) {
        found.push(
          `${key(next.route)}: expected ${String(next.status)} ${next.code}, got ` +
            `${String(response.status)} ${code}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return found.sort();
}

const isPublic = (route: Route) => route.capability === 'PUBLIC';
const isDevice = (route: Route) => route.capability === 'DEVICE';
/** Endpoints that need a signed-in person: `SESSION` or a capability. */
const needsPerson = (route: Route) => !isPublic(route) && !isDevice(route);

describe('[SEC-017] [SEC-003] [AUTH-010] the authorisation sweep over every endpoint', () => {
  it('covers the whole registry, and only the reviewed endpoints are open to anyone', () => {
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.filter(isPublic).map(key).sort()).toEqual(PUBLIC_ROUTES);
    for (const route of routes) expect(access.has(key(route)), key(route)).toBe(true);
  });

  it('refuses every other endpoint without a paired device', async () => {
    const expected = routes
      .filter((route) => !isPublic(route))
      .map((route) => ({
        route,
        headers: {},
        status: 401,
        code: 'DEVICE_NOT_RECOGNISED',
      }));
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[AUTH-008] refuses an unpaired device, also with the token of someone signed in on it', async () => {
    const revoked = await addDevice(app, kit, 'POS');
    const before = (await signIn(app, kit, 'MANAGER', revoked)).accessToken;
    await prisma.device.update({
      where: { id: revoked },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    const expected = routes
      .filter((route) => !isPublic(route))
      .flatMap((route) => [
        { route, headers: authHeaders(revoked), status: 401, code: 'DEVICE_NOT_RECOGNISED' },
        {
          route,
          headers: authHeaders(revoked, before),
          status: 401,
          code: needsPerson(route) ? 'DEVICE_MISMATCH' : 'DEVICE_NOT_RECOGNISED',
        },
      ]);
    expect(await mismatches(expected)).toEqual([]);
  });

  it('refuses each device endpoint to every kind of device it does not serve', async () => {
    const expected = routes.filter(isDevice).flatMap((route) =>
      DEVICE_TYPES.filter((type) => !(route.devices ?? []).includes(type)).map((type) => ({
        route,
        headers: authHeaders(devices[type]),
        status: 403,
        code: 'DEVICE_NOT_ALLOWED',
      })),
    );
    // Every device endpoint is closed to pagers, and only the table tablet's own are open to it.
    expect(expected.length).toBeGreaterThan(routes.filter(isDevice).length);
    expect(await mismatches(expected)).toEqual([]);
  });

  it('asks every device for a signed-in person where one is needed', async () => {
    const expected = routes.filter(needsPerson).flatMap((route) =>
      DEVICE_TYPES.map((type) => ({
        route,
        headers: authHeaders(devices[type]),
        status: 401,
        code: 'UNAUTHENTICATED',
      })),
    );
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[AUTH-005] [AUTH-007] refuses a sign-in presented from another device', async () => {
    const expected = routes.filter(needsPerson).map((route) => ({
      route,
      headers: authHeaders(devices.MANAGER_BROWSER, sessions.MANAGER),
      status: 401,
      code: 'DEVICE_MISMATCH',
    }));
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[AUTH-005] refuses a sign-in after signing out', async () => {
    const token = (await signIn(app, kit, 'OWNER')).accessToken;
    const out = await request(httpServer(app))
      .post('/api/v1/auth/logout')
      .set(authHeaders(kit.deviceId, token));
    expect(out.status).toBe(204);
    const expected = routes.filter(needsPerson).map((route) => ({
      route,
      headers: authHeaders(kit.deviceId, token),
      status: 401,
      code: 'SESSION_REVOKED',
    }));
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[AUTH-010] refuses each role what §4.2 does not give it, before doing anything', async () => {
    const expected = routes.flatMap((route) => {
      const capability = capabilityOf(route);
      if (capability === undefined) return [];
      return ROLES.flatMap((role) => {
        const grant = DEFAULT_PERMISSION_MATRIX[capability][role];
        const headers = authHeaders(kit.deviceId, sessions[role]);
        if (grant === 'DENY') return [{ route, headers, status: 403, code: 'FORBIDDEN' }];
        if (grant === 'OVERRIDE') {
          return [{ route, headers, status: 403, code: 'OVERRIDE_REQUIRED' }];
        }
        // The Owner signed in with a PIN, so an Owner-only action asks for the second factor.
        if (grant === 'ALLOW' && OWNER_SECOND_FACTOR_CAPABILITIES.has(capability)) {
          return [{ route, headers, status: 403, code: 'SECOND_FACTOR_REQUIRED' }];
        }
        return [];
      });
    });
    expect(expected.length).toBeGreaterThan(300);
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[AUTH-005] lets a kitchen screen with nobody signed in reach only its station’s endpoints', async () => {
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
    try {
      const station = (route: Route) => {
        const served = access.get(key(route));
        if (served?.kind === 'SESSION') return served.stationMode === true;
        if (served?.kind !== 'CAPABILITY' || served.stationMode !== true) return false;
        return DEFAULT_PERMISSION_MATRIX[served.capability].KITCHEN === 'ALLOW';
      };
      const open = routes.filter(needsPerson).filter(station);
      // The tickets, their steps, recall and "notify manager" (KDS-001 to KDS-009).
      expect(open.length).toBeGreaterThan(3);
      const expected = routes
        .filter(needsPerson)
        .filter((route) => !station(route))
        .map((route) => ({
          route,
          headers: authHeaders(devices.KDS),
          status: 401,
          code: 'UNAUTHENTICATED',
        }));
      expect(await mismatches(expected)).toEqual([]);
    } finally {
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
    }
  });
});

describe('[AUTH-009] [SEC-003] people sign in only on staff devices', () => {
  it('lists the devices staff sign in on', () => {
    expect([...STAFF_DEVICE_TYPES].sort()).toEqual([
      'KDS',
      'MANAGER_BROWSER',
      'POS',
      'WAITER_PHONE',
    ]);
  });

  it('refuses a PIN or Owner sign-in on a table tablet or a pager, and counts no attempt', async () => {
    for (const type of ['TABLE_TABLET', 'PAGER'] as const) {
      const pin = await request(httpServer(app))
        .post('/api/v1/auth/pin-login')
        .set(authHeaders(devices[type]))
        .send({ staffId: kit.staff.MANAGER, pin: TEST_PINS.MANAGER });
      expect(pin.status).toBe(403);
      expect(ApiError.parse(pin.body).code).toBe('DEVICE_NOT_ALLOWED');
      const owner = await request(httpServer(app))
        .post('/api/v1/auth/owner-login')
        .set(authHeaders(devices[type]))
        .send({
          staffId: kit.staff.OWNER,
          password: 'not checked at all',
          secondFactor: { kind: 'TOTP', code: '000000' },
        });
      expect(owner.status).toBe(403);
    }
    expect(
      await prisma.session.count({
        where: { deviceId: { in: [devices.TABLE_TABLET, devices.PAGER] } },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'LOGIN_FAILED', deviceId: devices.TABLE_TABLET },
      }),
    ).toBe(0);
  });

  it('gives a session on a table tablet nothing, however it was made', async () => {
    const session = await prisma.session.create({
      data: {
        restaurantId: kit.restaurantId,
        staffId: kit.staff.MANAGER,
        deviceId: devices.TABLE_TABLET,
        tokenHash: sha256Hex(randomToken()),
        expiresAt: new Date(Date.now() + 3_600_000),
        lastActiveAt: new Date(),
      },
    });
    const { token } = await app.get(TokenService).signAccessToken(
      {
        staffId: kit.staff.MANAGER,
        role: 'MANAGER',
        restaurantId: kit.restaurantId,
        deviceId: devices.TABLE_TABLET,
        sessionId: session.id,
      },
      600,
      new Date(),
    );
    const expected = routes.filter(needsPerson).map((route) => ({
      route,
      headers: authHeaders(devices.TABLE_TABLET, token),
      status: 403,
      code: 'DEVICE_NOT_ALLOWED',
    }));
    expect(await mismatches(expected)).toEqual([]);
  });
});
