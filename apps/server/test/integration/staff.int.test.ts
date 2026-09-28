import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  LoginResponse,
  OwnerSecurityResponse,
  StaffListResponse,
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
  // Many sign-ins from one device in one (frozen) minute: lift the per-device limit (SEC-009).
  await prisma.setting.create({
    data: { restaurantId: kit.restaurantId, key: 'auth.attemptsPerMinutePerDevice', value: 100 },
  });
  app.get(AuthSettingsService).invalidate();
  manager = await signIn(app, kit, 'MANAGER');
  owner = await signIn(app, kit, 'OWNER');
  // The Owner's password and authenticator, for the second factor (AUTH-006).
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
/** An audit row as text, to show a secret is nowhere in it. */
const textOf = (row: unknown) =>
  JSON.stringify(row, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

/** The Owner confirms password and authenticator code (of the next 30 s step: never reused). */
async function stepUp(session: LoginResponse = owner): Promise<void> {
  vi.setSystemTime(Date.now() + 30_000);
  const code = hotp(secret, totpStep(new Date()));
  await server()
    .post('/api/v1/auth/step-up')
    .set(as(session))
    .send({ password: PASSWORD, secondFactor: { kind: 'TOTP', code } })
    .expect(200);
}

/** Forgets the Owner's step-up, as if it was done longer ago than `auth.stepUpMinutes`. */
async function forgetStepUp(): Promise<void> {
  await prisma.session.update({ where: { id: owner.session.id }, data: { secondFactorAt: null } });
}

async function create(
  session: LoginResponse,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return server().post('/api/v1/staff').set(as(session)).send(body);
}

async function addPerson(role: string, name: string, pin = '5678'): Promise<StaffView> {
  const response = await create(manager, { displayName: name, role, pin });
  expect(response.status).toBe(201);
  return StaffView.parse(response.body);
}

async function pinLogin(staffId: string, pin: string, deviceId = kit.deviceId) {
  return server().post('/api/v1/auth/pin-login').set(authHeaders(deviceId)).send({ staffId, pin });
}

async function staffEvents(): Promise<number> {
  return prisma.outboxEvent.count({
    where: {
      eventType: 'RestaurantChanged',
      payload: { path: ['payload', 'part'], equals: 'STAFF' },
    },
  });
}

describe('[MGR-004] [AUTH-001] [AUTH-002] adding people', () => {
  it('adds a waiter with a PIN they can sign in with, never storing or auditing the PIN', async () => {
    const events = await staffEvents();
    const response = await create(manager, {
      displayName: 'Deepak',
      role: 'WAITER',
      pin: '2468',
      phone: '+91 98765 43210',
    });
    expect(response.status).toBe(201);
    const deepak = StaffView.parse(response.body);
    expect(deepak).toMatchObject({
      displayName: 'Deepak',
      role: 'WAITER',
      active: true,
      phone: '+91 98765 43210',
      email: null,
      hasPin: true,
      lockedUntil: null,
    });
    expect((await pinLogin(deepak.id, '2468')).status).toBe(200);
    const tiles = StaffTilesResponse.parse(
      (await server().get('/api/v1/auth/staff-tiles').set(authHeaders(kit.deviceId))).body,
    );
    expect(tiles.staff.map((tile) => tile.displayName)).toContain('Deepak');
    expect(await staffEvents()).toBe(events + 1);

    const credential = await prisma.credential.findUniqueOrThrow({
      where: { staffId_kind: { staffId: deepak.id, kind: 'PIN' } },
    });
    expect(credential.secretHash).toMatch(/^\$argon2id\$/);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'STAFF_CREATED', entityId: deepak.id },
    });
    expect(entry.actorId).toBe(kit.staff.MANAGER);
    expect(entry.after).toEqual({
      displayName: 'Deepak',
      role: 'WAITER',
      hasPhone: true,
      hasEmail: false,
    });
    expect(textOf(entry)).not.toContain('2468');
  });

  it('wants a PIN of exactly the configured length', async () => {
    const response = await create(manager, {
      displayName: 'Too long',
      role: 'WAITER',
      pin: '123456',
    });
    expect(response.status).toBe(422);
    expect(codeOf(response)).toBe('PIN_LENGTH');
    expect(ApiError.parse(response.body).details).toEqual({ pinLength: 4 });
    // PINs need not be unique: people pick their name first (AUTH-001).
    await addPerson('KITCHEN', 'Same PIN', TEST_PINS.WAITER);
  });

  it('lists everyone, active first, with PIN and lock state but never a secret', async () => {
    const gone = await addPerson('WAITER', 'Aaron');
    await server()
      .post(`/api/v1/staff/${gone.id}/deactivate`)
      .set(as(manager))
      .send({ reason: 'Moved to another city' })
      .expect(200);
    const list = await server().get('/api/v1/staff').set(as(manager));
    expect(list.status).toBe(200);
    const { staff, pinLength } = StaffListResponse.parse(list.body);
    expect(pinLength).toBe(4);
    expect(staff.at(-1)).toMatchObject({ id: gone.id, active: false, hasPin: true });
    expect(staff.slice(0, -1).every((person) => person.active)).toBe(true);
    expect(staff.find((person) => person.id === kit.staff.OWNER)).toMatchObject({
      role: 'OWNER',
      hasPin: true,
    });
    expect(JSON.stringify(list.body)).not.toMatch(/argon2|secretHash|pin"/);
  });
});

