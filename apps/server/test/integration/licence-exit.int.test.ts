import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect, createServer, type Server as TcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  DataExportResponse,
  LicenceView,
  type LoginResponse,
  ReportExportResponse,
  SalesSummaryResponse,
} from '@rp/contracts';
import {
  AdminService,
  BillingService,
  CONTROL_PLANE_MIGRATIONS_DIR,
  CpConfigSchema,
  createControlPlaneApp,
  LicencesService,
} from '@rp/control-plane/testing';
import { createMigratedDatabase, type TestDatabase } from '@rp/test-postgres';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { enrolInstallation } from '../../src/cloud/enrolment.js';
import { CONTROL_PLANE_OPTIONS, HeartbeatService } from '../../src/cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DataExportService } from '../../src/lifecycle/data-export.service.js';
import { LicenceAgentService } from '../../src/licensing/licence-agent.service.js';
import { FINGERPRINT_READER } from '../../src/licensing/pc-fingerprint.js';
import {
  authHeaders,
  type AuthKit,
  createAuthKit,
  renewDeviceToken,
  signIn,
} from '../helpers/auth-kit.js';
import {
  billAndPay,
  type SmallRestaurant,
  seatAndOrder,
  serveTable,
  setUpSmallRestaurant,
} from '../helpers/small-restaurant.js';
import { api, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl } from '../helpers/test-database.js';

/**
 * Phase 7 exit scenario S8 (P7-10, BRD §18.2): licence: overdue → grace → restricted (only at the
 * next business day) → reactivation online and offline; data export works in restricted mode.
 *
 * A real Vendor Control Plane signs the licences and runs the subscription billing; the
 * restaurant PC reaches it through a line the test can cut (the restaurant's internet). The clock
 * of the whole process moves from day to day (the databases keep theirs, which nothing here
 * compares with). The vendor's billing finds an invoice unpaid: the licence goes to payment due,
 * then grace, and the PC shows each while the restaurant works on. The internet is down when the
 * grace runs out one evening: the PC judges that by itself, and the restriction waits for the next
 * business day, so the evening's service is never interrupted. In the morning new tables and
 * orders are refused, while last night's table is billed and paid, and the reports, a report
 * export and the full data export all work. The vendor reads a reactivation code over the phone
 * (offline), which the Owner types in; then the payment arrives and the Owner's "Check now" takes
 * the vendor's active licence (online), which holds after the code's day.
 */

const DAY_MS = 86_400_000;
/** India's time at the given local wall-clock time (UTC+05:30). */
const ist = (local: string) => new Date(`${local}+05:30`);
/** The moments of the scenario. */
const AT = {
  start: ist('2026-11-02T12:00:00'),
  paymentDue: ist('2026-11-10T12:00:00'),
  grace: ist('2026-11-24T12:00:00'),
  graceOverEvening: ist('2026-12-01T21:00:00'),
  nextMorning: ist('2026-12-02T10:00:00'),
  paid: ist('2026-12-02T15:00:00'),
  afterCode: ist('2026-12-04T12:00:00'),
} as const;

const vendor = generateKeyPairSync('ed25519');
const VENDOR_KEY = vendor.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const IDENTIFIERS = {
  MACHINE_ID: 'm-1',
  BOARD_SERIAL: 'b-1',
  BIOS_UUID: 'u-1',
  DISK_SERIAL: 'd-1',
  CPU_ID: 'c-1',
};

let serverDatabase: TestDatabase;
let cpDatabase: TestDatabase;
let controlPlane: INestApplication;
let line: Line;
let pc: INestApplication;
let kit: AuthKit;
let restaurant: SmallRestaurant;
let tenantId: string;
let installationId: string;
let staff: OnDuty;
/** Last night's table, still open in the morning. */
let lastNight: { sessionId: string };
const exportFolder = mkdtempSync(join(tmpdir(), 'rp-s8-export-'));

/** The restaurant's internet: a TCP line to the Control Plane that can be cut and mended. */
interface Line {
  readonly url: string;
  cut(): void;
  mend(): void;
  close(): Promise<void>;
}

