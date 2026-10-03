import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { BackupsResponse } from '@rp/contracts';
import {
  AdminService,
  CloudBackupsService,
  CONTROL_PLANE_MIGRATIONS_DIR,
  CpConfigSchema,
  createControlPlaneApp,
  FleetService,
  type LocalObjectStore,
  OBJECT_STORE,
} from '@rp/control-plane/testing';
import { createMigratedDatabase, type TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import {
  CLOUD_BACKUP_OPTIONS,
  type CloudBackupOptions,
  CloudBackupService,
} from '../../src/backups/cloud-backup.service.js';
import { enrolInstallation } from '../../src/cloud/enrolment.js';
import { CONTROL_PLANE_OPTIONS, HeartbeatService } from '../../src/cloud/heartbeat.service.js';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl } from '../helpers/test-database.js';

/**
 * The encrypted cloud backup (P7-05d, DATA-003, DATA-005) between the real local server and a
 * real Control Plane, whose local store stands in for S3: the nightly backup reaches the cloud
 * byte for byte, a failure waits and alerts after a day, and the Owner's opt-out is audited and
 * reported to the vendor.
 */

const pgBin = process.env.RP_PG_BIN ?? process.env.PG_BIN;
const HOUR = 60 * 60_000;
let serverDatabase: TestDatabase;
let cpDatabase: TestDatabase;
let controlPlane: INestApplication;
let server: INestApplication;
let kit: AuthKit;
let installationId: string;
let clock = new Date();
let storageDown = false;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-cloud-'));

const options: CloudBackupOptions = {
  firstDelayMs: 0,
  checkEveryMs: 0,
  retryAfterMs: HOUR,
  partAttempts: 2,
  partRetryMs: 0,
  now: () => clock,
  // The PUTs to storage, which the test can make fail.
  fetch: (input, init) =>
    storageDown
      ? Promise.resolve(new Response('busy', { status: 503 }))
      : globalThis.fetch(input, init),
};

async function nightly(): Promise<string> {
  const backups = server.get(BackupService);
  const run = await backups.start('NIGHTLY');
  await backups.settled();
  const done = await server
    .get(PrismaService)
    .backupRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(done.status, done.error ?? '').toBe('SUCCEEDED');
  expect(done.cloudStatus).toBe('PENDING');
  return done.id;
}

async function overview(): Promise<BackupsResponse> {
  const manager = await signIn(server, kit, 'MANAGER');
  const response = await request(httpServer(server))
    .get('/api/v1/backups')
    .set(authHeaders(kit.deviceId, manager.accessToken));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return BackupsResponse.parse(response.body);
}

const openAlerts = () =>
  server.get(PrismaService).alert.count({
    where: { restaurantId: kit.restaurantId, dedupeKey: 'cloud-backup', status: 'OPEN' },
  });

beforeAll(async () => {
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
      backupStore: 'local',
      backupLocalDir: mkdtempSync(join(tmpdir(), 'cp-cloud-store-')),
    }),
  );
  await controlPlane.listen(0, '127.0.0.1');
  const address = (controlPlane.getHttpServer() as Server).address() as AddressInfo;
  const admin = controlPlane.get(AdminService);
  const tenant = await admin.createTenant('Cloud Dhaba', 'ci:test');
  const issued = await admin.createInstallation(
    { tenantId: tenant.id, name: 'Counter PC' },
    'ci:test',
  );
  installationId = issued.installationId;

  server = await createTestApp({
    databaseUrl: serverDatabase.url,
    config: {
      dataDir,
      controlPlaneUrl: `http://127.0.0.1:${String(address.port)}`,
      ...(pgBin !== undefined && { pgBin }),
    },
    overrides: [
      { provide: BACKUP_OPTIONS, useValue: { firstDelayMs: 0, checkEveryMs: 0, now: () => clock } },
      { provide: CLOUD_BACKUP_OPTIONS, useValue: options },
      {
        provide: CONTROL_PLANE_OPTIONS,
        useValue: {
          firstHeartbeatDelayMs: 60_000,
          defaultIntervalMs: 60_000,
          requestTimeoutMs: 5_000,
        },
      },
    ],
  });
  kit = await createAuthKit(server);
  await enrolInstallation({
    config: { controlPlaneUrl: `http://127.0.0.1:${String(address.port)}` },
    prisma: server.get(PrismaService),
    secrets: server.get<SecretStore>(SECRET_STORE),
    code: issued.code,
  });
}, 60_000);