describe('[MGR-004] changing people', () => {
  it('changes a name, contact and role; the role applies to the next request', async () => {
    const meena = await addPerson('WAITER', 'Meena');
    const session = LoginResponse.parse((await pinLogin(meena.id, '5678')).body);
    const response = await server()
      .patch(`/api/v1/staff/${meena.id}`)
      .set(as(manager))
      .send({ displayName: 'Meena K', role: 'CASHIER', email: 'meena@example.in' });
    expect(response.status).toBe(200);
    expect(StaffView.parse(response.body)).toMatchObject({
      displayName: 'Meena K',
      role: 'CASHIER',
      email: 'meena@example.in',
    });
    const now = await server().get('/api/v1/auth/session').set(as(session));
    expect(now.body.staff.role).toBe('CASHIER');
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'STAFF_UPDATED', entityId: meena.id },
    });
    expect(entry.before).toEqual({ displayName: 'Meena', role: 'WAITER' });
    expect(entry.after).toEqual({
      displayName: 'Meena K',
      role: 'CASHIER',
      changed: ['displayName', 'email', 'role'],
    });
    expect(textOf(entry)).not.toContain('meena@example.in');
  });

  it('takes someone who no longer takes orders off today’s sections', async () => {
    const arjun = await addPerson('WAITER', 'Arjun');
    await assignToday(arjun.id);
    const response = await server()
      .patch(`/api/v1/staff/${arjun.id}`)
      .set(as(manager))
      .send({ role: 'KITCHEN' });
    expect(response.status).toBe(200);
    expect(await prisma.shiftAssignment.count({ where: { staffId: arjun.id } })).toBe(0);
  });

  it('sets a PIN, lifting a lockout and ending the person’s other sessions', async () => {
    const kiran = await addPerson('CASHIER', 'Kiran');
    const session = LoginResponse.parse((await pinLogin(kiran.id, '5678')).body);
    await prisma.credential.update({
      where: { staffId_kind: { staffId: kiran.id, kind: 'PIN' } },
      data: { lockedUntil: new Date(Date.now() + 10 * 60_000) },
    });
    const listed = StaffListResponse.parse(
      (await server().get('/api/v1/staff').set(as(manager))).body,
    ).staff.find((person) => person.id === kiran.id);
    expect(listed?.lockedUntil).not.toBeNull();

    const response = await server()
      .put(`/api/v1/staff/${kiran.id}/pin`)
      .set(as(manager))
      .send({ pin: '9753' });
    expect(response.status).toBe(204);
    expect((await pinLogin(kiran.id, '5678')).status).toBe(401);
    expect((await pinLogin(kiran.id, '9753')).status).toBe(200);
    expect((await server().get('/api/v1/auth/session').set(as(session))).status).toBe(401);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'STAFF_PIN_SET', entityId: kiran.id },
    });
    expect(entry.after).toEqual({ firstPin: false, lockLifted: true, sessionsEnded: 1 });
    expect(textOf(entry)).not.toContain('9753');
  });

  it('refuses a person of another restaurant as not found', async () => {
    const elsewhere = await createAuthKit(app);
    const response = await server()
      .patch(`/api/v1/staff/${elsewhere.staff.WAITER}`)
      .set(as(manager))
      .send({ displayName: 'Nope' });
    expect(response.status).toBe(404);
    expect(codeOf(response)).toBe('STAFF_NOT_FOUND');
  });
});