async function startLine(targetPort: number): Promise<Line> {
  let open = true;
  const sockets = new Set<Socket>();
  const server: TcpServer = createServer((socket) => {
    if (!open) {
      socket.destroy();
      return;
    }
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.add(socket).add(upstream);
    const drop = () => {
      socket.destroy();
      upstream.destroy();
      sockets.delete(socket);
      sockets.delete(upstream);
    };
    socket.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Not listening');
  const dropAll = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    cut: () => {
      open = false;
      dropAll();
    },
    mend: () => {
      open = true;
    },
    close: () =>
      new Promise((resolve) => {
        dropAll();
        server.close(() => {
          resolve();
        });
      }),
  };
}

interface OnDuty {
  readonly owner: LoginResponse;
  readonly manager: LoginResponse;
  readonly waiter: LoginResponse;
  readonly cashier: LoginResponse;
}

/** Moves the clock of the PC and the Control Plane to `at`; the day's staff sign in. */
async function now(at: Date): Promise<void> {
  vi.setSystemTime(at);
  await renewDeviceToken(pc, kit.deviceId);
  const owner = await signIn(pc, kit, 'OWNER');
  // The Owner has just answered the second factor (AUTH-006), as the console asks first.
  await pc.get(PrismaService).session.update({
    where: { id: owner.session.id },
    data: { secondFactorAt: new Date() },
  });
  staff = {
    owner,
    manager: await signIn(pc, kit, 'MANAGER'),
    waiter: await signIn(pc, kit, 'WAITER'),
    cashier: await signIn(pc, kit, 'CASHIER'),
  };
}

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const licence = async () =>
  LicenceView.parse((await api(pc).get('/api/v1/licence').set(as(staff.owner))).body);
const openTable = (label: string) =>
  api(pc)
    .post(`/api/v1/tables/${restaurant.tables[label] ?? ''}/open`)
    .set(as(staff.waiter))
    .send({ covers: 2 });
const heartbeat = () => pc.get(HeartbeatService).beat();
const billing = () => controlPlane.get(BillingService);
const vendorState = async () =>
  (await controlPlane.get(LicencesService).summary(installationId)).state;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AT.start);
  serverDatabase = await createTestDatabase();
  cpDatabase = await createMigratedDatabase({
    adminUrl: testAdminUrl(),
    runId: inject('pgRunId'),
    prefix: 'rp',
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
  });
  controlPlane = await createControlPlaneApp(
    CpConfigSchema.parse({
      databaseUrl: cpDatabase.url,
      logLevel: 'silent',
      billingIntervalMinutes: 0,
      fleetSweepSeconds: 0,
      billingPaymentTermsDays: 7,
      billingGraceAfterDays: 15,
      licenceGraceDays: 7,
      licenceSigningKey: vendor.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      licenceReactivationKey: randomBytes(32).toString('base64'),
    }),
  );
  await controlPlane.listen(0, '127.0.0.1');
  const cpAddress = (controlPlane.getHttpServer() as Server).address();
  if (cpAddress === null || typeof cpAddress === 'string') throw new Error('Not listening');
  line = await startLine(cpAddress.port);

  // The vendor signs the restaurant up: a tenant, its PC, a monthly plan from 1 November.
  const admin = controlPlane.get(AdminService);
  tenantId = (await admin.createTenant('Licence Dhaba', 'vendor:sales')).id;
  const issued = await admin.createInstallation({ tenantId, name: 'Counter PC' }, 'vendor:sales');
  installationId = issued.installationId;
  const plan = await billing().createPlan(
    {
      code: 'STANDARD',
      name: 'Standard',
      prices: { MONTHLY: 2_49_900, QUARTERLY: null, YEARLY: null },
      deviceLimits: { TABLE_TABLET: 12, PAGER: 6, WAITER_PHONE: 6, KDS: 2 },
      modules: ['POS', 'KDS', 'WAITER_APP', 'TABLE_TABLET', 'QR_MENU', 'PAGERS'],
    },
    'vendor:finance',
  );
  await billing().setSubscription(
    tenantId,
    { planId: plan.id, cycle: 'MONTHLY', startsOn: '2026-11-01', reason: 'Signed up' },
    'vendor:finance',
  );

  // The restaurant PC, enrolled with the vendor's code, with the licence enforced as installed.
  pc = await createTestApp({
    databaseUrl: serverDatabase.url,
    config: { controlPlaneUrl: line.url, licenceEnforce: true, licenceKeys: [VENDOR_KEY] },
    overrides: [
      { provide: FINGERPRINT_READER, useValue: { read: () => Promise.resolve(IDENTIFIERS) } },
      {
        provide: CONTROL_PLANE_OPTIONS,
        // Only the scenario's own heartbeats (and the Owner's "Check now") are sent.
        useValue: {
          firstHeartbeatDelayMs: 600_000,
          defaultIntervalMs: 600_000,
          requestTimeoutMs: 5_000,
        },
      },
    ],
  });
  kit = await createAuthKit(pc);
  await enrolInstallation({
    config: pc.get<AppConfig>(APP_CONFIG),
    prisma: pc.get(PrismaService),
    secrets: pc.get<SecretStore>(SECRET_STORE),
    code: issued.code,
  });
  await now(AT.start);
  restaurant = await setUpSmallRestaurant(pc, kit, staff.manager);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await pc.close();
  await line.close();
  await controlPlane.close();
  await serverDatabase.drop();
  await cpDatabase.drop();
});

