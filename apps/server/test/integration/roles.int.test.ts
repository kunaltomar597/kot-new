import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  LoginResponse,
  RoleListResponse,
  RoleView,
  StaffView,
  TotpEnrollmentResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthSettingsService } from '../../src/auth/auth-settings.js';
import { base32Decode, hotp, totpStep } from '@rp/totp';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const PASSWORD = 'correct horse battery';
const CAPTAIN_PIN = '5151';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let owner: LoginResponse;
let waiter: LoginResponse;
let secret: Buffer;

beforeAll(async () => {
  // One clock that only moves forward, so authenticator codes never repeat.
  vi.useFakeTimers({ toFake: ['Date'] });
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  await prisma.setting.create({
    data: { restaurantId: kit.restaurantId, key: 'auth.attemptsPerMinutePerDevice', value: 100 },
  });
  app.get(AuthSettingsService).invalidate();
  manager = await signIn(app, kit, 'MANAGER');
  owner = await signIn(app, kit, 'OWNER');
  waiter = await signIn(app, kit, 'WAITER');
  await server().post('/api/v1/auth/owner/password').set(as(owner)).send({ newPassword: PASSWORD });
  const enrolment = TotpEnrollmentResponse.parse(
    (await server().post('/api/v1/auth/owner/totp/enroll').set(as(owner))).body,
  );
  secret = base32Decode(enrolment.secret);
  await server()
    .post('/api/v1/auth/owner/totp/confirm')
    .set(as(owner))
    .send({ code: hotp(secret, totpStep(new Date())) })
    .expect(200);
});

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));
const as = (session: LoginResponse) => authHeaders(kit.deviceId, session.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

async function stepUp(): Promise<void> {
  vi.setSystemTime(Date.now() + 30_000);
  await server()
    .post('/api/v1/auth/step-up')
    .set(as(owner))
    .send({
      password: PASSWORD,
      secondFactor: { kind: 'TOTP', code: hotp(secret, totpStep(new Date())) },
    })
    .expect(200);
}

const captain = () => ({
  name: 'Senior captain',
  baseRole: 'WAITER',
  capabilities: ['ORDER_APPROVE_CUSTOMER', 'REPORTS_VIEW_EXPORT'],
});

const salesReport = (session: LoginResponse) =>
  server().get('/api/v1/reports/sales?from=2026-09-01&to=2026-09-30').set(as(session));

let captainRoleId = '';
let captainStaffId = '';

describe('[AUTH-012] [AUTH-006] custom roles are the Owner’s', () => {
  it('lets only the Owner, with a fresh second factor, create one; audited', async () => {
    const byManager = await server().post('/api/v1/roles').set(as(manager)).send(captain());
    expect([byManager.status, codeOf(byManager)]).toEqual([403, 'OWNER_ONLY']);
    const byWaiter = await server().post('/api/v1/roles').set(as(waiter)).send(captain());
    expect(byWaiter.status).toBe(403);
    const withoutStepUp = await server().post('/api/v1/roles').set(as(owner)).send(captain());
    expect(codeOf(withoutStepUp)).toBe('SECOND_FACTOR_REQUIRED');

    await stepUp();
    const created = await server().post('/api/v1/roles').set(as(owner)).send(captain());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const role = RoleView.parse(created.body);
    captainRoleId = role.id;
    expect(role).toMatchObject({
      name: 'Senior captain',
      baseRole: 'WAITER',
      builtIn: false,
      capabilities: ['ORDER_APPROVE_CUSTOMER', 'REPORTS_VIEW_EXPORT'],
      staffCount: 0,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ROLE_CREATED', entityId: role.id },
    });
    expect(audit.actorId).toBe(kit.staff.OWNER);

    const list = RoleListResponse.parse(
      (await server().get('/api/v1/roles').set(as(manager))).body,
    );
    expect(list.roles.find((entry) => entry.id === role.id)?.name).toBe('Senior captain');
    expect(list.roles.some((entry) => entry.builtIn && entry.baseRole === 'WAITER')).toBe(true);
  });

  it('refuses a name in use, a manager base, staff or Owner-only powers, and adding nothing', async () => {
    await stepUp();
    const send = (body: object) => server().post('/api/v1/roles').set(as(owner)).send(body);
    expect(codeOf(await send({ ...captain(), name: 'senior CAPTAIN' }))).toBe('ROLE_NAME_TAKEN');
    expect(codeOf(await send({ ...captain(), name: 'Manager' }))).toBe('ROLE_NAME_TAKEN');
    expect((await send({ ...captain(), name: 'Boss', baseRole: 'MANAGER' })).status).toBe(400);
    expect(
      codeOf(await send({ ...captain(), name: 'Sneaky', capabilities: ['STAFF_MANAGE'] })),
    ).toBe('ROLE_CAPABILITY_NOT_GRANTABLE');
    expect(
      codeOf(
        await send({ ...captain(), name: 'Taxman', capabilities: ['TAX_AND_INVOICE_SETTINGS'] }),
      ),
    ).toBe('ROLE_CAPABILITY_NOT_GRANTABLE');
    expect(codeOf(await send({ ...captain(), name: 'Same', capabilities: ['ORDER_CREATE'] }))).toBe(
      'ROLE_NOTHING_ADDED',
    );
  });
});

describe('[AUTH-012] [AUTH-010] a person with a custom role', () => {
  it('is given it on its base role, and the server applies its extra grants', async () => {
    const mismatch = await server().post('/api/v1/staff').set(as(manager)).send({
      displayName: 'Sunil',
      role: 'CASHIER',
      customRoleId: captainRoleId,
      pin: CAPTAIN_PIN,
    });
    expect(codeOf(mismatch)).toBe('CUSTOM_ROLE_MISMATCH');

    const created = await server().post('/api/v1/staff').set(as(manager)).send({
      displayName: 'Sunil',
      role: 'WAITER',
      customRoleId: captainRoleId,
      pin: CAPTAIN_PIN,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sunil = StaffView.parse(created.body);
    captainStaffId = sunil.id;
    expect(sunil).toMatchObject({
      role: 'WAITER',
      customRoleId: captainRoleId,
      customRoleName: 'Senior captain',
    });

    const session = LoginResponse.parse(
      (
        await server()
          .post('/api/v1/auth/pin-login')
          .set(authHeaders(kit.deviceId))
          .send({ staffId: sunil.id, pin: CAPTAIN_PIN })
      ).body,
    );
    // The app hears what the role adds, to show the right screens (AUTH-012).
    expect(session.staff).toMatchObject({
      role: 'WAITER',
      capabilities: ['ORDER_APPROVE_CUSTOMER', 'REPORTS_VIEW_EXPORT'],
    });
    // A plain waiter may not read reports; the captain may.
    expect((await salesReport(waiter)).status).toBe(403);
    expect((await salesReport(session)).status).toBe(200);

    // The Owner takes the reports away: it applies on the captain's very next request.
    await stepUp();
    const changed = await server()
      .put(`/api/v1/roles/${captainRoleId}`)
      .set(as(owner))
      .send({ ...captain(), capabilities: ['ORDER_APPROVE_CUSTOMER'] });
    expect(RoleView.parse(changed.body).capabilities).toEqual(['ORDER_APPROVE_CUSTOMER']);
    expect(
      await prisma.auditLog.count({ where: { action: 'ROLE_CHANGED', entityId: captainRoleId } }),
    ).toBe(1);
    expect((await salesReport(session)).status).toBe(403);
  });

  it('cannot get extra powers from a stored list the rules do not allow', async () => {
    // Even if the row were edited by hand, staff management is never honoured.
    await prisma.role.update({
      where: { id: captainRoleId },
      data: { capabilities: ['ORDER_APPROVE_CUSTOMER', 'STAFF_MANAGE', 'DATA_ADMIN'] },
    });
    const session = LoginResponse.parse(
      (
        await server()
          .post('/api/v1/auth/pin-login')
          .set(authHeaders(kit.deviceId))
          .send({ staffId: captainStaffId, pin: CAPTAIN_PIN })
      ).body,
    );
    expect((await server().get('/api/v1/staff').set(as(session))).status).toBe(403);
    await prisma.role.update({
      where: { id: captainRoleId },
      data: { capabilities: ['ORDER_APPROVE_CUSTOMER'] },
    });
  });
});

describe('[AUTH-012] [MENU-010] archiving and changing custom roles', () => {
  it('keeps the base role while people have it, and archives only an unused role', async () => {
    await stepUp();
    const rebase = await server()
      .put(`/api/v1/roles/${captainRoleId}`)
      .set(as(owner))
      .send({ ...captain(), baseRole: 'CASHIER', capabilities: ['ORDER_APPROVE_CUSTOMER'] });
    expect([rebase.status, codeOf(rebase)]).toEqual([409, 'ROLE_IN_USE']);
    const inUse = await server()
      .post(`/api/v1/roles/${captainRoleId}/archive`)
      .set(as(owner))
      .send({ reason: 'No longer needed' });
    expect(codeOf(inUse)).toBe('ROLE_IN_USE');

    // Back to the plain waiter role, then the custom role can go.
    const plain = await server()
      .patch(`/api/v1/staff/${captainStaffId}`)
      .set(as(manager))
      .send({ customRoleId: null });
    expect(StaffView.parse(plain.body)).toMatchObject({ role: 'WAITER', customRoleId: null });
    const archived = await server()
      .post(`/api/v1/roles/${captainRoleId}/archive`)
      .set(as(owner))
      .send({ reason: 'No longer needed' });
    expect(archived.status).toBe(200);
    expect(RoleView.parse(archived.body).archivedAt).not.toBeNull();
    const reuse = await server()
      .patch(`/api/v1/staff/${captainStaffId}`)
      .set(as(manager))
      .send({ customRoleId: captainRoleId });
    expect(codeOf(reuse)).toBe('CUSTOM_ROLE_NOT_FOUND');
  });

  it('never changes a built-in role', async () => {
    await stepUp();
    const roles = RoleListResponse.parse((await server().get('/api/v1/roles').set(as(owner))).body);
    const waiterRole = roles.roles.find((entry) => entry.builtIn && entry.baseRole === 'WAITER');
    const response = await server()
      .put(`/api/v1/roles/${waiterRole?.id ?? ''}`)
      .set(as(owner))
      .send({ ...captain(), name: 'Waiter plus' });
    expect(codeOf(response)).toBe('ROLE_BUILT_IN');
  });
});
