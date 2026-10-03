import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileSecretStore, SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import { restoreBackup } from '../../src/backups/restore.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { type AuthKit, createAuthKit } from '../helpers/auth-kit.js';
import { createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase, testAdminUrl } from '../helpers/test-database.js';
import { seedDesignCapacity } from './design-capacity.js';

/**
 * DATA-004: backup and restore at design capacity (P7-05b), timed, for the RTO of two hours.
 * Opt-in like the reports run: `RP_PERF=1 pnpm --filter @rp/server test:perf restore`
 * (RP_PERF_DAYS, default 90, and RP_PERF_ORDERS, default 2,000 a day). The rates it prints are
 * what `docs/build/restore-timing.md` extrapolates from.
 */

const ENABLED = process.env.RP_PERF === '1';
const DAYS = Number(process.env.RP_PERF_DAYS ?? 90);
const ORDERS_A_DAY = Number(process.env.RP_PERF_ORDERS ?? 2_000);
const pgBin = process.env.RP_PG_BIN ?? process.env.PG_BIN;
const TWO_HOURS_MS = 2 * 60 * 60_000;

let database: TestDatabase;
let app: INestApplication;
let kit: AuthKit;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-restore-perf-'));

async function databaseBytes(name: string): Promise<number> {
  const client = new pg.Client({ connectionString: testAdminUrl() });
  await client.connect();
  try {
    const result = await client.query<{ bytes: string }>(
      'SELECT pg_database_size($1)::text AS bytes',
      [name],
    );
    return Number(result.rows[0]?.bytes ?? 0);
  } finally {
    await client.end();
  }
}

describe.skipIf(!ENABLED)('[DATA-004] backup and restore at design capacity', () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    app = await createTestApp({
      databaseUrl: database.url,
      config: { dataDir, ...(pgBin !== undefined && { pgBin }) },
      overrides: [
        {
          provide: BACKUP_OPTIONS,
          useValue: { firstDelayMs: 0, checkEveryMs: 0, now: () => new Date() },
        },
      ],
    });
    kit = await createAuthKit(app);
    await seedDesignCapacity(app, kit, {
      lastDay: '2027-03-31',
      days: DAYS,
      ordersPerDay: ORDERS_A_DAY,
    });
  }, 3_600_000);

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it('restores within the two-hour RTO, and says how fast', async () => {
    const size = await databaseBytes(database.name);
    const backups = app.get(BackupService);
    let started = performance.now();
    const run = await backups.start('MANUAL');
    await backups.settled();
    const backupMs = performance.now() - started;
    const done = await app.get(PrismaService).backupRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(done.status, done.error ?? '').toBe('SUCCEEDED');
    const file = join(dataDir, 'backups', 'full', done.fileName!);
    const fileBytes = statSync(file).size;

    const target = await createTestDatabase();
    const newData = mkdtempSync(join(tmpdir(), 'rp-restore-perf-new-'));
    started = performance.now();
    await restoreBackup({
      file,
      key: await app.get<SecretStore>(SECRET_STORE).get('backup-key'),
      databaseUrl: target.url,
      adminUrl: testAdminUrl(),
      dataDir: newData,
      secrets: new FileSecretStore(join(newData, 'secrets'), {}),
      pgBin,
    });
    const restoreMs = performance.now() - started;
    const mb = (bytes: number) => bytes / 1024 ** 2;
    const report = {
      days: DAYS,
      ordersPerDay: ORDERS_A_DAY,
      databaseMB: Math.round(mb(size)),
      backupFileMB: Math.round(mb(fileBytes)),
      backupSeconds: Math.round(backupMs / 1000),
      restoreSeconds: Math.round(restoreMs / 1000),
      restoreMBperSecond: Number((mb(size) / (restoreMs / 1000)).toFixed(1)),
      // The 5-year sizing target (100 GB, NFR) restored at the same rate.
      hoursFor100GB: Number(((100 * 1024) / (mb(size) / (restoreMs / 1000)) / 3600).toFixed(2)),
    };
    // eslint-disable-next-line no-console -- the measurement goes in docs/build/restore-timing.md
    console.log('[DATA-004] restore timing:', report);
    expect(restoreMs).toBeLessThan(TWO_HOURS_MS);
    await target.drop();
  }, 3_600_000);
});
