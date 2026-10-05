import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  CurrentSessionResponse,
  CustomRoleView,
  LoginResponse,
  OverrideResponse,
  RoleListResponse,
  StaffTilesResponse,
  StaffView,
  TotpEnrollmentResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthSettingsService } from '../../src/auth/auth-settings.js';
import { base32Decode, hotp, totpStep } from '../../src/auth/totp.js';
import { currentBusinessDate, dbDate } from '../../src/common/business-dates.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DEFAULT_REALTIME_OPTIONS, REALTIME_OPTIONS } from '../../src/realtime/realtime.gateway.js';
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

const PASSWORD = 'correct horse battery';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let owner: LoginResponse;
let secret: Buffer;
const clients: RealtimeTestClient[] = [];

beforeAll(async () => {
  // One clock for the whole file that only moves forward, so authenticator codes never repeat.
  vi.useFakeTimers({ toFake: ['Date'] });
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
  kit = await createAuthKit(app);
  await prisma.setting.create({
    data: { restaurantId: kit.restaurantId, key: 'auth.attemptsPerMinutePerDevice', value: 100 },
  });
  app.get(AuthSettingsService).invalidate();
  manager = await signIn(app, kit, 'MANAGER');
  owner = await signIn(app, kit, 'OWNER');
  await server()
    .post('/api/v1/auth/owner/password')
    .set(as(owner))
    .send({ newPassword: PASSWORD })
    .expect(204);
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

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));
const as = (session: LoginResponse, deviceId = kit.deviceId) =>
  authHeaders(deviceId, session.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

/** The Owner confirms password and authenticator code (of the next 30 s step: never reused). */
async function stepUp(): Promise<void> {
  vi.setSystemTime(Date.now() + 30_000);
  const code = hotp(secret, totpStep(new Date()));
  await server()
    .post('/api/v1/auth/step-up')
    .set(as(owner))
    .send({ password: PASSWORD, secondFactor: { kind: 'TOTP', code } })
    .expect(200);
}

/** Forgets the Owner's step-up, as if it was done longer ago than `auth.stepUpMinutes`. */
async function forgetStepUp(): Promise<void> {
  await prisma.session.update({ where: { id: owner.session.id }, data: { secondFactorAt: null } });
}

interface RoleBody {
  readonly name: string;
  readonly baseRole: string;
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
}

const bodyOf = (role: RoleBody) => ({ added: [], removed: [], ...role });

/** The Owner, with a fresh second factor, creates a custom role. */
async function createRole(role: RoleBody): Promise<CustomRoleView> {
  await stepUp();
  const response = await server().post('/api/v1/roles').set(as(owner)).send(bodyOf(role));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return CustomRoleView.parse(response.body);
}

/** A manager adds a person with the role; returns them signed in on a new POS. */
async function personWith(
  role: CustomRoleView,
  name: string,
): Promise<{ person: StaffView; session: LoginResponse; deviceId: string }> {
  const created = await server()
    .post('/api/v1/staff')
    .set(as(manager))
    .send({ displayName: name, role: role.baseRole, customRoleId: role.id, pin: '2580' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const person = StaffView.parse(created.body);
  const deviceId = await addDevice(app, kit);
  const login = await server()
    .post('/api/v1/auth/pin-login')
    .set(authHeaders(deviceId))
    .send({ staffId: person.id, pin: '2580' });
  expect(login.status).toBe(200);
  return { person, session: LoginResponse.parse(login.body), deviceId };
}

async function staffEvents(): Promise<number> {
  return prisma.outboxEvent.count({
    where: {
      eventType: 'RestaurantChanged',
      payload: { path: ['payload', 'part'], equals: 'STAFF' },
    },
  });
}

describe('[AUTH-012] [AUTH-006] the Owner creates custom roles', () => {
  it('lets only the Owner, with a fresh second factor, combine permissions into a role', async () => {
    const body = bodyOf({ name: 'Captain', baseRole: 'WAITER', added: ['BILL_PRINT_AND_PAYMENT'] });
    const byManager = await server().post('/api/v1/roles').set(as(manager)).send(body);
    expect(byManager.status).toBe(403);
    expect(codeOf(byManager)).toBe('OWNER_ONLY');

    await forgetStepUp();
    const unconfirmed = await server().post('/api/v1/roles').set(as(owner)).send(body);
    expect(unconfirmed.status).toBe(403);
    expect(codeOf(unconfirmed)).toBe('SECOND_FACTOR_REQUIRED');

    const events = await staffEvents();
    const captain = await createRole(body);
    expect(captain).toMatchObject({
      name: 'Captain',
      baseRole: 'WAITER',
      added: ['BILL_PRINT_AND_PAYMENT'],
      removed: [],
      staffCount: 0,
      archivedAt: null,
    });
    expect(await staffEvents()).toBe(events + 1);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ROLE_CREATED', entityId: captain.id },
    });
    expect(entry.actorId).toBe(kit.staff.OWNER);
    expect(entry.after).toEqual({
      name: 'Captain',
      baseRole: 'WAITER',
      added: ['BILL_PRINT_AND_PAYMENT'],
      removed: [],
    });
    // Everyone who manages staff reads the roles, to give them to people.
    const list = RoleListResponse.parse(
      (await server().get('/api/v1/roles').set(as(manager)).expect(200)).body,
    );
    expect(list.roles.map((role) => role.name)).toContain('Captain');
  });

  it('refuses what only the Owner may do, and changes that change nothing, with each problem', async () => {
    await stepUp();
    const response = await server()
      .post('/api/v1/roles')
      .set(as(owner))
      .send(
        bodyOf({
          name: 'Too much',
          baseRole: 'WAITER',
          added: ['TAX_AND_INVOICE_SETTINGS', 'ORDER_CREATE'],
          removed: ['DAY_END_CLOSE'],
        }),
      );
    expect(response.status).toBe(422);
    expect(codeOf(response)).toBe('ROLE_PERMISSIONS_INVALID');
    expect(ApiError.parse(response.body).details).toEqual({
      issues: [
        { capability: 'TAX_AND_INVOICE_SETTINGS', problem: 'OWNER_ONLY' },
        { capability: 'ORDER_CREATE', problem: 'ALREADY_ALLOWED' },
        { capability: 'DAY_END_CLOSE', problem: 'NOT_GRANTED' },
      ],
    });
    // No custom role may be built on the Owner.
    const onOwner = await server()
      .post('/api/v1/roles')
      .set(as(owner))
      .send(bodyOf({ name: 'Deputy', baseRole: 'OWNER' }));
    expect(onOwner.status).toBe(400);
  });

  it('keeps names unique, ignoring case, among active roles and the built-in ones', async () => {
    await createRole({ name: 'Host', baseRole: 'WAITER' });
    for (const name of ['host', 'Manager', 'kitchen']) {
      await stepUp();
      const response = await server()
        .post('/api/v1/roles')
        .set(as(owner))
        .send(bodyOf({ name, baseRole: 'CASHIER' }));
      expect(response.status, name).toBe(409);
      expect(codeOf(response)).toBe('ROLE_NAME_TAKEN');
    }
  });
});

describe('[AUTH-012] [AUTH-010] people with a custom role', () => {
  it('gives a person the role, which the guard applies on top of the base role', async () => {
    const lead = await createRole({
      name: 'Floor lead',
      baseRole: 'WAITER',
      added: ['BILL_PRINT_AND_PAYMENT', 'MENU_MANAGE'],
      removed: ['BILL_REQUEST'],
    });
    const { person, session, deviceId } = await personWith(lead, 'Ravi');
    expect(person).toMatchObject({
      role: 'WAITER',
      customRole: { id: lead.id, name: 'Floor lead' },
    });
    expect(session.staff.customRole).toEqual({
      id: lead.id,
      name: 'Floor lead',
      added: ['BILL_PRINT_AND_PAYMENT', 'MENU_MANAGE'],
      removed: ['BILL_REQUEST'],
    });
    const now = CurrentSessionResponse.parse(
      (await server().get('/api/v1/auth/session').set(as(session, deviceId))).body,
    );
    expect(now.staff.customRole?.name).toBe('Floor lead');
    const tiles = StaffTilesResponse.parse(
      (await server().get('/api/v1/auth/staff-tiles').set(authHeaders(kit.deviceId))).body,
    );
    expect(tiles.staff.find((tile) => tile.staffId === person.id)?.customRoleName).toBe(
      'Floor lead',
    );

    // Added: used outright. Kept from the base role: still allowed. Taken away: refused.
    await server().get('/api/v1/print-queue').set(as(session, deviceId)).expect(200);
    await server().get('/api/v1/menu/draft').set(as(session, deviceId)).expect(200);
    await server().get('/api/v1/orders/takeaway').set(as(session, deviceId)).expect(200);
    const waiter = await signIn(app, kit, 'WAITER');
    await server().get('/api/v1/print-queue').set(as(waiter)).expect(403);
    // The guard refuses before it looks for the table.
    const billRequest = await server()
      .post('/api/v1/table-sessions/0190f5a0-0000-7000-8000-000000000002/request-bill')
      .set(as(session, deviceId))
      .send({});
    expect(billRequest.status).toBe(403);
    expect(codeOf(billRequest)).toBe('FORBIDDEN');
    // The role counts its people.
    const list = RoleListResponse.parse((await server().get('/api/v1/roles').set(as(owner))).body);
    expect(list.roles.find((role) => role.id === lead.id)?.staffCount).toBe(1);
  });

  it('refuses a role built on another base role, and one that does not exist', async () => {
    const runner = await createRole({
      name: 'Runner',
      baseRole: 'WAITER',
      removed: ['ORDER_CREATE'],
    });
    const mismatch = await server()
      .post('/api/v1/staff')
      .set(as(manager))
      .send({ displayName: 'Mixed', role: 'CASHIER', customRoleId: runner.id, pin: '1470' });
    expect(mismatch.status).toBe(422);
    expect(codeOf(mismatch)).toBe('ROLE_MISMATCH');
    const unknown = await server().post('/api/v1/staff').set(as(manager)).send({
      displayName: 'Nobody',
      role: 'WAITER',
      customRoleId: '0190f5a0-0000-7000-8000-000000000001',
      pin: '1470',
    });
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe('ROLE_NOT_FOUND');
  });

  it('changes a person’s custom role, audited, and back to the built-in role', async () => {
    const runner = await prisma.role.findFirstOrThrow({ where: { name: 'Runner' } });
    const added = await server()
      .post('/api/v1/staff')
      .set(as(manager))
      .send({ displayName: 'Gopal', role: 'WAITER', pin: '1470' });
    const gopal = StaffView.parse(added.body);
    expect(gopal.customRole).toBeNull();
    const changed = await server()
      .patch(`/api/v1/staff/${gopal.id}`)
      .set(as(manager))
      .send({ customRoleId: runner.id });
    expect(changed.status).toBe(200);
    expect(StaffView.parse(changed.body).customRole).toEqual({
      id: runner.id,
      name: 'Runner',
      added: [],
      removed: ['ORDER_CREATE'],
    });
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'STAFF_UPDATED', entityId: gopal.id },
    });
    expect(entry.before).toEqual({ role: 'WAITER', customRole: null });
    expect(entry.after).toEqual({
      role: 'WAITER',
      customRole: { id: runner.id, name: 'Runner' },
      changed: ['role'],
    });
    const back = await server()
      .patch(`/api/v1/staff/${gopal.id}`)
      .set(as(manager))
      .send({ customRoleId: null });
    expect(StaffView.parse(back.body)).toMatchObject({ role: 'WAITER', customRole: null });
  });

  it('[AUTH-006] counts a role that gives staff management as a manager’s', async () => {
    const head = await createRole({
      name: 'Head cashier',
      baseRole: 'CASHIER',
      added: ['STAFF_MANAGE', 'DAY_END_CLOSE'],
    });
    const body = { displayName: 'Kiran', role: 'CASHIER', customRoleId: head.id, pin: '3690' };
    const byManager = await server().post('/api/v1/staff').set(as(manager)).send(body);
    expect(byManager.status).toBe(403);
    expect(codeOf(byManager)).toBe('OWNER_ONLY');
    await forgetStepUp();
    const unconfirmed = await server().post('/api/v1/staff').set(as(owner)).send(body);
    expect(codeOf(unconfirmed)).toBe('SECOND_FACTOR_REQUIRED');
    await stepUp();
    const created = await server().post('/api/v1/staff').set(as(owner)).send(body);
    expect(created.status).toBe(201);
    const kiran = StaffView.parse(created.body);

    // Kiran looks after the team, but managers (and other staff managers) stay the Owner's.
    const session = LoginResponse.parse(
      (
        await server()
          .post('/api/v1/auth/pin-login')
          .set(authHeaders(kit.deviceId))
          .send({ staffId: kiran.id, pin: '3690' })
      ).body,
    );
    await server().get('/api/v1/staff').set(as(session)).expect(200);
    const waiter = await server()
      .post('/api/v1/staff')
      .set(as(session))
      .send({ displayName: 'Lata', role: 'WAITER', pin: '1593' });
    expect(waiter.status).toBe(201);
    const managerPin = await server()
      .put(`/api/v1/staff/${kit.staff.MANAGER}/pin`)
      .set(as(session))
      .send({ pin: '9999' });
    expect(codeOf(managerPin)).toBe('OWNER_ONLY');
    const kiranByManager = await server()
      .patch(`/api/v1/staff/${kiran.id}`)
      .set(as(manager))
      .send({ displayName: 'K' });
    expect(codeOf(kiranByManager)).toBe('OWNER_ONLY');
    // Nobody changes their own role.
    const own = await server()
      .patch(`/api/v1/staff/${kiran.id}`)
      .set(as(session))
      .send({ customRoleId: null });
    expect(codeOf(own)).toBe('OWN_RECORD');
  });

  it('[AUTH-011] lets only a manager whose role keeps the action approve it', async () => {
    const shiftLead = await createRole({
      name: 'Shift lead',
      baseRole: 'MANAGER',
      removed: ['ITEM_VOID_AFTER_PREP', 'STAFF_MANAGE'],
    });
    await stepUp();
    const created = await server()
      .post('/api/v1/staff')
      .set(as(owner))
      .send({ displayName: 'Neel', role: 'MANAGER', customRoleId: shiftLead.id, pin: '7531' });
    expect(created.status).toBe(201);
    const neel = StaffView.parse(created.body);
    const cashier = await signIn(app, kit, 'CASHIER');
    const ask = (approverStaffId: string, pin: string) =>
      server()
        .post('/api/v1/auth/override')
        .set(as(cashier))
        .send({ approverStaffId, pin, capability: 'ITEM_VOID_AFTER_PREP' });
    const refused = await ask(neel.id, '7531');
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('APPROVER_NOT_ALLOWED');
    const approved = await ask(kit.staff.MANAGER, TEST_PINS.MANAGER);
    expect(approved.status).toBe(200);
    expect(OverrideResponse.parse(approved.body).approver.id).toBe(kit.staff.MANAGER);
  });
});

