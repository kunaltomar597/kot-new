import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { ApiError, BackupsResponse, RestoreBackupResponse } from '@rp/contracts';
import { type LocalPostgres, startLocalPostgres, withDatabase } from '@rp/test-postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileSecretStore, SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import { verifyBaseBackup } from '../../src/backups/base-backup.js';
import {
  CONTINUOUS_BACKUP_OPTIONS,
  ContinuousBackupService,
} from '../../src/backups/continuous-backup.service.js';
import { runPendingRestore } from '../../src/backups/pending-restore.js';
import { restorePointInTime } from '../../src/backups/point-in-time.js';
import { stagingFolder } from '../../src/backups/wal-archive.js';
import { ServerLifecycle } from '../../src/common/server-lifecycle.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { applyMigrations } from '../setup/postgres.js';

/**
 * The continuous backup (P7-05c, DATA-002, DATA-004, DATA-005) on a PostgreSQL cluster of its own
 * with WAL archiving on and `wal-stage` as its archive_command, as the installer sets it up
 * (P0-16): the log archived and copied, base backups, then losing the database and restoring it to
 * a moment and to the end of the archive, with the RPO measured.
 *
 * As root (cloud containers) PostgreSQL runs as another user that cannot run the stage script
 * from here, so the test is skipped there; CI and developers' PCs run it.
 */

const STAGE_SCRIPT = fileURLToPath(new URL('../../src/backups/wal-stage.ts', import.meta.url));
const asRoot = process.getuid?.() === 0;

let cluster: LocalPostgres;
let app: INestApplication | undefined;
let kit: AuthKit;
let dataDir: string;
let second: string;
let liveUrl: string;
let backupUrl: string;
let key: Buffer;
const now = () => new Date();

