import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  DiagnosticsResponse,
  type LoginResponse,
  SystemUpdates,
  SystemView,
} from '@rp/contracts';
import type { HeartbeatRequest, ReleaseInfo } from '@rp/contracts/control-plane';
import { storageLevelOf } from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveEnrolment, saveOfferedUpdate } from '../../src/cloud/control-plane-state.js';
import { CONTROL_PLANE_OPTIONS } from '../../src/cloud/heartbeat.service.js';
import { SERVER_PACKAGE } from '../../src/common/package-version.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * The System page (P4-04b, MGR-010, NFR-I03): the support screen's view, "Install now" (UPD-004)
 * and "Send diagnostics to support" (UPD-008), against a stand-in Control Plane.
 */

const INSTALLATION_ID = '0199a000-0000-7000-8000-000000000001';

function release(version: string, securityCritical?: boolean): ReleaseInfo {
  return {
    component: 'RESTAURANT_PC',
    channel: 'STABLE',
    version,
    url: `https://updates.example.com/rp-${version}.exe`,
    sha256: '0123456789abcdef'.repeat(4),
    sizeBytes: 104_857_600,
    notes: 'Faster bill printing.',
    publishedAt: '2026-10-01T05:30:00.000Z',
    ...(securityCritical !== undefined && { securityCritical }),
  };
}

/** How the stand-in Control Plane answers the next heartbeat. */
let answer: 'accept' | 'unreachable' | 'revoked' = 'accept';
const heartbeats: HeartbeatRequest[] = [];

const standInControlPlane: typeof fetch = (input, init) => {
  if (answer === 'unreachable') return Promise.reject(new TypeError('fetch failed'));
  if (answer === 'revoked') {
    return Promise.resolve(
      Response.json(
        { code: 'INSTALLATION_REVOKED', message: 'This installation was revoked.' },
        { status: 403 },
      ),
    );
  }
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  expect(url).toBe('http://control-plane.test/v1/heartbeats');
  expect(typeof init?.body).toBe('string');
  heartbeats.push(JSON.parse(init?.body as string) as HeartbeatRequest);
  const now = new Date().toISOString();
  return Promise.resolve(
    Response.json({
      receivedAt: now,
      serverTime: now,
      nextHeartbeatSeconds: 300,
      update: release('1.4.1', true),
    }),
  );
};

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let cashier: LoginResponse;
let tableId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  // Photos and logs on the data drive, measured by category (DATA-006).
  const dataDir = mkdtempSync(join(tmpdir(), 'rp-system-data-'));
  mkdirSync(join(dataDir, 'photos', 'r1', 'p1'), { recursive: true });
  writeFileSync(join(dataDir, 'photos', 'r1', 'p1', '400.webp'), Buffer.alloc(1_000));
  writeFileSync(join(dataDir, 'photos', 'r1', 'p1', '800.webp'), Buffer.alloc(3_000));
  mkdirSync(join(dataDir, 'logs'));
  writeFileSync(join(dataDir, 'logs', 'server.log'), Buffer.alloc(2_048));
  app = await createTestApp({
    databaseUrl: database.url,
    config: { dataDir, controlPlaneUrl: 'http://control-plane.test', productVersion: '1.0.0' },
    overrides: [
      {
        provide: CONTROL_PLANE_OPTIONS,
        // Only the test's own calls send heartbeats.
        useValue: {
          firstHeartbeatDelayMs: 3_600_000,
          defaultIntervalMs: 3_600_000,
          requestTimeoutMs: 5_000,
          fetch: standInControlPlane,
        },
      },
    ],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  cashier = await signIn(app, kit, 'CASHIER');
  const hall = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  tableId = (
    await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: hall.id, label: '1' },
    })
  ).id;
  await prisma.printer.create({
    data: { restaurantId: kit.restaurantId, name: 'Kitchen', connection: 'NETWORK' },
  });
  await prisma.printer.create({
    data: {
      restaurantId: kit.restaurantId,
      name: 'Bar',
      connection: 'NETWORK',
      offlineSince: new Date(),
      lastError: 'Out of paper',
    },
  });
  // An unpaired screen is not counted.
  const gone = await addDevice(app, kit, 'KDS');
  await prisma.device.update({ where: { id: gone }, data: { status: 'REVOKED' } });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));
