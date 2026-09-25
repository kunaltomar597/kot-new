import { Writable } from 'node:stream';
import { type INestApplication, RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { ApiError, OverrideResponse, ROUTES } from '@rp/contracts';
import {
  CAPABILITIES,
  type Capability,
  DEFAULT_PERMISSION_MATRIX,
  OWNER_SECOND_FACTOR_CAPABILITIES,
  ROLES,
  type Role,
} from '@rp/domain';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROUTE_ACCESS, type RouteAccess } from '../../src/auth/decorators.js';
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
import { AuthProbeController, MatrixProbeController } from '../helpers/auth-probe.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const logLines: string[] = [];
const logSink = new Writable({
  write(chunk: Buffer | string, _encoding, done) {
    logLines.push(chunk.toString());
    done();
  },
});

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
const sessions = {} as Record<Role, { accessToken: string; refreshToken: string }>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { logLevel: 'trace' },
    logDestination: logSink,
    controllers: [AuthProbeController, MatrixProbeController],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  for (const role of ROLES) sessions[role] = await signIn(app, kit, role);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

afterEach(() => {
  vi.useRealTimers();
});

const server = () => request(httpServer(app));
const as = (role: Role) => authHeaders(kit.deviceId, sessions[role].accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

function override(role: Role, body: Record<string, unknown>) {
  return server().post('/api/v1/auth/override').set(as(role)).send(body);
}

describe('[AUTH-010] [SEC-003] every capability row of the permission matrix', () => {
  const cases = ROLES.flatMap((role) =>
    CAPABILITIES.map((capability) => [role, capability] as const),
  );

  it.each(cases)('%s → %s', async (role: Role, capability: Capability) => {
    const response = await server().post(`/api/v1/probe-matrix/${capability}`).set(as(role));
    const grant = DEFAULT_PERMISSION_MATRIX[capability][role];
    if (grant === 'ALLOW' && OWNER_SECOND_FACTOR_CAPABILITIES.has(capability)) {
      expect(codeOf(response)).toBe('SECOND_FACTOR_REQUIRED');
    } else if (grant === 'ALLOW' || grant === 'OWN') {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ capability, ownershipRequired: grant === 'OWN' });
    } else {
      expect(response.status).toBe(403);
      expect(codeOf(response)).toBe(grant === 'OVERRIDE' ? 'OVERRIDE_REQUIRED' : 'FORBIDDEN');
    }
  });
});

