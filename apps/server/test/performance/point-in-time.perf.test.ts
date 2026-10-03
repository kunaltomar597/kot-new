import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { type LocalPostgres, startLocalPostgres, withDatabase } from '@rp/test-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileSecretStore, SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import {
  CONTINUOUS_BACKUP_OPTIONS,
  ContinuousBackupService,
} from '../../src/backups/continuous-backup.service.js';
import { restorePointInTime } from '../../src/backups/point-in-time.js';
import { stagingFolder } from '../../src/backups/wal-archive.js';
import { createAuthKit } from '../helpers/auth-kit.js';
import { createTestApp } from '../helpers/test-app.js';
import { applyMigrations } from '../setup/postgres.js';
import { seedDesignCapacity } from './design-capacity.js';

/**
 * DATA-004: the continuous backup at design capacity (P7-05c): the base backup's time and size,
 * and a restore to the latest moment (unpack, replay, dump, restore), timed for the two-hour RTO.
 * Opt-in: `RP_PERF=1 RP_PERF_DAYS=30 pnpm exec vitest run --silent=false --project performance
 * test/performance/point-in-time.perf.test.ts`. The numbers go in docs/build/restore-timing.md.
 */

const ENABLED = process.env.RP_PERF === '1' && process.getuid?.() !== 0;
const DAYS = Number(process.env.RP_PERF_DAYS ?? 90);
const ORDERS_A_DAY = Number(process.env.RP_PERF_ORDERS ?? 2_000);
const STAGE_SCRIPT = fileURLToPath(new URL('../../src/backups/wal-stage.ts', import.meta.url));
const TWO_HOURS_MS = 2 * 60 * 60_000;

let cluster: LocalPostgres;
let app: INestApplication | undefined;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-pitr-perf-'));
let liveUrl: string;

async function sql<T extends pg.QueryResultRow>(text: string, database = 'rp_live'): Promise<T[]> {
  const client = new pg.Client({ connectionString: withDatabase(cluster.adminUrl, database) });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

describe.skipIf(!ENABLED)('[DATA-004] restore to a point in time at design capacity', () => {
  beforeAll(async () => {
    cluster = await startLocalPostgres({
      wal_level: 'replica',
      full_page_writes: 'on',
      max_wal_senders: '4',
      archive_mode: 'on',
      archive_command: `"${process.execPath}" --experimental-strip-types --no-warnings "${STAGE_SCRIPT}" "%p" "%f" "${stagingFolder(dataDir)}"`,
    });
    await sql(
      'CREATE ROLE rp_backup LOGIN REPLICATION; GRANT EXECUTE ON FUNCTION pg_switch_wal() TO rp_backup',
      'postgres',
    );
    await sql('CREATE DATABASE rp_live', 'postgres');
    liveUrl = withDatabase(cluster.adminUrl, 'rp_live');
    await applyMigrations(liveUrl);
    const now = () => new Date();
    app = await createTestApp({
      databaseUrl: liveUrl,
      config: {
        dataDir,
        pgBin: cluster.bin,
        backupDatabaseUrl: `postgresql://rp_backup@127.0.0.1:${String(cluster.port)}/postgres`,
      },
      overrides: [
        { provide: BACKUP_OPTIONS, useValue: { firstDelayMs: 0, checkEveryMs: 0, now } },
        {
          provide: CONTINUOUS_BACKUP_OPTIONS,
          useValue: { firstDelayMs: 0, shipEveryMs: 0, baseEveryMs: 0, now },
        },
      ],
    });
    const kit = await createAuthKit(app);
    await seedDesignCapacity(app, kit, {
      lastDay: '2027-03-31',
      days: DAYS,
      ordersPerDay: ORDERS_A_DAY,
    });
  }, 3_600_000);

  afterAll(async () => {
    await app?.close();
    await cluster.stop();
  });

  it('takes the base backup and restores to the latest moment within the RTO', async () => {
    const live = app!;
    const [size] = await sql<{ bytes: string }>(
      "SELECT pg_database_size('rp_live')::text AS bytes",
    );
    const backups = live.get(BackupService);
    await backups.start('MANUAL');
    await backups.settled();
    const continuous = live.get(ContinuousBackupService);
    let started = performance.now();
    const baseFile = await continuous.baseBackup();
    const baseMs = performance.now() - started;
    // A change after the base backup, for the replay to bring back.
    await sql("INSERT INTO system_meta (key, value, updated_at) VALUES ('perf.after', 'x', now())");
    await sql('SELECT pg_switch_wal()');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await continuous.ship();
    const key = await live.get<SecretStore>(SECRET_STORE).get('backup-key');
    await live.close();
    app = undefined;

    started = performance.now();
    const result = await restorePointInTime({
      to: null,
      roots: [join(dataDir, 'backups')],
      fullBackupFolders: [join(dataDir, 'backups', 'full')],
      key,
      databaseUrl: liveUrl,
      adminUrl: cluster.adminUrl,
      dataDir,
      secrets: new FileSecretStore(join(dataDir, 'secrets'), {}),
      pgBin: cluster.bin,
    });
    const restoreMs = performance.now() - started;
    const mb = (bytes: number) => bytes / 1024 ** 2;
    const databaseMB = mb(Number(size?.bytes ?? 0));
    const wal = readdirSync(join(dataDir, 'backups', 'wal'), { recursive: true }).length;
    const report = {
      days: DAYS,
      ordersPerDay: ORDERS_A_DAY,
      databaseMB: Math.round(databaseMB),
      baseBackupFileMB: Math.round(mb(statSync(baseFile).size)),
      baseBackupSeconds: Math.round(baseMs / 1000),
      archivedWalFiles: wal,
      pointInTimeRestoreSeconds: Math.round(restoreMs / 1000),
      hoursFor100GB: Number(((100 * 1024) / (databaseMB / (restoreMs / 1000)) / 3600).toFixed(2)),
    };
    // eslint-disable-next-line no-console -- the measurement goes in docs/build/restore-timing.md
    console.log('[DATA-004] point-in-time timing:', report);
    expect(result.restoredTo).not.toBeNull();
    expect(restoreMs).toBeLessThan(TWO_HOURS_MS);
  }, 3_600_000);
});
