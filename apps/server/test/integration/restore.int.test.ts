import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BackupsResponse,
  type LoginResponse,
  RecoveryKeyResponse,
  RestoreBackupResponse,
} from '@rp/contracts';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileSecretStore, SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import { BackupFileError } from '../../src/backups/backup-file.js';
import { readRestoreOutcome, runPendingRestore } from '../../src/backups/pending-restore.js';
import { formatRecoveryKey, parseRecoveryKey } from '../../src/backups/recovery-key.js';
import { runRestoreCli } from '../../src/backups/restore-cli.js';
import { RestoreError, restoreBackup } from '../../src/backups/restore.js';
import { ServerLifecycle } from '../../src/common/server-lifecycle.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { addStaff, authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase, testAdminUrl } from '../helpers/test-database.js';

/**
 * Restore (P7-05b, DATA-004): backup → wipe → restore onto a new PC with the recovery key, with
 * the RTO and RPO measured, and the Owner's one-click restore on the same PC.
 */

const pgBin = process.env.RP_PG_BIN ?? process.env.PG_BIN;
const options = (now: () => Date) => [
  { provide: BACKUP_OPTIONS, useValue: { firstDelayMs: 0, checkEveryMs: 0, now } },
];

let original: TestDatabase;
let originalApp: INestApplication | undefined;
let kit: AuthKit;
let backupFile: string;
let backupKey: Buffer;
let backupMadeAt: Date;
const originalData = mkdtempSync(join(tmpdir(), 'rp-restore-a-'));
const leftovers: string[] = [];

