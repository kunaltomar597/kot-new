import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ApiError, LicenceView, type LoginResponse } from '@rp/contracts';
import type { HeartbeatResponse, LicencePayload } from '@rp/contracts/control-plane';
import { fingerprintOf, reactivationCode, reactivationSecretOf, signLicence } from '@rp/licensing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveEnrolment } from '../../src/cloud/control-plane-state.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { LicenceAgentService } from '../../src/licensing/licence-agent.service.js';
import { FINGERPRINT_READER } from '../../src/licensing/pc-fingerprint.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let agent: LicenceAgentService;
let kit: AuthKit;
let owner: LoginResponse;
let manager: LoginResponse;
let waiter: LoginResponse;
let tableId: string;
let dal: string;

const INSTALLATION = randomUUID();
const vendor = generateKeyPairSync('ed25519');
const VENDOR_KEY = vendor.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const MASTER = Buffer.alloc(32, 7);
const SECRET = reactivationSecretOf(MASTER, INSTALLATION);
const IDENTIFIERS = {
  MACHINE_ID: 'm-1',
  BOARD_SERIAL: 'b-1',
  BIOS_UUID: 'u-1',
  DISK_SERIAL: 'd-1',
  CPU_ID: 'c-1',
};
const DAY_MS = 86_400_000;

function licence(overrides: Partial<LicencePayload> = {}) {
  const issuedAt = new Date();
  return signLicence(
    {
      format: 1,
      licenceId: randomUUID(),
      tenantId: randomUUID(),
      installationId: INSTALLATION,
      fingerprint: fingerprintOf(INSTALLATION, IDENTIFIERS),
      plan: 'Standard',
      modules: ['POS', 'KDS'],
      deviceLimits: { TABLE_TABLET: 10, PAGER: 10, WAITER_PHONE: 10, KDS: 0 },
      issuedAt: issuedAt.toISOString(),
      validUntil: new Date(issuedAt.getTime() + 30 * DAY_MS).toISOString(),
      graceDays: 7,
      state: 'ACTIVE',
      graceStartedAt: null,
      reason: null,
      reactivationCounter: 0,
      ...overrides,
    },
    vendor.privateKey,
    VENDOR_KEY,
  );
}

function answer(overrides: Partial<HeartbeatResponse> = {}): HeartbeatResponse {
  const now = new Date().toISOString();
  return {
    receivedAt: now,
    serverTime: now,
    nextHeartbeatSeconds: 300,
    update: null,
    licence: null,
    reactivationSecret: null,
    relayCredential: null,
    auditCheck: null,
    diagnosticsRequests: [],
    vendorSettings: null,
    backupKeyEscrow: null,
    restoreCodes: [],
    pagerFirmware: null,
    ...overrides,
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { licenceEnforce: true, licenceKeys: [VENDOR_KEY] },
    overrides: [
      { provide: FINGERPRINT_READER, useValue: { read: () => Promise.resolve(IDENTIFIERS) } },
    ],
  });
  prisma = app.get(PrismaService);
  agent = app.get(LicenceAgentService);
  kit = await createAuthKit(app);
  owner = await signIn(app, kit, 'OWNER');
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  await prisma.session.update({
    where: { id: owner.session.id },
    data: { secondFactorAt: new Date() },
  });
  await saveEnrolment(prisma, {
    installationId: INSTALLATION,
    tenantId: randomUUID(),
    name: 'Main PC',
    channel: 'STABLE',
    enrolledAt: new Date().toISOString(),
    controlPlaneUrl: 'https://control-plane.example.com',
  });
  const section = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  tableId = (
    await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: section.id, label: 'T1' },
    })
  ).id;
  const base = { restaurantId: kit.restaurantId };
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
  const tax = await prisma.taxGroup.create({ data: { ...base, name: 'Nil' } });
  dal = (
    await prisma.item.create({
      data: {
        ...base,
        categoryId: category.id,
        name: 'Dal',
        basePrice: 18_000,
        taxGroupId: tax.id,
        foodType: 'VEG',
        stationId: station.id,
      },
    })
  ).id;
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  await agent.refresh();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));
const view = async (login: LoginResponse) =>
  LicenceView.parse((await server().get('/api/v1/licence').set(as(login))).body);
