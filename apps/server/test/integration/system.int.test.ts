import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ApiError, type LoginResponse, SystemStatusResponse } from '@rp/contracts';
import type { ReleaseInfo } from '@rp/contracts/control-plane';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveOfferedUpdate } from '../../src/cloud/control-plane-state.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * The System page (P4-04, MGR-010, NFR-I03, DATA-006, UPD-004) against a real database and a
 * data folder with photos and logs in it.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let cashier: LoginResponse;
let waiter: LoginResponse;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-system-'));

const release = (version: string): ReleaseInfo => ({
  component: 'RESTAURANT_PC',
  channel: 'STABLE',
  version,
  url: 'https://downloads.example.com/restaurant-pc.exe',
  sha256: 'a'.repeat(64),
  sizeBytes: 120_000_000,
  notes: 'Faster bills.',
  publishedAt: '2026-09-30T10:00:00.000Z',
});

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const status = async (login: LoginResponse = manager) => {
  const response = await server().get('/api/v1/system').set(as(login));
  expect(response.status).toBe(200);
  return SystemStatusResponse.parse(response.body);
};

beforeAll(async () => {
  mkdirSync(join(dataDir, 'photos', 'r1', 'p1'), { recursive: true });
  writeFileSync(join(dataDir, 'photos', 'r1', 'p1', '160.webp'), Buffer.alloc(1_000));
  writeFileSync(join(dataDir, 'photos', 'r1', 'p1', '640.webp'), Buffer.alloc(3_000));
  mkdirSync(join(dataDir, 'logs'));
  writeFileSync(join(dataDir, 'logs', 'server.log'), Buffer.alloc(500));
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, config: { dataDir } });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  cashier = await signIn(app, kit, 'CASHIER');
  waiter = await signIn(app, kit, 'WAITER');
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[MGR-010] [NFR-I03] the System page', () => {
  it('shows versions, the database, the vendor link and the devices', async () => {
    const system = await status();
    expect(system.versions.map((version) => version.name)).toEqual([
      'Server',
      'Node.js',
      'PostgreSQL',
    ]);
    expect(system.database.status).toBe('up');
    expect(system.controlPlane).toEqual({
      configured: false,
      enrolled: false,
      lastContactAt: null,
      lastError: null,
    });
    // The test kit pairs one POS terminal; it has no live connection here.
    expect(system.devices).toEqual([{ type: 'POS', paired: 1, connected: 0 }]);
    expect(system.backup).toBeNull();
    expect(system.licence).toBeNull();
  });

  it('[DATA-006] measures the drive and each kind of data on it', async () => {
    const { storage } = await status();
    expect(storage.totalBytes).toBeGreaterThan(0);
    expect(storage.usedPercent).not.toBeNull();
    expect(storage).toMatchObject({ warnPercent: 80, criticalPercent: 90 });
    const bytes = Object.fromEntries(
      storage.categories.map((entry) => [entry.category, entry.bytes]),
    );
    expect(bytes.PHOTOS).toBe(4_000);
    expect(bytes.LOGS).toBe(500);
    // No backups are set up until P7-05.
    expect(bytes.BACKUPS).toBeNull();
    expect(bytes.TRANSACTIONS).toBeGreaterThan(0);
    expect(bytes.AUDIT).toBeGreaterThan(0);
  });

  it('is for people who configure operations', async () => {
    const response = await server().get('/api/v1/system').set(as(waiter));
    expect(response.status).toBe(403);
  });
});

describe('[UPD-004] [AUD-001] "Install now"', () => {
  it('refuses a version that is not on offer', async () => {
    const response = await server()
      .post('/api/v1/system/update/approve')
      .set(as(manager))
      .send({ version: '1.2.0' });
    expect(response.status).toBe(409);
    expect(ApiError.parse(response.body).code).toBe('UPDATE_NOT_OFFERED');
  });

  it('records a manager’s approval for the update on offer, audited', async () => {
    await saveOfferedUpdate(prisma, release('1.2.0'));
    expect((await status()).update).toMatchObject({
      offered: { version: '1.2.0', channel: 'STABLE', notes: 'Faster bills.' },
      installApproval: null,
      maintenanceWindow: { start: '03:00', end: '06:00' },
      openTables: 0,
    });
    const refused = await server()
      .post('/api/v1/system/update/approve')
      .set(as(cashier))
      .send({ version: '1.2.0' });
    expect(refused.status).toBe(403);

    const response = await server()
      .post('/api/v1/system/update/approve')
      .set(as(manager))
      .send({ version: '1.2.0', reason: 'Quiet afternoon' });
    expect(response.status).toBe(200);
    const { update } = SystemStatusResponse.parse(response.body);
    expect(update.installApproval).toMatchObject({ version: '1.2.0' });
    expect(update.installApproval?.approvedBy).toEqual(expect.any(String));
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'UPDATE_INSTALL_APPROVED' },
    });
    expect(entry.reason).toBe('Quiet afternoon');
    expect(entry.after).toMatchObject({ version: '1.2.0', channel: 'STABLE' });
  });

  it('forgets an approval once a newer version is on offer', async () => {
    await saveOfferedUpdate(prisma, release('1.3.0'));
    expect((await status()).update).toMatchObject({
      offered: { version: '1.3.0' },
      installApproval: null,
    });
  });
});
