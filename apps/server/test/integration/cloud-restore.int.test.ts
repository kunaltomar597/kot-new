import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  AdminService,
  BackupEscrowService,
  CONTROL_PLANE_MIGRATIONS_DIR,
  CpConfigSchema,
  createControlPlaneApp,
} from '@rp/control-plane/testing';
import { createMigratedDatabase, type TestDatabase } from '@rp/test-postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import {
  CLOUD_BACKUP_OPTIONS,
  CloudBackupService,
} from '../../src/backups/cloud-backup.service.js';
import { readEscrowedKey } from '../../src/backups/escrow-state.js';
import { runRestoreCli } from '../../src/backups/restore-cli.js';
import { enrolInstallation } from '../../src/cloud/enrolment.js';
import { CONTROL_PLANE_OPTIONS, HeartbeatService } from '../../src/cloud/heartbeat.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { addStaff, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl } from '../helpers/test-database.js';

/**
 * Restore from the cloud onto a new PC (P7-05e, DATA-003, DATA-004, OI-10): the PC escrows its
 * backup key and uploads its nightly backup; the PC and its drives are lost; Support issues a
 * restore code after verifying the Owner, who is told; the restore tool on a new PC restores the
 * newest cloud backup with it, and the staff sign in as before.
 */

const pgBin = process.env.RP_PG_BIN ?? process.env.PG_BIN;
const vendorKey = generateKeyPairSync('rsa', { modulusLength: 3072 });
let serverDatabase: TestDatabase;
let cpDatabase: TestDatabase;
let controlPlane: INestApplication;
let server: INestApplication;
let kit: AuthKit;
let installationId: string;
let controlPlaneUrl: string;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-cloud-a-'));
const quiet = {
  firstHeartbeatDelayMs: 600_000,
  defaultIntervalMs: 600_000,
  requestTimeoutMs: 5_000,
};

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
      backupLocalDir: mkdtempSync(join(tmpdir(), 'cp-restore-store-')),
      escrowPrivateKey: vendorKey.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
    }),
  );
  await controlPlane.listen(0, '127.0.0.1');
  controlPlaneUrl = `http://127.0.0.1:${String(((controlPlane.getHttpServer() as Server).address() as AddressInfo).port)}`;
  const admin = controlPlane.get(AdminService);
  const tenant = await admin.createTenant('Escrow Dhaba', 'ci:test');
  const issued = await admin.createInstallation(
    { tenantId: tenant.id, name: 'Counter PC' },
    'ci:test',
  );
  installationId = issued.installationId;

  server = await createTestApp({
    databaseUrl: serverDatabase.url,
    config: { dataDir, controlPlaneUrl, ...(pgBin !== undefined && { pgBin }) },
    overrides: [
      {
        provide: BACKUP_OPTIONS,
        useValue: { firstDelayMs: 0, checkEveryMs: 0, now: () => new Date() },
      },
      {
        provide: CLOUD_BACKUP_OPTIONS,
        useValue: {
          firstDelayMs: 0,
          checkEveryMs: 0,
          retryAfterMs: 60_000,
          partAttempts: 1,
          partRetryMs: 0,
          now: () => new Date(),
        },
      },
      { provide: CONTROL_PLANE_OPTIONS, useValue: quiet },
    ],
  });
  kit = await createAuthKit(server);
  await enrolInstallation({
    config: { controlPlaneUrl },
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

describe('[DATA-004] [OI-10] restoring from the cloud onto a new PC', () => {
  it('escrows the key, uploads, alerts the Owner to the code, and restores on a new PC', async () => {
    const prisma = server.get(PrismaService);
    // The heartbeat answer offers the escrow key; the PC escrows its backup key.
    expect((await server.get(HeartbeatService).beat()).lastError).toBeNull();
    const escrowed = await readEscrowedKey(prisma);
    expect(escrowed?.keyId).toMatch(/^[0-9a-f]{16}$/);

    const waiter = await addStaff(server, kit, 'WAITER', '6161');
    const backups = server.get(BackupService);
    await backups.start('NIGHTLY');
    await backups.settled();
    expect(await server.get(CloudBackupService).runIfDue()).toBe('UPLOADED');
    expect((await server.get(CloudBackupService).view(kit.restaurantId)).keyEscrowedAt).toBe(
      escrowed?.at,
    );

    // Support verifies the Owner and issues a code; the restaurant's Owner is alerted.
    const { code } = await controlPlane
      .get(BackupEscrowService)
      .issueCode(
        installationId,
        { reason: 'The PC and the USB drive were stolen', ownerVerification: 'Video call with ID' },
        { userId: '00000000-0000-7000-8000-000000000001', actor: 'vendor:support' },
      );
    await server.get(HeartbeatService).beat();
    const alert = await prisma.alert.findFirst({
      where: { type: 'VENDOR_RESTORE_CODE', restaurantId: kit.restaurantId },
    });
    expect(alert?.payload).toMatchObject({ reason: 'The PC and the USB drive were stolen' });
    // Told once: the next heartbeat reports it seen, and no second alert comes.
    await server.get(HeartbeatService).beat();
    await server.get(HeartbeatService).beat();
    expect(await prisma.alert.count({ where: { type: 'VENDOR_RESTORE_CODE' } })).toBe(1);

    // The new PC: an empty database, its own data folder and secrets.
    const fresh = await createTestDatabase();
    const newData = mkdtempSync(join(tmpdir(), 'rp-cloud-b-'));
    const output: string[] = [];
    const exit = await runRestoreCli(
      ['cloud', code],
      {
        NODE_ENV: 'test',
        DATABASE_URL: fresh.url,
        RP_DATA_DIR: newData,
        RP_ADMIN_DATABASE_URL: testAdminUrl(),
        RP_CONTROL_PLANE_URL: controlPlaneUrl,
        ...(pgBin !== undefined && { RP_PG_BIN: pgBin }),
      },
      { write: (text) => output.push(text) },
    );
    expect(exit, output.join('')).toBe(0);
    expect(output.join('')).toMatch(/Restored Escrow Dhaba from rp-backup-.*-nightly\.rpbk/);

    // The code worked once.
    const again = await runRestoreCli(
      ['cloud', code],
      {
        NODE_ENV: 'test',
        DATABASE_URL: fresh.url,
        RP_DATA_DIR: mkdtempSync(join(tmpdir(), 'rp-cloud-c-')),
        RP_ADMIN_DATABASE_URL: testAdminUrl(),
        RP_CONTROL_PLANE_URL: controlPlaneUrl,
      },
      { write: () => undefined },
    ).catch((error: unknown) => error);
    expect(again).toMatchObject({ code: 'RESTORE_CODE_INVALID' });

    const restored = await createTestApp({
      databaseUrl: fresh.url,
      config: { dataDir: newData, ...(pgBin !== undefined && { pgBin }) },
      overrides: [
        {
          provide: BACKUP_OPTIONS,
          useValue: { firstDelayMs: 0, checkEveryMs: 0, now: () => new Date() },
        },
        { provide: CONTROL_PLANE_OPTIONS, useValue: quiet },
      ],
    });
    try {
      // The staff, their PINs and the paired POS came back.
      expect((await signIn(restored, kit, 'MANAGER')).staff.id).toBe(kit.staff.MANAGER);
      expect(
        await restored.get(PrismaService).staff.findUnique({ where: { id: waiter } }),
      ).not.toBeNull();
    } finally {
      await restored.close();
      await fresh.drop();
    }
  }, 120_000);
});