const asManager = () => authHeaders(kit.deviceId, manager.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

async function view(): Promise<SystemView> {
  const response = await server().get('/api/v1/system').set(asManager());
  expect(response.status).toBe(200);
  return SystemView.parse(response.body);
}

const installNow = (body: object) =>
  server().post('/api/v1/system/updates/install-now').set(asManager()).send(body);

async function openTable(): Promise<string> {
  const response = await server()
    .post(`/api/v1/tables/${tableId}/open`)
    .set(asManager())
    .send({ covers: 2 });
  expect(response.status).toBe(201);
  return (response.body as { id: string }).id;
}

async function freeTable(sessionId: string): Promise<void> {
  const response = await server()
    .post(`/api/v1/table-sessions/${sessionId}/close-without-bill`)
    .set(asManager())
    .send({ reason: 'Opened by mistake' });
  expect(response.status).toBe(200);
}

describe('[MGR-010] [NFR-I03] the System page', () => {
  it('[MGR-010] [NFR-I03] [DATA-006] shows versions, services, devices, storage, backups and updates', async () => {
    const system = await view();
    expect(system.versions).toEqual({
      product: '1.0.0',
      server: SERVER_PACKAGE.version,
      node: process.versions.node,
      postgres: expect.stringMatching(/^\d+\.\d+/) as string,
      buildId: null,
    });
    expect(system.services).toEqual({
      database: { up: true, latencyMs: expect.any(Number) as number },
      // Tests run without the broker.
      pagerBroker: { running: false, port: null, secure: false, connectedPagers: 0 },
      printers: { total: 2, offline: 1, waiting: 0 },
      controlPlane: { configured: true, enrolled: false, lastReportAt: null, lastError: null },
    });
    // The POS terminal is paired; nothing has a live connection in this test.
    expect(system.devices).toEqual([{ type: 'POS', paired: 1, connected: 0 }]);

    const { storage } = system;
    expect(storage.totalBytes).toBeGreaterThan(0);
    expect(storage.usedPercent).not.toBeNull();
    expect(storage).toMatchObject({ warnPercent: 80, criticalPercent: 90 });
    expect(storage.level).toBe(
      storageLevelOf(storage.usedPercent ?? 0, { warnPercent: 80, criticalPercent: 90 }),
    );
    const bytes = Object.fromEntries(
      storage.categories.map((entry) => [entry.category, entry.bytes]),
    );
    expect(Object.keys(bytes)).toEqual(['TRANSACTIONS', 'AUDIT', 'PHOTOS', 'LOGS', 'BACKUPS']);
    expect(bytes).toMatchObject({ PHOTOS: 4_000, LOGS: 2_048, BACKUPS: 0 });
    expect(bytes.TRANSACTIONS).toBeGreaterThan(0);
    expect(bytes.AUDIT).toBeGreaterThan(0);

    expect(system.backups).toEqual({
      walMode: 'CONTINUOUS',
      secondLocation: null,
      keepDaily: 14,
      keepWeekly: 8,
      cloudEnabled: true,
      lastBackupAt: null,
    });
    expect(system.licence).toBeNull();
    expect(system.updates).toEqual({
      current: '1.0.0',
      channel: null,
      offered: null,
      maintenanceWindow: { start: '03:00', end: '06:00' },
      approval: null,
      openTables: 0,
    });
  });

  it('[AUTH-010] is for people who configure operations, and "Install now" for those who install', async () => {
    const asCashier = authHeaders(kit.deviceId, cashier.accessToken);
    expect((await server().get('/api/v1/system').set(asCashier)).status).toBe(403);
    expect((await server().post('/api/v1/system/diagnostics').set(asCashier)).status).toBe(403);
    const install = await server()
      .post('/api/v1/system/updates/install-now')
      .set(asCashier)
      .send({ version: '1.4.0' });
    expect(install.status).toBe(403);
  });

  it('[UPD-008] cannot send diagnostics before this PC is linked to support', async () => {
    const response = await server().post('/api/v1/system/diagnostics').set(asManager());
    expect(response.status).toBe(409);
    expect(codeOf(response)).toBe('NOT_ENROLLED');
    expect(heartbeats).toHaveLength(0);
  });
});

describe('[UPD-004] "Install now"', () => {
  beforeAll(async () => {
    await saveEnrolment(prisma, {
      installationId: INSTALLATION_ID,
      tenantId: '0199a000-0000-7000-8000-000000000002',
      name: 'Counter PC',
      channel: 'STABLE',
      enrolledAt: '2026-09-30T06:00:00.000Z',
      controlPlaneUrl: 'http://control-plane.test',
    });
    await saveOfferedUpdate(prisma, release('1.4.0'));
  });

  it('[UPD-004] [AUD-001] waits for every table to close, then records the manager’s approval once', async () => {
    expect((await view()).updates).toMatchObject({
      channel: 'STABLE',
      offered: {
        version: '1.4.0',
        channel: 'STABLE',
        notes: 'Faster bill printing.',
        sizeBytes: 104_857_600,
        publishedAt: '2026-10-01T05:30:00.000Z',
        securityCritical: false,
      },
      approval: null,
    });

    const notOffered = await installNow({ version: '1.3.9' });
    expect(notOffered.status).toBe(409);
    expect(codeOf(notOffered)).toBe('UPDATE_NOT_OFFERED');

    const session = await openTable();
    const open = await installNow({ version: '1.4.0', reason: 'Please install it now' });
    expect(open.status).toBe(409);
    expect(ApiError.parse(open.body)).toMatchObject({
      code: 'TABLES_OPEN',
      message: expect.stringMatching(/^1 table is open\./) as string,
      details: { openTables: 1 },
    });
    expect((await view()).updates.openTables).toBe(1);

    await freeTable(session);
    const approved = await installNow({ version: '1.4.0' });
    expect(approved.status).toBe(200);
    const updates = SystemUpdates.parse(approved.body);
    expect(updates).toMatchObject({
      openTables: 0,
      approval: {
        version: '1.4.0',
        approvedBy: { id: kit.staff.MANAGER, name: 'Test manager' },
        reason: null,
      },
    });
    const entries = await prisma.auditLog.findMany({
      where: { action: 'UPDATE_INSTALL_APPROVED' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: kit.staff.MANAGER,
      deviceId: kit.deviceId,
      entityType: 'software_update',
      before: { version: '1.0.0', approved: null },
      after: { version: '1.4.0', securityCritical: false, openTables: 0 },
    });

    // Pressing it again changes nothing.
    const again = await installNow({ version: '1.4.0' });
    expect(SystemUpdates.parse(again.body).approval).toEqual(updates.approval);
    expect(await prisma.auditLog.count({ where: { action: 'UPDATE_INSTALL_APPROVED' } })).toBe(1);
    expect((await view()).updates.approval).toEqual(updates.approval);
  });

  it('[UPD-004] lets a security update through open tables once the manager says why', async () => {
    await saveOfferedUpdate(prisma, release('1.4.1', true));
    // The approval was for 1.4.0, not for the release offered now.
    expect((await view()).updates).toMatchObject({
      offered: { version: '1.4.1', securityCritical: true },
      approval: null,
    });

    const session = await openTable();
    const noReason = await installNow({ version: '1.4.1' });
    expect(noReason.status).toBe(409);
    expect(codeOf(noReason)).toBe('REASON_REQUIRED');

    const approved = await installNow({ version: '1.4.1', reason: 'Vendor security advice' });
    expect(approved.status).toBe(200);
    expect(SystemUpdates.parse(approved.body)).toMatchObject({
      openTables: 1,
      approval: { version: '1.4.1', reason: 'Vendor security advice' },
    });
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'UPDATE_INSTALL_APPROVED' },
      orderBy: { chainSeq: 'desc' },
    });
    expect(entry).toMatchObject({
      reason: 'Vendor security advice',
      before: { version: '1.0.0', approved: '1.4.0' },
      after: { version: '1.4.1', securityCritical: true, openTables: 1 },
    });
    await freeTable(session);
  });
});