async function sql<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  database = 'rp_live',
): Promise<T[]> {
  const client = new pg.Client({ connectionString: withDatabase(cluster.adminUrl, database) });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** A change to look for after a restore. */
async function mark(name: string): Promise<void> {
  await sql("INSERT INTO system_meta (key, value, updated_at) VALUES ($1, 'x', now())", [
    `test.${name}`,
  ]);
}

async function marks(): Promise<string[]> {
  const rows = await sql<{ key: string }>(
    "SELECT key FROM system_meta WHERE key LIKE 'test.%' ORDER BY key",
  );
  return rows.map((row) => row.key.slice(5));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Closes the log, waits for PostgreSQL to hand it to wal-stage, then archives what is staged. */
async function archiveNow(target: INestApplication): Promise<void> {
  const [closed] = await sql<{ segment: string }>(
    'SELECT pg_walfile_name(pg_switch_wal() - 1) AS segment',
  );
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [archiver] = await sql<{ last: string | null; failed: string | null }>(
      'SELECT last_archived_wal AS last, last_failed_wal AS failed FROM pg_stat_archiver',
    );
    const last = archiver?.last ?? null;
    if (last !== null && last >= (closed?.segment ?? '')) break;
    if (Date.now() > deadline) {
      throw new Error(
        `PostgreSQL did not archive ${closed?.segment ?? '?'}: ${JSON.stringify(archiver)}`,
      );
    }
    await sleep(100);
  }
  await target.get(ContinuousBackupService).shipRound();
}

function startApp(): Promise<INestApplication> {
  return createTestApp({
    databaseUrl: liveUrl,
    config: { dataDir, pgBin: cluster.bin, backupDatabaseUrl: backupUrl },
    overrides: [
      { provide: BACKUP_OPTIONS, useValue: { firstDelayMs: 0, checkEveryMs: 0, now } },
      {
        provide: CONTINUOUS_BACKUP_OPTIONS,
        useValue: { firstDelayMs: 0, shipEveryMs: 0, baseEveryMs: 0, now },
      },
    ],
  });
}

async function overview(target: INestApplication): Promise<BackupsResponse> {
  const manager = await signIn(target, kit, 'MANAGER');
  const response = await request(httpServer(target))
    .get('/api/v1/backups')
    .set(authHeaders(kit.deviceId, manager.accessToken));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return BackupsResponse.parse(response.body);
}

beforeAll(async () => {
  if (asRoot) return;
  dataDir = mkdtempSync(join(tmpdir(), 'rp-continuous-'));
  second = mkdtempSync(join(tmpdir(), 'rp-continuous-usb-'));
  cluster = await startLocalPostgres({
    wal_level: 'replica',
    full_page_writes: 'on',
    max_wal_senders: '4',
    archive_mode: 'on',
    archive_command: `"${process.execPath}" --experimental-strip-types --no-warnings "${STAGE_SCRIPT}" "%p" "%f" "${stagingFolder(dataDir)}"`,
  });
  // What the installer does (P0-16): the backup role, and the restaurant's database.
  await sql(
    'CREATE ROLE rp_backup LOGIN REPLICATION; GRANT EXECUTE ON FUNCTION pg_switch_wal() TO rp_backup',
    [],
    'postgres',
  );
  await sql('CREATE DATABASE rp_live', [], 'postgres');
  liveUrl = withDatabase(cluster.adminUrl, 'rp_live');
  backupUrl = `postgresql://rp_backup@127.0.0.1:${String(cluster.port)}/postgres`;
  await applyMigrations(liveUrl);
  app = await startApp();
  kit = await createAuthKit(app);
  key = await app.get<SecretStore>(SECRET_STORE).get('backup-key');
}, 60_000);

afterAll(async () => {
  await app?.close();
  if (!asRoot) await cluster.stop();
});

describe.skipIf(asRoot)('[DATA-002] [DATA-005] the continuous backup', () => {
  it('archives the log, takes a checked base backup and copies both to the second location', async () => {
    const live = app!;
    const continuous = live.get(ContinuousBackupService);
    expect(await continuous.isSetUp()).toBe(true);
    // Set up, but nothing to restore from yet.
    expect((await overview(live)).continuous).toMatchObject({
      state: 'BEHIND',
      mode: 'CONTINUOUS',
      restorableFrom: null,
    });

    // The nightly backup brings the photos and keys a restore to a moment needs.
    const backups = live.get(BackupService);
    await backups.start('MANUAL');
    await backups.settled();
    await live.get(PrismaService).setting.create({
      data: { restaurantId: kit.restaurantId, key: 'backups.secondLocation', value: second },
    });
    live.get(SettingsService).invalidate();

    await continuous.baseRound();
    await mark('a');
    await archiveNow(live);

    const view = (await overview(live)).continuous;
    expect(view).toMatchObject({ state: 'OK', waiting: 0, secondLocationBehind: 0, error: null });
    expect(view.lastArchivedAt).not.toBeNull();
    expect(view.restorableFrom).not.toBeNull();
    // Both places hold the base backup and the log, encrypted; the staging folder is empty.
    const systemId = readdirSync(join(dataDir, 'backups', 'base'))[0]!;
    for (const root of [join(dataDir, 'backups'), join(second, 'rp-backups')]) {
      const [base] = readdirSync(join(root, 'base', systemId));
      expect(base).toMatch(/^rp-base-\d{8}T\d{6}Z-[0-9A-F]{24}\.rpbase$/);
      expect(await verifyBaseBackup(join(root, 'base', systemId, base!), key)).toBeGreaterThan(10);
      expect(readdirSync(join(root, 'wal', systemId)).length).toBeGreaterThan(0);
    }
    expect(readdirSync(join(stagingFolder(dataDir), systemId))).toEqual([]);
  });

  it('alerts while the log cannot be archived, and stops when it can', async () => {
    const live = app!;
    const continuous = live.get(ContinuousBackupService);
    const systemId = readdirSync(join(dataDir, 'backups', 'base'))[0]!;
    const archived = readdirSync(join(dataDir, 'backups', 'wal', systemId))[0]!.replace(
      '.rpwal',
      '',
    );
    // Something else under a name already archived: refused, never overwritten.
    const bad = join(stagingFolder(dataDir), systemId, archived);
    mkdirSync(join(stagingFolder(dataDir), systemId), { recursive: true });
    writeFileSync(bad, 'not that WAL file');
    await continuous.shipRound();
    expect((await overview(live)).continuous).toMatchObject({ state: 'FAILING', waiting: 1 });
    const alerts = () =>
      live.get(PrismaService).alert.count({
        where: { restaurantId: kit.restaurantId, dedupeKey: 'continuous-backup', status: 'OPEN' },
      });
    expect(await alerts()).toBe(1);

    const { rmSync } = await import('node:fs');
    rmSync(bad);
    await continuous.shipRound();
    expect((await overview(live)).continuous.state).toBe('OK');
    expect(await alerts()).toBe(0);
  });
});

describe.skipIf(asRoot)('[DATA-004] restore to a point in time', () => {
  it('brings back everything archived when the PC is lost, with the RPO measured', async () => {
    let live = app!;
    await sleep(1_100);
    const moment = new Date();
    await sleep(1_100);
    await mark('b');
    await archiveNow(live);
    await mark('c');
    const lastArchivedChange = new Date();
    await archiveNow(live);
    // Not archived yet when the PC is lost: this is what a restore can lose.
    await mark('d');
    const lostAt = new Date();
    await live.close();
    app = undefined;

    const secrets = new FileSecretStore(join(dataDir, 'secrets'), {});
    const restoreTo = (to: Date | null) =>
      restorePointInTime({
        to,
        roots: [join(dataDir, 'backups'), join(second, 'rp-backups')],
        fullBackupFolders: [join(dataDir, 'backups', 'full'), join(second, 'rp-backups')],
        key,
        databaseUrl: liveUrl,
        adminUrl: cluster.adminUrl,
        dataDir,
        secrets,
        pgBin: cluster.bin,
      });

    // Asked for the moment of the loss: the archive ends before it, so all of it comes back.
    const started = Date.now();
    const latest = await restoreTo(lostAt);
    const rtoMs = Date.now() - started;
    expect(latest.reachedTarget).toBe(false);
    expect(await marks()).toEqual(['a', 'b', 'c']);
    expect(latest.restoredTo!.getTime()).toBeGreaterThanOrEqual(
      lastArchivedChange.getTime() - 2_000,
    );
    const rpoMs = lostAt.getTime() - latest.restoredTo!.getTime();
    // eslint-disable-next-line no-console -- the measurement the WP asks for (docs/build/restore-timing.md)
    console.log(
      `[DATA-004] point-in-time restore: RTO ${String(rtoMs)} ms, RPO ${String(rpoMs)} ms`,
    );
    expect(latest.previousDatabase).not.toBeNull();

    // The Owner goes back to a moment from the System page.
    live = await startApp();
    app = live;
    const owner = await signIn(live, kit, 'OWNER');
    await live.get(PrismaService).session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
    const ask = (body: object) =>
      request(httpServer(live))
        .post('/api/v1/backups/restore')
        .set(authHeaders(kit.deviceId, owner.accessToken))
        .send(body);
    const tooEarly = await ask({ pointInTime: { to: '2020-01-01T00:00:00Z' }, reason: 'Undo' });
    expect([tooEarly.status, ApiError.parse(tooEarly.body).code]).toEqual([422, 'NO_BASE_BACKUP']);
    const future = await ask({
      pointInTime: { to: new Date(Date.now() + 3_600_000).toISOString() },
      reason: 'Undo',
    });
    expect([future.status, ApiError.parse(future.body).code]).toEqual([
      422,
      'POINT_IN_TIME_FUTURE',
    ]);
    const asked = await ask({
      pointInTime: { to: moment.toISOString() },
      reason: 'Undo the mistaken changes',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(RestoreBackupResponse.parse(asked.body).pointInTime).toBe(moment.toISOString());
    expect(live.get(ServerLifecycle).restartRequested).toBe(true);
    expect((await overview(live)).restorePending).toBe(true);
    await live.close();
    app = undefined;

    // The service runs it before the server starts again.
    const outcome = await runPendingRestore({
      dataDir,
      databaseUrl: liveUrl,
      adminUrl: cluster.adminUrl,
      pgBin: cluster.bin,
      secrets,
    });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    expect(new Date(outcome!.restoredTo!).getTime()).toBeLessThanOrEqual(moment.getTime());
    expect(await marks()).toEqual(['a']);

    live = await startApp();
    app = live;
    const view = await overview(live);
    expect(view.restorePending).toBe(false);
    expect(view.lastRestore).toMatchObject({ ok: true, restoredTo: outcome!.restoredTo });
    // AUD-001: the restore is audited once the server starts, naming who asked.
    const audit = await live.get(PrismaService).auditLog.findFirst({
      where: { action: 'BACKUP_RESTORED' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit).toMatchObject({ actorId: kit.staff.OWNER });
  }, 120_000);
});