async function query<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  database?: string,
) {
  const url = new URL(testAdminUrl());
  if (database !== undefined) url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function makeBackup(app: INestApplication): Promise<string> {
  const backups = app.get(BackupService);
  const run = await backups.start('MANUAL');
  await backups.settled();
  const done = await app.get(PrismaService).backupRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(done.status, done.error ?? '').toBe('SUCCEEDED');
  return join(originalData, 'backups', 'full', done.fileName!);
}

beforeAll(async () => {
  mkdirSync(join(originalData, 'photos', 'r1'), { recursive: true });
  writeFileSync(join(originalData, 'photos', 'r1', '640.webp'), 'the dal photo');
  original = await createTestDatabase();
  originalApp = await createTestApp({
    databaseUrl: original.url,
    config: { dataDir: originalData, ...(pgBin !== undefined && { pgBin }) },
    overrides: options(() => new Date()),
  });
  kit = await createAuthKit(originalApp);
  backupFile = await makeBackup(originalApp);
  backupMadeAt = new Date();
  backupKey = await originalApp.get<SecretStore>(SECRET_STORE).get('backup-key');
});

afterAll(async () => {
  await originalApp?.close();
  for (const name of leftovers) {
    await query(`DROP DATABASE IF EXISTS "${name}"`);
  }
  await original.drop();
});

describe('[DATA-004] restore onto a new PC', () => {
  it('backs up, loses the PC, and restores with the recovery key (RTO and RPO measured)', async () => {
    const app = originalApp!;
    // Work after the backup: lost with the PC (the RPO).
    const late = await addStaff(app, kit, 'WAITER', '7777');
    const streamBefore = await app
      .get(PrismaService)
      .systemMeta.findUnique({ where: { key: 'events.stream_id' } });

    // The new PC: a fresh install (an empty database), its own data folder and secrets.
    const fresh = await createTestDatabase();
    const newData = mkdtempSync(join(tmpdir(), 'rp-restore-b-'));
    const output: string[] = [];
    const lostAt = new Date();
    const code = await runRestoreCli(
      ['restore', backupFile],
      {
        NODE_ENV: 'test',
        DATABASE_URL: fresh.url,
        RP_DATA_DIR: newData,
        RP_ADMIN_DATABASE_URL: testAdminUrl(),
        ...(pgBin !== undefined && { RP_PG_BIN: pgBin }),
        RP_RECOVERY_KEY: formatRecoveryKey(backupKey),
      },
      { write: (text) => output.push(text) },
    );
    expect(code, output.join('')).toBe(0);
    const rtoMs = Date.now() - lostAt.getTime();
    const rpoMs = lostAt.getTime() - backupMadeAt.getTime();
    // eslint-disable-next-line no-console -- the measurement the WP asks for (docs/build/restore-timing.md)
    console.log(`[DATA-004] restore RTO ${String(rtoMs)} ms, RPO ${String(rpoMs)} ms`);
    expect(output.join('')).toMatch(/Restored the backup made/);
    // The fresh install held nothing: no earlier database is kept.
    expect(output.join('')).not.toMatch(/kept as/);

    // The secrets came with it: the same PIN pepper, device token key and installation key.
    const newSecrets = new FileSecretStore(join(newData, 'secrets'), {});
    const oldSecrets = app.get<SecretStore>(SECRET_STORE);
    for (const name of ['pin-pepper', 'device-token-key', 'installation-signing-key'] as const) {
      expect((await newSecrets.get(name)).equals(await oldSecrets.get(name)), name).toBe(true);
    }
    // But the new PC keeps its own backup key.
    expect((await newSecrets.get('backup-key')).equals(backupKey)).toBe(false);
    expect(readFileSync(join(newData, 'photos', 'r1', '640.webp'), 'utf8')).toBe('the dal photo');

    const restored = await createTestApp({
      databaseUrl: fresh.url,
      config: { dataDir: newData, ...(pgBin !== undefined && { pgBin }) },
      overrides: options(() => new Date()),
    });
    try {
      const prisma = restored.get(PrismaService);
      // The paired POS and the manager's PIN work as before.
      const manager = await signIn(restored, kit, 'MANAGER');
      expect(manager.staff.id).toBe(kit.staff.MANAGER);
      // Work after the backup is gone; the event stream starts again for every device (P0-12).
      expect(await prisma.staff.findUnique({ where: { id: late } })).toBeNull();
      const stream = await prisma.systemMeta.findUnique({ where: { key: 'events.stream_id' } });
      expect(stream?.value).not.toBe(streamBefore?.value);
      // AUD-001: the restore is in the audit trail.
      expect(await prisma.auditLog.count({ where: { action: 'BACKUP_RESTORED' } })).toBe(1);
      // The grants came back: the server's role still may not delete an invoice (AUD-004).
      const grants = await query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'rp_app' AND table_name = 'invoices'`,
        [],
        fresh.name,
      );
      expect(grants.map((grant) => grant.privilege_type).sort()).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
      // Owned by the owner role, with its default privileges, so later migrations work.
      const owners = await query<{ owner: string }>(
        "SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname = 'public'",
        [],
        fresh.name,
      );
      expect(owners).toEqual([{ owner: 'rp_owner' }]);
      const defaults = await query<{ role: string }>(
        'SELECT DISTINCT pg_get_userbyid(defaclrole) AS role FROM pg_default_acl',
        [],
        fresh.name,
      );
      expect(defaults).toEqual([{ role: 'rp_owner' }]);
    } finally {
      await restored.close();
      await fresh.drop();
    }
  });

  it('changes nothing for a damaged backup, the wrong key or a database in use', async () => {
    const fresh = await createTestDatabase();
    const newData = mkdtempSync(join(tmpdir(), 'rp-restore-c-'));
    const base = {
      databaseUrl: fresh.url,
      adminUrl: testAdminUrl(),
      dataDir: newData,
      secrets: new FileSecretStore(join(newData, 'secrets'), {}),
      pgBin,
    };
    const damaged = join(newData, 'damaged.rpbk');
    const bytes = readFileSync(backupFile);
    bytes[bytes.length - 50] = bytes[bytes.length - 50]! ^ 1;
    writeFileSync(damaged, bytes);
    await expect(restoreBackup({ ...base, file: damaged, key: backupKey })).rejects.toBeInstanceOf(
      BackupFileError,
    );
    await expect(
      restoreBackup({ ...base, file: backupFile, key: Buffer.alloc(32, 1) }),
    ).rejects.toMatchObject({ code: 'WRONG_KEY' });
    expect(parseRecoveryKey('RPK1-ABCDE')).toBeUndefined();

    // The original PC's server is still running on its database.
    await expect(
      restoreBackup({ ...base, databaseUrl: original.url, file: backupFile, key: backupKey }),
    ).rejects.toBeInstanceOf(RestoreError);
    // Only this test's databases: other files restore in the same cluster at the same time.
    const restoring = [fresh.url, original.url].map(
      (url) => `${new URL(url).pathname.slice(1).slice(0, 63 - '_restoring'.length)}_restoring`,
    );
    const left = await query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1)',
      [restoring],
    );
    expect(left).toEqual([]);
    expect(existsSync(join(newData, 'photos'))).toBe(false);
    await fresh.drop();
  });
});

describe('[DATA-004] [AUTH-006] the Owner restores this PC from the System page', () => {
  it('needs the Owner with a fresh second factor, restarts, and restores before starting', async () => {
    const app = originalApp!;
    const prisma = app.get(PrismaService);
    const server = () => request(httpServer(app));
    const owner: LoginResponse = await signIn(app, kit, 'OWNER');
    const manager = await signIn(app, kit, 'MANAGER');
    const fileName = backupFile.split('/').at(-1)!;
    const body = { location: 'DATA_DRIVE', fileName, reason: 'Wrong menu prices imported' };

    const byManager = await server()
      .post('/api/v1/backups/restore')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send(body);
    expect(byManager.status).toBe(403);
    const stale = await server()
      .post('/api/v1/backups/restore')
      .set(authHeaders(kit.deviceId, owner.accessToken))
      .send(body);
    expect([stale.status, ApiError.parse(stale.body).code]).toEqual([
      403,
      'SECOND_FACTOR_REQUIRED',
    ]);
    await prisma.session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
    const missing = await server()
      .post('/api/v1/backups/restore')
      .set(authHeaders(kit.deviceId, owner.accessToken))
      .send({ ...body, fileName: 'rp-backup-20200101T000000Z-nightly.rpbk' });
    expect([missing.status, ApiError.parse(missing.body).code]).toEqual([404, 'BACKUP_NOT_FOUND']);

    // The recovery key, for the Owner to keep on paper.
    const shown = await server()
      .post('/api/v1/backups/recovery-key')
      .set(authHeaders(kit.deviceId, owner.accessToken));
    expect(shown.status).toBe(200);
    const { recoveryKey } = RecoveryKeyResponse.parse(shown.body);
    expect(parseRecoveryKey(recoveryKey)?.equals(backupKey)).toBe(true);

    // A change after the backup, which the restore undoes.
    const late = await addStaff(app, kit, 'CASHIER', '6666');
    const asked = await server()
      .post('/api/v1/backups/restore')
      .set(authHeaders(kit.deviceId, owner.accessToken))
      .send(body);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(RestoreBackupResponse.parse(asked.body).backupCreatedAt).toBeDefined();
    expect(app.get(ServerLifecycle).restartRequested).toBe(true);
    const audit = await prisma.auditLog.findMany({
      where: { action: { in: ['RESTORE_REQUESTED', 'BACKUP_RECOVERY_KEY_SHOWN'] } },
      orderBy: { chainSeq: 'asc' },
    });
    expect(audit.map((entry) => [entry.action, entry.actorId, entry.reason])).toEqual([
      ['BACKUP_RECOVERY_KEY_SHOWN', kit.staff.OWNER, null],
      ['RESTORE_REQUESTED', kit.staff.OWNER, 'Wrong menu prices imported'],
    ]);
    const pending = BackupsResponse.parse(
      (await server().get('/api/v1/backups').set(authHeaders(kit.deviceId, manager.accessToken)))
        .body,
    );
    expect(pending.restorePending).toBe(true);

    // The server stops; the restore runs before it starts again.
    await app.close();
    originalApp = undefined;
    const outcome = await runPendingRestore({
      dataDir: originalData,
      databaseUrl: original.url,
      adminUrl: testAdminUrl(),
      pgBin,
      secrets: new FileSecretStore(join(originalData, 'secrets'), {}),
    });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, error: null });
    // This PC held a restaurant: its database as it was is kept to go back to.
    expect(outcome?.previousDatabase).toMatch(/_before_/);
    leftovers.push(outcome!.previousDatabase!);
    // Only once.
    expect(
      await runPendingRestore({
        dataDir: originalData,
        databaseUrl: original.url,
        adminUrl: testAdminUrl(),
        pgBin,
        secrets: new FileSecretStore(join(originalData, 'secrets'), {}),
      }),
    ).toBeNull();

    originalApp = await createTestApp({
      databaseUrl: original.url,
      config: { dataDir: originalData, ...(pgBin !== undefined && { pgBin }) },
      overrides: options(() => new Date()),
    });
    const after = originalApp.get(PrismaService);
    expect(await after.staff.findUnique({ where: { id: late } })).toBeNull();
    const restoredAudit = await after.auditLog.findFirst({ where: { action: 'BACKUP_RESTORED' } });
    expect(restoredAudit).toMatchObject({ actorId: kit.staff.OWNER });
    const managerAgain = await signIn(originalApp, kit, 'MANAGER');
    const view = BackupsResponse.parse(
      (
        await request(httpServer(originalApp))
          .get('/api/v1/backups')
          .set(authHeaders(kit.deviceId, managerAgain.accessToken))
      ).body,
    );
    expect(view).toMatchObject({ restorePending: false, lastRestore: { ok: true } });
    expect((await readRestoreOutcome(originalData))?.ok).toBe(true);
  });
});