const openTable = () =>
  server().post(`/api/v1/tables/${tableId}/open`).set(as(waiter)).send({ covers: 2 });

describe('[LIC-003] [LIC-005] the licence on this PC', () => {
  it('without a licence: restricted from the next business day, never mid-service', async () => {
    const missing = await view(waiter);
    expect(missing).toMatchObject({
      recorded: 'RESTRICTED',
      state: 'GRACE',
      problem: 'MISSING',
      enforced: true,
      details: null,
    });
    expect(missing.restrictedFrom).not.toBeNull();
    expect(Date.parse(missing.restrictedFrom ?? '')).toBeGreaterThan(Date.now());
    expect(missing.capabilities.createOrders).toBe(true);
  });

  it('takes a valid licence from the Control Plane, and shows the Owner its details', async () => {
    await agent.accept(
      answer({ licence: licence(), reactivationSecret: SECRET.toString('base64') }),
    );
    expect(await view(waiter)).toMatchObject({
      state: 'ACTIVE',
      recorded: 'ACTIVE',
      problem: null,
      restrictedFrom: null,
      details: null,
    });
    expect((await view(manager)).details).toMatchObject({
      installationId: INSTALLATION,
      plan: 'Standard',
      deviceLimits: { KDS: 0 },
      deviceCounts: { KDS: 0, TABLE_TABLET: 0 },
    });
    // A licence for another installation, or not signed by the vendor, is never kept.
    await agent.accept(answer({ licence: licence({ installationId: randomUUID() }) }));
    const forged = signLicence(
      JSON.parse(licence().payload) as LicencePayload,
      generateKeyPairSync('ed25519').privateKey,
      VENDOR_KEY,
    );
    await agent.accept(answer({ licence: forged }));
    expect((await view(waiter)).state).toBe('ACTIVE');
    const report = await agent.heartbeatReport();
    expect(report.licence).toMatchObject({
      fingerprint: fingerprintOf(INSTALLATION, IDENTIFIERS),
      hasReactivationSecret: true,
    });
  });

  it('[LIC-001] pairs no more devices of a kind than the licence allows', async () => {
    const refused = await server()
      .post('/api/v1/devices/pairing-codes')
      .set(as(manager))
      .send({ type: 'KDS', name: 'Grill screen' });
    expect([refused.status, codeOf(refused)]).toEqual([409, 'DEVICE_LIMIT_REACHED']);
    const tablet = await server()
      .post('/api/v1/devices/pairing-codes')
      .set(as(manager))
      .send({ type: 'TABLE_TABLET', name: 'Tablet T1', tableId });
    expect(tablet.status, JSON.stringify(tablet.body)).toBe(201);
  });

  it('once a restriction applies: no new tables or orders; bills and reports still work', async () => {
    await agent.accept(
      answer({ licence: licence({ state: 'RESTRICTED', reason: 'Invoice unpaid for 60 days' }) }),
    );
    // Decided now: until the next business day the restaurant still works, with the banner.
    const pending = await view(owner);
    expect(pending).toMatchObject({ state: 'GRACE', recorded: 'RESTRICTED', problem: 'VENDOR' });
    expect((await openTable()).status).toBe(201);
    // The next morning (the agent's clock moves on).
    const morning = new Date(Date.parse(pending.restrictedFrom ?? '') + 60_000);
    await agent.refresh(morning);
    const restricted = await view(owner);
    expect(restricted).toMatchObject({ state: 'RESTRICTED', daysLeft: 0 });
    expect(restricted.details?.reason).toBe('Invoice unpaid for 60 days');
    const second = await prisma.diningTable.create({
      data: {
        restaurantId: kit.restaurantId,
        sectionId: (await prisma.section.findFirstOrThrow()).id,
        label: 'T2',
      },
    });
    const refused = await server()
      .post(`/api/v1/tables/${second.id}/open`)
      .set(as(waiter))
      .send({ covers: 2 });
    expect([refused.status, codeOf(refused)]).toEqual([423, 'LICENCE_RESTRICTED']);
    const session = await prisma.tableSession.findFirstOrThrow({ where: { status: 'OPEN' } });
    const order = await server()
      .post('/api/v1/orders')
      .set(as(waiter))
      .send({
        idempotencyKey: randomUUID(),
        source: 'WAITER_APP',
        orderType: 'DINE_IN',
        tableSessionId: session.id,
        lines: [{ clientLineId: randomUUID(), itemId: dal, quantity: 1, modifiers: [] }],
      });
    expect([order.status, codeOf(order)]).toEqual([423, 'LICENCE_RESTRICTED']);
    // Reports and the floor are still there.
    expect((await server().get('/api/v1/tables/overview').set(as(waiter))).status).toBe(200);
    expect(
      await prisma.auditLog.count({ where: { action: 'LICENCE_STATE_CHANGED' } }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.outboxEvent.count({ where: { eventType: 'LicenceChanged' } }),
    ).toBeGreaterThan(0);
  });

  it('[LIC-006] the Owner reactivates it offline with the vendor’s code; a code works once', async () => {
    const until = new Date(Date.now() + 5 * DAY_MS).toISOString().slice(0, 10);
    const code = reactivationCode(SECRET, INSTALLATION, until, 1);
    const byManager = await server()
      .post('/api/v1/licence/reactivate')
      .set(as(manager))
      .send({ code });
    expect(byManager.status).toBe(403);
    const wrong = await server()
      .post('/api/v1/licence/reactivate')
      .set(as(owner))
      .send({
        code: reactivationCode(
          reactivationSecretOf(Buffer.alloc(32, 9), INSTALLATION),
          INSTALLATION,
          until,
          1,
        ),
      });
    expect([wrong.status, codeOf(wrong)]).toEqual([409, 'REACTIVATION_CODE_INVALID']);
    const reactivated = await server()
      .post('/api/v1/licence/reactivate')
      .set(as(owner))
      .send({ code });
    expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
    expect(LicenceView.parse(reactivated.body)).toMatchObject({ state: 'ACTIVE', problem: null });
    expect((await openTable()).status).not.toBe(423);
    const again = await server().post('/api/v1/licence/reactivate').set(as(owner)).send({ code });
    expect([again.status, codeOf(again)]).toEqual([409, 'REACTIVATION_CODE_USED']);
    expect(await prisma.auditLog.count({ where: { action: 'LICENCE_REACTIVATED' } })).toBe(1);
    // A few tries an hour.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await server().post('/api/v1/licence/reactivate').set(as(owner)).send({ code });
    }
    const limited = await server().post('/api/v1/licence/reactivate').set(as(owner)).send({ code });
    expect([limited.status, codeOf(limited)]).toEqual([429, 'TOO_MANY_ATTEMPTS']);
  });

  it('[LIC-007] reports a clock set back and an edited record, which restricts at once', async () => {
    // The clock set back a week: judged by the last time seen, and reported.
    await agent.refresh(new Date(Date.now() - 7 * DAY_MS));
    let report = await agent.heartbeatReport();
    expect(report.tamper?.map((event) => event.kind)).toContain('CLOCK_ROLLBACK');
    // Delivered: no longer reported.
    await agent.accept(answer(), report.tamper ?? []);
    report = await agent.heartbeatReport();
    expect(report.tamper ?? []).toEqual([]);

    // Someone edits the sealed record: reported, and the vendor's restriction applies at once.
    await prisma.systemMeta.update({
      where: { key: 'licence.record' },
      data: { value: 'edited' },
    });
    await agent.refresh();
    report = await agent.heartbeatReport();
    expect(report.tamper?.map((event) => event.kind)).toContain('RECORD_TAMPERED');
    expect(await view(waiter)).toMatchObject({ state: 'RESTRICTED' });
    // The code used before cannot be used again: the licence knows its counter.
    await agent.accept(
      answer({ licence: licence({ state: 'RESTRICTED', reactivationCounter: 1 }) }),
    );
    const until = new Date(Date.now() + 5 * DAY_MS).toISOString().slice(0, 10);
    const reused = await agent
      .reactivate(
        {
          staffId: kit.staff.OWNER,
          role: 'OWNER',
          restaurantId: kit.restaurantId,
          deviceId: kit.deviceId,
          sessionId: owner.session.id,
          secondFactorAt: new Date(),
          capabilities: [],
        },
        reactivationCode(SECRET, INSTALLATION, until, 1),
      )
      .catch((error: unknown) => error);
    expect(reused).toMatchObject({ code: 'REACTIVATION_CODE_USED' });
  });
});