describe('[AUTH-008] [MGR-004] deactivating', () => {
  it('signs the person out everywhere within 5 s, takes back their devices and sections', async () => {
    const sunil = await addPerson('WAITER', 'Sunil');
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    const session = LoginResponse.parse((await pinLogin(sunil.id, '5678', phone)).body);
    const socket = await RealtimeTestClient.connect(appUrl(app), {
      deviceToken: deviceTokenOf(phone),
      accessToken: session.accessToken,
    });
    clients.push(socket);
    const pager = await addDevice(app, kit, 'PAGER', { staffId: sunil.id });
    await prisma.device.update({ where: { id: phone }, data: { staffId: sunil.id } });
    await assignToday(sunil.id);

    const started = performance.now();
    const response = await server()
      .post(`/api/v1/staff/${sunil.id}/deactivate`)
      .set(as(manager))
      .send({ reason: 'Left the restaurant' });
    expect(response.status).toBe(200);
    expect(StaffView.parse(response.body).active).toBe(false);

    const refused = await server().get('/api/v1/auth/session').set(as(session, phone));
    expect(refused.status).toBe(401);
    expect(await socket.waitForDisconnect(5_000)).toBe('io server disconnect');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect((await pinLogin(sunil.id, '5678')).status).toBe(401);
    expect(await prisma.device.findUniqueOrThrow({ where: { id: pager } })).toMatchObject({
      staffId: null,
    });
    expect(await prisma.device.findUniqueOrThrow({ where: { id: phone } })).toMatchObject({
      staffId: null,
    });
    expect(await prisma.shiftAssignment.count({ where: { staffId: sunil.id } })).toBe(0);
    const tiles = StaffTilesResponse.parse(
      (await server().get('/api/v1/auth/staff-tiles').set(authHeaders(kit.deviceId))).body,
    );
    expect(tiles.staff.map((tile) => tile.staffId)).not.toContain(sunil.id);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'STAFF_DEACTIVATED', entityId: sunil.id },
    });
    expect(entry.reason).toBe('Left the restaurant');
    expect(entry.after).toMatchObject({
      active: false,
      sessionsEnded: 1,
      pagersTakenBack: [pager],
      devicesReleased: 2,
      leftSections: 1,
    });
    // Never deleted: the record stays, and can be brought back with the same PIN.
    const again = await server()
      .post(`/api/v1/staff/${sunil.id}/deactivate`)
      .set(as(manager))
      .send({ reason: 'Twice' });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('STAFF_ALREADY_INACTIVE');
    const back = await server().post(`/api/v1/staff/${sunil.id}/reactivate`).set(as(manager));
    expect(back.status).toBe(200);
    expect(StaffView.parse(back.body).active).toBe(true);
    expect((await pinLogin(sunil.id, '5678')).status).toBe(200);
    expect(
      await prisma.auditLog.count({ where: { action: 'STAFF_REACTIVATED', entityId: sunil.id } }),
    ).toBe(1);
  });

  it('lets nobody deactivate themselves or change their own role, and never the Owner', async () => {
    const self = await server()
      .post(`/api/v1/staff/${kit.staff.MANAGER}/deactivate`)
      .set(as(manager))
      .send({ reason: 'Just testing' });
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('OWN_RECORD');
    const role = await server()
      .patch(`/api/v1/staff/${kit.staff.MANAGER}`)
      .set(as(manager))
      .send({ role: 'WAITER' });
    expect(role.status).toBe(422);
    expect(codeOf(role)).toBe('OWN_RECORD');
    await stepUp();
    const theOwner = await server()
      .post(`/api/v1/staff/${kit.staff.OWNER}/deactivate`)
      .set(as(owner))
      .send({ reason: 'Just testing' });
    expect(theOwner.status).toBe(422);
    expect(codeOf(theOwner)).toBe('OWNER_RECORD');
    // Their own name and PIN are theirs to change.
    const rename = await server()
      .patch(`/api/v1/staff/${kit.staff.MANAGER}`)
      .set(as(manager))
      .send({ displayName: 'Test manager' });
    expect(rename.status).toBe(200);
  });
});

