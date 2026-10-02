import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ApiError, type LoginResponse, OnboardingResponse } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * P7-07a: the first-run setup (ONB-004) resumes from what is set up, and the Owner activates the
 * PC with the vendor's code (ONB-003) against a stand-in Control Plane.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let owner: LoginResponse;
let waiter: LoginResponse;
let vendor: Server;
const INSTALLATION_ID = '0190a1b2-c3d4-7000-8000-00000000ab01';

beforeAll(async () => {
  vendor = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    incoming.on('end', () => {
      const { code } = JSON.parse(body) as { code: string };
      if (incoming.url !== '/v1/enrolments' || code !== 'ABCD-EFGH-JKLM-NP23') {
        response.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            code: 'ENROLMENT_CODE_INVALID',
            message: 'That code is not valid or has been used.',
          }),
        );
        return;
      }
      response.writeHead(201, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          installationId: INSTALLATION_ID,
          tenantId: '0190a1b2-c3d4-7000-8000-00000000ab02',
          name: 'Main counter PC',
          channel: 'STABLE',
          enrolledAt: new Date().toISOString(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
  const { port } = vendor.address() as AddressInfo;
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { controlPlaneUrl: `http://127.0.0.1:${String(port)}` },
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  owner = await signIn(app, kit, 'OWNER');
  waiter = await signIn(app, kit, 'WAITER');
});

afterAll(async () => {
  await app.close();
  await database.drop();
  await new Promise<void>((resolve) =>
    vendor.close(() => {
      resolve();
    }),
  );
});

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const statuses = async () => {
  const response = await server().get('/api/v1/onboarding').set(as(manager));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const view = OnboardingResponse.parse(response.body);
  return { view, by: Object.fromEntries(view.steps.map((entry) => [entry.step, entry.status])) };
};
const mark = (step: string, status: string, login = manager) =>
  server().put(`/api/v1/onboarding/steps/${step}`).set(as(login)).send({ status });

describe('[ONB-004] the first-run setup', () => {
  it('shows what is left to do, for managers and the Owner only', async () => {
    expect((await server().get('/api/v1/onboarding').set(as(waiter))).status).toBe(403);
    const { view, by } = await statuses();
    expect(view.complete).toBe(false);
    expect(by).toMatchObject({
      PROFILE: 'TODO',
      TAX: 'TODO',
      FLOOR: 'TODO',
      MENU: 'TODO',
      GO_LIVE: 'TODO',
    });
    // The test kit gave every role a PIN: waiters, cashiers and kitchen staff can sign in.
    expect(by.STAFF).toBe('DONE');
    expect(view.activation).toEqual({ configured: true, activated: false, installationName: null });
  });

  it('resumes from what is set up, and takes confirmations and skips', async () => {
    const restaurantId = kit.restaurantId;
    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        legalName: 'Spice Route Foods LLP',
        stateCode: '27',
        address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' },
        businessHours: [{ day: 'MON', start: '11:00', end: '23:00' }],
      },
    });
    const section = await prisma.section.create({ data: { restaurantId, name: 'Main' } });
    await prisma.diningTable.create({
      data: { restaurantId, sectionId: section.id, label: 'T1', capacity: 4 },
    });
    const { by } = await statuses();
    expect(by).toMatchObject({
      PROFILE: 'DONE',
      FLOOR: 'DONE',
      QR: 'TODO',
      INVOICE: expect.any(String) as unknown,
    });

    const notConfirmable = await mark('MENU', 'DONE');
    expect([notConfirmable.status, ApiError.parse(notConfirmable.body).code]).toEqual([
      409,
      'NOT_CONFIRMABLE',
    ]);
    expect(ApiError.parse((await mark('MENU', 'SKIPPED')).body).code).toBe('NOT_SKIPPABLE');
    expect(ApiError.parse((await mark('GO_LIVE', 'DONE')).body).code).toBe('NOT_READY');
    expect((await mark('QR', 'SKIPPED')).status).toBe(200);
    expect((await statuses()).by.QR).toBe('SKIPPED');
    expect((await mark('QR', 'TODO')).status).toBe(200);
    expect((await statuses()).by.QR).toBe('TODO');
    expect(await prisma.auditLog.count({ where: { action: 'ONBOARDING_STEP_MARKED' } })).toBe(2);
  });
});

describe('[ONB-003] activating the PC', () => {
  it('is the Owner’s, with a fresh second factor; a wrong code is refused', async () => {
    const byManager = await server()
      .post('/api/v1/activation')
      .set(as(manager))
      .send({ code: 'ABCD-EFGH-JKLM-NP23' });
    expect(byManager.status).toBe(403);
    await prisma.session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
    const wrong = await server()
      .post('/api/v1/activation')
      .set(as(owner))
      .send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' });
    expect([wrong.status, ApiError.parse(wrong.body).code]).toEqual([
      422,
      'ACTIVATION_CODE_INVALID',
    ]);
    expect(ApiError.parse(wrong.body).message).toBe('That code is not valid or has been used.');
    const typo = await server()
      .post('/api/v1/activation')
      .set(as(owner))
      .send({ code: 'ABCD-EFGH-JKLM-NP2!' });
    expect(typo.status).toBe(422);

    const done = await server()
      .post('/api/v1/activation')
      .set(as(owner))
      .send({ code: 'abcd efgh jklm np23' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({
      installationId: INSTALLATION_ID,
      installationName: 'Main counter PC',
    });
    expect((await statuses()).view.activation).toEqual({
      configured: true,
      activated: true,
      installationName: 'Main counter PC',
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'INSTALLATION_ENROLLED' },
    });
    expect(audit.actorId).toBe(kit.staff.OWNER);
    const again = await server()
      .post('/api/v1/activation')
      .set(as(owner))
      .send({ code: 'ABCD-EFGH-JKLM-NP23' });
    expect([again.status, ApiError.parse(again.body).code]).toEqual([409, 'ALREADY_ACTIVATED']);
  });
});