describe('[AUTH-012] [AUTH-010] changing and archiving a role', () => {
  it('reaches its people at their next request and closes their live connections', async () => {
    const editor = await createRole({
      name: 'Menu helper',
      baseRole: 'CASHIER',
      added: ['MENU_MANAGE'],
    });
    const { person, session, deviceId } = await personWith(editor, 'Sita');
    await server().get('/api/v1/menu/draft').set(as(session, deviceId)).expect(200);
    const socket = await RealtimeTestClient.connect(appUrl(app), {
      deviceToken: deviceTokenOf(deviceId),
      accessToken: session.accessToken,
    });
    clients.push(socket);

    await stepUp();
    const response = await server()
      .put(`/api/v1/roles/${editor.id}`)
      .set(as(owner))
      .send(bodyOf({ name: 'Menu viewer', baseRole: 'CASHIER' }));
    expect(response.status).toBe(200);
    expect(CustomRoleView.parse(response.body)).toMatchObject({
      name: 'Menu viewer',
      added: [],
      staffCount: 1,
    });
    await server().get('/api/v1/menu/draft').set(as(session, deviceId)).expect(403);
    expect(await socket.waitForDisconnect(5_000)).toBe('io server disconnect');
    expect(socket.endings).toEqual([{ reason: 'SESSION_ENDED' }]);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ROLE_CHANGED', entityId: editor.id },
    });
    expect(entry.before).toMatchObject({ name: 'Menu helper', added: ['MENU_MANAGE'] });
    expect(entry.after).toMatchObject({ name: 'Menu viewer', added: [], staffCount: 1 });
    expect(person.customRole?.name).toBe('Menu helper');
  });

  it('takes its people off today’s sections when it no longer takes orders', async () => {
    const helper = await createRole({ name: 'Floor helper', baseRole: 'WAITER' });
    const { person } = await personWith(helper, 'Hari');
    await assignToday(person.id);
    await stepUp();
    await server()
      .put(`/api/v1/roles/${helper.id}`)
      .set(as(owner))
      .send(bodyOf({ name: 'Floor helper', baseRole: 'WAITER', removed: ['ORDER_CREATE'] }))
      .expect(200);
    expect(await prisma.shiftAssignment.count({ where: { staffId: person.id } })).toBe(0);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ROLE_CHANGED', entityId: helper.id },
    });
    expect(entry.after).toMatchObject({ leftSections: 1 });
    // And nobody with it can be given tables.
    const assignment = await prisma.section.findFirstOrThrow({
      where: { restaurantId: kit.restaurantId },
    });
    const refused = await server()
      .put('/api/v1/waiter-assignments')
      .set(as(manager))
      .send({ assignments: [{ staffId: person.id, sectionIds: [assignment.id], tableIds: [] }] });
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('STAFF_NOT_ASSIGNABLE');
  });

  it('archives only a role nobody active has, and restores it', async () => {
    const temp = await createRole({ name: 'Festival help', baseRole: 'KITCHEN' });
    const { person } = await personWith(temp, 'Bala');
    await stepUp();
    const inUse = await server()
      .post(`/api/v1/roles/${temp.id}/archive`)
      .set(as(owner))
      .send({ reason: 'Festival is over' });
    expect(inUse.status).toBe(409);
    expect(codeOf(inUse)).toBe('ROLE_IN_USE');
    expect(ApiError.parse(inUse.body).details).toEqual({ staffCount: 1 });

    await server()
      .post(`/api/v1/staff/${person.id}/deactivate`)
      .set(as(manager))
      .send({ reason: 'Festival is over' })
      .expect(200);
    const archived = await server()
      .post(`/api/v1/roles/${temp.id}/archive`)
      .set(as(owner))
      .send({ reason: 'Festival is over' });
    expect(archived.status).toBe(200);
    expect(CustomRoleView.parse(archived.body).archivedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ROLE_ARCHIVED', entityId: temp.id },
    });
    expect(entry.reason).toBe('Festival is over');
    // Nobody new gets it, and it cannot change while archived.
    const given = await server()
      .post('/api/v1/staff')
      .set(as(manager))
      .send({ displayName: 'Late', role: 'KITCHEN', customRoleId: temp.id, pin: '8520' });
    expect(codeOf(given)).toBe('ROLE_NOT_FOUND');
    const edit = await server()
      .put(`/api/v1/roles/${temp.id}`)
      .set(as(owner))
      .send(bodyOf({ name: 'Festival help', baseRole: 'KITCHEN' }));
    expect(codeOf(edit)).toBe('ROLE_ARCHIVED');
    // Its name is free again; restoring waits until it is not taken.
    const reuse = await createRole({ name: 'Festival help', baseRole: 'WAITER' });
    await stepUp();
    const blocked = await server().post(`/api/v1/roles/${temp.id}/restore`).set(as(owner));
    expect(codeOf(blocked)).toBe('ROLE_NAME_TAKEN');
    await server()
      .put(`/api/v1/roles/${reuse.id}`)
      .set(as(owner))
      .send(bodyOf({ name: 'Wedding help', baseRole: 'WAITER' }))
      .expect(200);
    const restored = await server().post(`/api/v1/roles/${temp.id}/restore`).set(as(owner));
    expect(restored.status).toBe(200);
    expect(CustomRoleView.parse(restored.body).archivedAt).toBeNull();
    expect(
      await prisma.auditLog.count({ where: { action: 'ROLE_RESTORED', entityId: temp.id } }),
    ).toBe(1);
  });

  it('keeps archiving and restoring to the Owner with a fresh second factor', async () => {
    const role = await createRole({ name: 'Weekend help', baseRole: 'WAITER' });
    const byManager = await server()
      .post(`/api/v1/roles/${role.id}/archive`)
      .set(as(manager))
      .send({ reason: 'Not needed' });
    expect(codeOf(byManager)).toBe('OWNER_ONLY');
    await forgetStepUp();
    const unconfirmed = await server()
      .post(`/api/v1/roles/${role.id}/archive`)
      .set(as(owner))
      .send({ reason: 'Not needed' });
    expect(codeOf(unconfirmed)).toBe('SECOND_FACTOR_REQUIRED');
    const cashier = await signIn(app, kit, 'CASHIER');
    const list = await server().get('/api/v1/roles').set(as(cashier));
    expect(list.status).toBe(403);
  });
});

/** Gives the person a section of the kit's restaurant today. */
async function assignToday(staffId: string): Promise<void> {
  const section = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: `Section ${staffId.slice(-4)}`, displayOrder: 0 },
  });
  const today = await currentBusinessDate(prisma, kit.restaurantId);
  await prisma.shiftAssignment.create({
    data: {
      restaurantId: kit.restaurantId,
      staffId,
      sectionId: section.id,
      businessDate: dbDate(today),
    },
  });
}