describe('[AUTH-006] creating or removing managers', () => {
  it('refuses managers, and asks the Owner for the second factor first', async () => {
    const byManager = await create(manager, { displayName: 'Rohit', role: 'MANAGER', pin: '1357' });
    expect(byManager.status).toBe(403);
    expect(codeOf(byManager)).toBe('OWNER_ONLY');

    await forgetStepUp();
    const unconfirmed = await create(owner, { displayName: 'Rohit', role: 'MANAGER', pin: '1357' });
    expect(unconfirmed.status).toBe(403);
    expect(codeOf(unconfirmed)).toBe('SECOND_FACTOR_REQUIRED');

    await stepUp();
    const confirmed = await create(owner, { displayName: 'Rohit', role: 'MANAGER', pin: '1357' });
    expect(confirmed.status).toBe(201);
    const rohit = StaffView.parse(confirmed.body);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'STAFF_CREATED', entityId: rohit.id },
    });
    expect(entry.actorId).toBe(kit.staff.OWNER);

    // Another manager's record is the Owner's to change.
    for (const call of [
      server().patch(`/api/v1/staff/${rohit.id}`).set(as(manager)).send({ displayName: 'R' }),
      server().put(`/api/v1/staff/${rohit.id}/pin`).set(as(manager)).send({ pin: '1111' }),
      server()
        .post(`/api/v1/staff/${rohit.id}/deactivate`)
        .set(as(manager))
        .send({ reason: 'Not a manager' }),
    ]) {
      const response = await call;
      expect(response.status).toBe(403);
      expect(codeOf(response)).toBe('OWNER_ONLY');
    }

    await forgetStepUp();
    const demote = await server()
      .patch(`/api/v1/staff/${rohit.id}`)
      .set(as(owner))
      .send({ role: 'CASHIER' });
    expect(codeOf(demote)).toBe('SECOND_FACTOR_REQUIRED');
    await stepUp();
    const demoted = await server()
      .patch(`/api/v1/staff/${rohit.id}`)
      .set(as(owner))
      .send({ role: 'CASHIER' });
    expect(demoted.status).toBe(200);
    expect(StaffView.parse(demoted.body).role).toBe('CASHIER');
  });

  it('keeps the Owner’s record to the Owner', async () => {
    const response = await server()
      .put(`/api/v1/staff/${kit.staff.OWNER}/pin`)
      .set(as(manager))
      .send({ pin: '2222' });
    expect(response.status).toBe(403);
    expect(codeOf(response)).toBe('OWNER_ONLY');
  });

  it('tells the Owner what of their sign-in security is set up, and nobody else', async () => {
    await stepUp();
    const security = OwnerSecurityResponse.parse(
      (await server().get('/api/v1/auth/owner/security').set(as(owner))).body,
    );
    expect(security).toMatchObject({
      hasPassword: true,
      hasAuthenticator: true,
      recoveryCodesLeft: 10,
    });
    expect(security.secondFactorValidUntil).not.toBeNull();
    const byManager = await server().get('/api/v1/auth/owner/security').set(as(manager));
    expect(byManager.status).toBe(403);
    expect(codeOf(byManager)).toBe('OWNER_ONLY');
  });
});

describe('[SEC-003] [AUTH-010] only managers and the Owner manage staff', () => {
  it('refuses cashiers, waiters and kitchen staff on every staff route', async () => {
    for (const role of ['CASHIER', 'WAITER', 'KITCHEN'] as const) {
      const session = await signIn(app, kit, role);
      const target = kit.staff.WAITER;
      const calls: [string, () => request.Test][] = [
        ['list', () => server().get('/api/v1/staff').set(as(session))],
        [
          'create',
          () =>
            server()
              .post('/api/v1/staff')
              .set(as(session))
              .send({ displayName: 'X', role: 'WAITER', pin: '1234' }),
        ],
        [
          'update',
          () =>
            server().patch(`/api/v1/staff/${target}`).set(as(session)).send({ displayName: 'X' }),
        ],
        [
          'deactivate',
          () =>
            server()
              .post(`/api/v1/staff/${target}/deactivate`)
              .set(as(session))
              .send({ reason: 'No way' }),
        ],
        ['reactivate', () => server().post(`/api/v1/staff/${target}/reactivate`).set(as(session))],
        [
          'set PIN',
          () => server().put(`/api/v1/staff/${target}/pin`).set(as(session)).send({ pin: '1234' }),
        ],
      ];
      for (const [label, call] of calls) {
        const response = await call();
        expect(response.status, `${role} ${label}`).toBe(403);
        expect(codeOf(response)).toBe('FORBIDDEN');
      }
    }
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