describe('[S8] [LIC-005] [LIC-006] [VCP-003] the licence through overdue, grace and restriction', () => {
  it('starts active: the PC holds the licence the vendor signed, and the restaurant serves', async () => {
    expect(await billing().run(AT.start)).toMatchObject({ issued: 1, paymentDue: 0 });
    expect((await heartbeat()).lastError).toBeNull();
    expect(await licence()).toMatchObject({
      state: 'ACTIVE',
      problem: null,
      enforced: true,
      details: { installationId, plan: 'Standard' },
    });
    await serveTable(pc, kit, staff, restaurant.tables.T1 ?? '', [[restaurant.items.Dal, 2]]);
  });

  it('[LIC-008] payment due, then grace: the reminder and the banner, and service as usual', async () => {
    // 10 November: the invoice due on 8 November is unpaid.
    await now(AT.paymentDue);
    expect(await billing().run(AT.paymentDue)).toMatchObject({ paymentDue: 1 });
    await heartbeat();
    expect(await licence()).toMatchObject({ state: 'PAYMENT_DUE', problem: null });
    expect((await licence()).capabilities).toMatchObject({
      openNewTableSessions: true,
      createOrders: true,
    });
    await serveTable(pc, kit, staff, restaurant.tables.T1 ?? '', [[restaurant.items.Naan, 4]]);

    // 24 November: 16 days overdue, more than 15: grace, seven days of it.
    await now(AT.grace);
    expect(await billing().run(AT.grace)).toMatchObject({ grace: 1 });
    await heartbeat();
    expect(await licence()).toMatchObject({ state: 'GRACE', daysLeft: 7, restrictedFrom: null });
    await serveTable(pc, kit, staff, restaurant.tables.T2 ?? '', [[restaurant.items.Lassi, 2]]);
  });

  it('[LIC-003] the grace runs out offline one evening: restricted only from the next business day', async () => {
    // The internet is down; the vendor's billing restricts the licence, which the PC cannot hear.
    line.cut();
    await now(AT.graceOverEvening);
    expect(await billing().run(AT.graceOverEvening)).toMatchObject({ restricted: 1 });
    expect(await vendorState()).toBe('RESTRICTED');
    expect((await heartbeat()).lastError).not.toBeNull();

    // The PC judges the grace over by itself; the restriction waits for 04:00 tomorrow.
    await pc.get(LicenceAgentService).refresh();
    const evening = await licence();
    expect(evening).toMatchObject({
      state: 'GRACE',
      recorded: 'RESTRICTED',
      problem: 'GRACE_ENDED',
      restrictedFrom: ist('2026-12-02T04:00:00').toISOString(),
      daysLeft: 1,
    });
    // The evening's service goes on: a new table, its order, the kitchen.
    lastNight = await seatAndOrder(pc, kit, staff.waiter, restaurant.tables.T3 ?? '', [
      [restaurant.items.Dal, 1],
    ]);
    expect(
      await pc.get(PrismaService).auditLog.count({ where: { action: 'LICENCE_STATE_CHANGED' } }),
    ).toBeGreaterThan(0);
  });

  it('[DATA-010] the next morning: no new tables or orders; bills, reports and exports work', async () => {
    await now(AT.nextMorning);
    await pc.get(LicenceAgentService).refresh();
    expect(await licence()).toMatchObject({
      state: 'RESTRICTED',
      problem: 'GRACE_ENDED',
      daysLeft: 0,
    });
    const refused = await openTable('T4');
    expect([refused.status, codeOf(refused)]).toEqual([423, 'LICENCE_RESTRICTED']);
    const moreFood = await api(pc)
      .post('/api/v1/orders')
      .set(as(staff.waiter))
      .send({
        idempotencyKey: randomUUID(),
        source: 'WAITER_APP',
        orderType: 'DINE_IN',
        tableSessionId: lastNight.sessionId,
        lines: [{ clientLineId: randomUUID(), itemId: restaurant.items.Lassi, quantity: 1 }],
      });
    expect([moreFood.status, codeOf(moreFood)]).toEqual([423, 'LICENCE_RESTRICTED']);

    // Last night's table is billed and paid.
    const invoice = await billAndPay(pc, kit, staff.cashier, lastNight.sessionId);
    expect(invoice.grandTotal).toBeGreaterThan(0);

    // The reports and a report export.
    const sales = await api(pc)
      .get('/api/v1/reports/sales')
      .query({ from: '2026-11-01', to: '2026-12-02' })
      .set(as(staff.manager));
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
    expect(SalesSummaryResponse.parse(sales.body).totals.invoices).toBe(4);
    const exported = await api(pc)
      .post('/api/v1/reports/exports')
      .set(as(staff.manager))
      .send({ report: 'SALES', from: '2026-11-01', to: '2026-12-02', format: 'CSV' });
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    expect(ReportExportResponse.parse(exported.body).filename).toMatch(/\.csv$/);

    // The full data export (DATA-010): everything, in open formats.
    const started = await api(pc)
      .post('/api/v1/data-export')
      .set(as(staff.owner))
      .send({ folder: exportFolder });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await pc.get(DataExportService).settled();
    const last = DataExportResponse.parse(
      (await api(pc).get('/api/v1/data-export').set(as(staff.owner))).body,
    ).last;
    expect(last, JSON.stringify(last)).toMatchObject({ status: 'DONE', error: null });
    expect(existsSync(join(last?.folder ?? '', 'json', 'invoices.jsonl'))).toBe(true);
    expect(existsSync(join(last?.folder ?? '', 'invoice-register.csv'))).toBe(true);
  });

  it('[LIC-006] reactivated offline: the vendor reads a code over the phone, the Owner types it', async () => {
    const { code, validUntil } = await controlPlane
      .get(LicencesService)
      .reactivationCode(installationId, '2026-12-03', 'vendor:support', AT.nextMorning);
    expect(validUntil).toBe('2026-12-03');
    const reactivated = await api(pc)
      .post('/api/v1/licence/reactivate')
      .set(as(staff.owner))
      .send({ code });
    expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
    expect(LicenceView.parse(reactivated.body)).toMatchObject({
      state: 'ACTIVE',
      problem: null,
      details: { reactivatedUntil: ist('2026-12-04T04:00:00').toISOString() },
    });
    // Tables and orders again, still offline.
    const opened = await openTable('T4');
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(
      await pc.get(PrismaService).auditLog.count({ where: { action: 'LICENCE_REACTIVATED' } }),
    ).toBe(1);
  });

  it('[LIC-006] reactivated online once paid: "Check now" takes the active licence, for good', async () => {
    line.mend();
    await now(AT.paid);
    const unpaid = await billing().invoices({ tenantId, status: 'ISSUED' });
    expect(unpaid.map((entry) => entry.number).sort()).toEqual([
      'SUB/2026-27/00001',
      'SUB/2026-27/00002',
    ]);
    const invoice = unpaid.find((entry) => entry.number === 'SUB/2026-27/00001');
    // December's invoice is not yet due; paying November's lifts billing's own restriction.
    await billing().recordPayment(
      invoice?.id ?? '',
      { amount: invoice?.amount ?? 0, mode: 'UPI', reference: 'UPI-77', receivedOn: '2026-12-02' },
      'vendor:finance',
      AT.paid,
    );
    expect(await vendorState()).toBe('ACTIVE');
    const checked = await api(pc).post('/api/v1/licence/check').set(as(staff.owner));
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(LicenceView.parse(checked.body)).toMatchObject({
      state: 'ACTIVE',
      recorded: 'ACTIVE',
      problem: null,
    });

    // After the code's day the vendor's licence holds; nothing on this PC looked like tampering.
    await now(AT.afterCode);
    await pc.get(LicenceAgentService).refresh();
    expect(await licence()).toMatchObject({ state: 'ACTIVE', problem: null, restrictedFrom: null });
    await serveTable(pc, kit, staff, restaurant.tables.T1 ?? '', [[restaurant.items.Dal, 1]]);
    expect((await pc.get(LicenceAgentService).heartbeatReport()).tamper).toBeUndefined();
    expect(Date.parse((await licence()).validUntil ?? '')).toBeGreaterThan(
      AT.paid.getTime() + 29 * DAY_MS,
    );
  });
});