describe('[UPD-008] "Send diagnostics to support"', () => {
  it('[UPD-008] stops saying "not linked" once this PC is linked', async () => {
    // The last report found no enrolment; the PC has been enrolled since.
    expect((await view()).services.controlPlane).toEqual({
      configured: true,
      enrolled: true,
      lastReportAt: null,
      lastError: null,
    });
  });

  it('[UPD-008] [AUD-001] sends the health report now and says when it arrived', async () => {
    answer = 'accept';
    const response = await server().post('/api/v1/system/diagnostics').set(asManager());
    expect(response.status).toBe(200);
    const { sentAt } = DiagnosticsResponse.parse(response.body);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]?.components).toContainEqual({ name: 'RESTAURANT_PC', version: '1.0.0' });
    expect(heartbeats[0]?.devices).toEqual({ POS: 1 });

    expect((await view()).services.controlPlane).toEqual({
      configured: true,
      enrolled: true,
      lastReportAt: sentAt,
      lastError: null,
    });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'DIAGNOSTICS_SENT' } });
    expect(audit).toMatchObject({
      actorId: kit.staff.MANAGER,
      after: { sentAt, installationId: INSTALLATION_ID },
    });
  });

  it('[UPD-008] says when support cannot be reached or refuses, and records nothing', async () => {
    answer = 'unreachable';
    const unreachable = await server().post('/api/v1/system/diagnostics').set(asManager());
    expect(unreachable.status).toBe(503);
    expect(codeOf(unreachable)).toBe('SUPPORT_UNREACHABLE');
    expect((await view()).services.controlPlane.lastError).toBe('UNREACHABLE');

    answer = 'revoked';
    const refused = await server().post('/api/v1/system/diagnostics').set(asManager());
    expect(refused.status).toBe(502);
    expect(ApiError.parse(refused.body)).toMatchObject({
      code: 'SUPPORT_REFUSED',
      details: { reason: 'INSTALLATION_REVOKED' },
    });
    expect(await prisma.auditLog.count({ where: { action: 'DIAGNOSTICS_SENT' } })).toBe(1);
  });
});