afterAll(async () => {
  await server.close();
  await controlPlane.close();
  await serverDatabase.drop();
  await cpDatabase.drop();
});

describe('[DATA-003] the nightly backup in the cloud', () => {
  it('uploads the encrypted file byte for byte, once', async () => {
    const runId = await nightly();
    const cloud = server.get(CloudBackupService);
    expect(await cloud.runIfDue()).toBe('UPLOADED');
    const run = await server
      .get(PrismaService)
      .backupRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ cloudStatus: 'UPLOADED', cloudError: null });

    const [stored] = await controlPlane.get(CloudBackupsService).list(installationId);
    expect(stored).toMatchObject({
      id: run.cloudBackupId,
      sha256: run.sha256,
      fileName: run.fileName,
    });
    const store = controlPlane.get<LocalObjectStore>(OBJECT_STORE);
    // The Control Plane keys each backup by PC and record.
    const objectKey = `backups/${installationId}/${stored!.id}.rpbk`;
    const grant = store.verify((await store.downloadUrl(objectKey, 60)).split('/').at(-1)!);
    const chunks: Buffer[] = [];
    for await (const chunk of store.open(grant!)) chunks.push(chunk as Buffer);
    const local = readFileSync(join(dataDir, 'backups', 'full', run.fileName!));
    expect(Buffer.concat(chunks).equals(local)).toBe(true);

    expect(await cloud.runIfDue()).toBe('NOTHING');
    const view = await overview();
    expect(view.cloud).toMatchObject({ state: 'OK', lastError: null });
    expect(view.runs[0]?.cloud).toBe('UPLOADED');
  });

  it('[DATA-005] [NFR-A04] waits and retries when storage fails, and alerts after a day without', async () => {
    const cloud = server.get(CloudBackupService);
    clock = new Date(clock.getTime() + 27 * HOUR);
    await nightly();
    storageDown = true;
    expect(await cloud.runIfDue()).toBe('FAILED');
    expect((await overview()).cloud).toMatchObject({ state: 'FAILING' });
    expect((await overview()).cloud.lastError).toMatch(
      /The upload to the cloud failed: storage answered 503/,
    );
    expect(await openAlerts()).toBe(1);
    // Tried again only after an hour.
    expect(await cloud.runIfDue()).toBe('WAITING');
    storageDown = false;
    clock = new Date(clock.getTime() + HOUR + 1_000);
    expect(await cloud.runIfDue()).toBe('UPLOADED');
    expect((await overview()).cloud.state).toBe('OK');
    expect(await openAlerts()).toBe(0);
    // The upload given up was cleared away at the Control Plane.
    expect(await controlPlane.get(CloudBackupsService).list(installationId)).toHaveLength(2);
  });

  it('only sends the newest of the backups waiting', async () => {
    const first = await nightly();
    clock = new Date(clock.getTime() + 24 * HOUR);
    const second = await nightly();
    expect(await server.get(CloudBackupService).runIfDue()).toBe('UPLOADED');
    const prisma = server.get(PrismaService);
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: first } })).cloudStatus).toBe(
      'SKIPPED',
    );
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: second } })).cloudStatus).toBe(
      'UPLOADED',
    );
  });

  it('lets the Owner opt out, audited, and tells the vendor', async () => {
    const owner = await signIn(server, kit, 'OWNER');
    await server.get(PrismaService).session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
    const changed = await request(httpServer(server))
      .put('/api/v1/settings/backups.cloudEnabled')
      .set(authHeaders(kit.deviceId, owner.accessToken))
      .send({ value: false, reason: 'We keep our own copies' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const audit = await server.get(PrismaService).auditLog.findFirst({
      where: { action: 'SETTING_CHANGED', actorId: kit.staff.OWNER },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit).toMatchObject({
      reason: 'We keep our own copies',
      after: { key: 'backups.cloudEnabled', value: false },
    });

    await nightly();
    expect(await server.get(CloudBackupService).runIfDue()).toBe('OFF');
    expect((await overview()).cloud.state).toBe('OFF');

    const status = await server.get(HeartbeatService).beat();
    expect(status.lastError).toBeNull();
    const fleet = await controlPlane.get(FleetService).fleet();
    const pc = fleet.installations.find((entry) => entry.installationId === installationId);
    expect(pc?.backup?.cloud?.enabled).toBe(false);
    expect(pc?.cloudBackupAt).not.toBeNull();
  });
});