describe('[AUTH-011] [AUTH-013] manager override', () => {
  const entityId = newId();

  it('turns a manager PIN into a single-use approval for one capability', async () => {
    const response = await override('CASHIER', {
      approverStaffId: kit.staff.MANAGER,
      pin: TEST_PINS.MANAGER,
      capability: 'ITEM_VOID_AFTER_PREP',
      entityType: 'order_item',
      entityId,
    });
    expect(response.status).toBe(200);
    const grant = OverrideResponse.parse(response.body);
    expect(grant.approver).toMatchObject({ id: kit.staff.MANAGER, role: 'MANAGER' });

    const wrongCapability = await server()
      .post('/api/v1/probe-matrix/DISCOUNT_ABOVE_LIMIT')
      .set(as('CASHIER'))
      .set('x-override-token', grant.overrideToken);
    expect(codeOf(wrongCapability)).toBe('OVERRIDE_INVALID');

    const used = await server()
      .post('/api/v1/probe-matrix/ITEM_VOID_AFTER_PREP')
      .set(as('CASHIER'))
      .set('x-override-token', grant.overrideToken);
    expect(used.status).toBe(200);
    expect(used.body).toMatchObject({
      override: { approverId: kit.staff.MANAGER, entityType: 'order_item', entityId },
    });

    const again = await server()
      .post('/api/v1/probe-matrix/ITEM_VOID_AFTER_PREP')
      .set(as('CASHIER'))
      .set('x-override-token', grant.overrideToken);
    expect(codeOf(again)).toBe('OVERRIDE_INVALID');

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'OVERRIDE_GRANTED' } });
    expect(audit).toMatchObject({
      actorId: kit.staff.CASHIER,
      approverId: kit.staff.MANAGER,
      deviceId: kit.deviceId,
      entityType: 'order_item',
      entityId,
    });
  });

  it('is bound to the requester session and expires after 2 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const grant = OverrideResponse.parse(
      (
        await override('WAITER', {
          approverStaffId: kit.staff.OWNER,
          pin: TEST_PINS.OWNER,
          capability: 'ITEM_VOID_AFTER_PREP',
        })
      ).body,
    );
    const otherWaiterSession = await signIn(app, kit, 'WAITER');
    const stolen = await server()
      .post('/api/v1/probe-matrix/ITEM_VOID_AFTER_PREP')
      .set(authHeaders(kit.deviceId, otherWaiterSession.accessToken))
      .set('x-override-token', grant.overrideToken);
    expect(codeOf(stolen)).toBe('OVERRIDE_INVALID');
    vi.setSystemTime(Date.now() + 121_000);
    const late = await server()
      .post('/api/v1/probe-matrix/ITEM_VOID_AFTER_PREP')
      .set(as('WAITER'))
      .set('x-override-token', grant.overrideToken);
    expect(codeOf(late)).toBe('OVERRIDE_INVALID');
  });

  it('refuses approvers who are not managers, the requester themselves and wrong PINs', async () => {
    const notManager = await override('CASHIER', {
      approverStaffId: kit.staff.WAITER,
      pin: TEST_PINS.WAITER,
      capability: 'ITEM_VOID_AFTER_PREP',
    });
    expect(codeOf(notManager)).toBe('APPROVER_NOT_ALLOWED');

    const wrongPin = await override('CASHIER', {
      approverStaffId: kit.staff.MANAGER,
      pin: '0000',
      capability: 'ITEM_VOID_AFTER_PREP',
    });
    expect(codeOf(wrongPin)).toBe('INVALID_CREDENTIALS');
    expect(
      await prisma.auditLog.count({
        where: { action: 'OVERRIDE_DENIED', actorId: kit.staff.CASHIER },
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('locks the approver PIN after repeated wrong attempts', async () => {
    const manager = await addStaff(app, kit, 'MANAGER', '2468');
    const deviceId = await addDevice(app, kit);
    const cashier = await signIn(app, kit, 'CASHIER', deviceId);
    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await server()
        .post('/api/v1/auth/override')
        .set(authHeaders(deviceId, cashier.accessToken))
        .send({ approverStaffId: manager, pin: '1357', capability: 'INVOICE_VOID' });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 423, 423]);
  });

  it('is not needed for allowed actions and impossible for denied ones', async () => {
    const notNeeded = await override('MANAGER', {
      approverStaffId: kit.staff.OWNER,
      pin: TEST_PINS.OWNER,
      capability: 'ITEM_VOID_AFTER_PREP',
    });
    expect(codeOf(notNeeded)).toBe('OVERRIDE_NOT_NEEDED');
    const denied = await override('WAITER', {
      approverStaffId: kit.staff.MANAGER,
      pin: TEST_PINS.MANAGER,
      capability: 'DATA_ADMIN',
    });
    expect(codeOf(denied)).toBe('FORBIDDEN');
  });
});

describe('[SEC-015] [AUTH-002] logs', () => {
  it('never contain PINs, passwords or tokens', async () => {
    const extra = await signIn(app, kit, 'CASHIER');
    await server()
      .post('/api/v1/auth/pin-login')
      .set(authHeaders(kit.deviceId))
      .send({ staffId: kit.staff.CASHIER, pin: '9999' });
    const renewed = await server()
      .post('/api/v1/auth/refresh')
      .set(authHeaders(kit.deviceId))
      .send({ refreshToken: extra.refreshToken });
    const grant = await override('CASHIER', {
      approverStaffId: kit.staff.MANAGER,
      pin: TEST_PINS.MANAGER,
      capability: 'BILL_EDIT_AFTER_PRINT',
    });
    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(1_000);
    const secrets = [
      extra.accessToken,
      extra.refreshToken,
      (renewed.body as { refreshToken: string }).refreshToken,
      (grant.body as { overrideToken: string }).overrideToken,
      ...Object.values(sessions).flatMap((session) => [session.accessToken, session.refreshToken]),
    ];
    for (const secret of secrets) expect(logs).not.toContain(secret);
    expect(logs).not.toMatch(/"pin"\s*:\s*"\d/);
    expect(logs).not.toMatch(/Bearer [A-Za-z0-9]/);
    expect(logs).toContain('[REDACTED]');
  });
});

describe('[AUTH-010] [INT-002] route registry', () => {
  const methodName: Partial<Record<RequestMethod, string>> = {
    [RequestMethod.GET]: 'GET',
    [RequestMethod.POST]: 'POST',
    [RequestMethod.PUT]: 'PUT',
    [RequestMethod.PATCH]: 'PATCH',
    [RequestMethod.DELETE]: 'DELETE',
  };
  const accessName = (access: RouteAccess | undefined): string =>
    access === undefined
      ? 'UNDECLARED'
      : access.kind === 'CAPABILITY'
        ? access.capability
        : access.kind;
  const join = (...parts: string[]) =>
    `/${parts
      .flatMap((part) => part.split('/'))
      .filter((part) => part !== '')
      .join('/')}`;

  it('matches the controllers: same routes, each with the declared access', () => {
    const served: string[] = [];
    const testControllers = new Set<unknown>([AuthProbeController, MatrixProbeController]);
    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
        if (controller === null || testControllers.has(controller)) continue;
        const base = (Reflect.getMetadata('path', controller) as string | undefined) ?? '';
        const classAccess = Reflect.getMetadata(ROUTE_ACCESS, controller) as
          RouteAccess | undefined;
        const prototype = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const handler = prototype[name];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const path = Reflect.getMetadata('path', handler) as string | undefined;
          const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
          if (path === undefined || method === undefined) continue;
          const access =
            (Reflect.getMetadata(ROUTE_ACCESS, handler) as RouteAccess | undefined) ?? classAccess;
          served.push(
            `${methodName[method] ?? String(method)} ${join('api/v1', base, path)} ${accessName(access)}`,
          );
        }
      }
    }
    const registered = ROUTES.map((route) => `${route.method} ${route.path} ${route.capability}`);
    // Every served route is in the registry with the same access (so it is documented and guarded).
    expect(served.filter((route) => !registered.includes(route))).toEqual([]);
    // Registered ahead of their work package; remove each line when the route is implemented.
    const notYetServed = ['POST /api/v1/orders ORDER_CREATE' /* P1-06 order engine */];
    expect(registered.filter((route) => !served.includes(route))).toEqual(notYetServed);
  });
});
