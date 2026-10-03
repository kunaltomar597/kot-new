import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ApiError, ArchivesResponse, ArchiveRunView, type LoginResponse } from '@rp/contracts';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { verifyBusinessArchive } from '../../src/lifecycle/business-archive.js';
import { ArchiveService } from '../../src/lifecycle/archive.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase, testAdminUrl } from '../helpers/test-database.js';
import { seedDesignCapacity } from '../performance/design-capacity.js';

/**
 * Archive-then-purge (P7-06b, DATA-008, AUD-004): the Owner archives FY 2023-24, the archive and
 * the human-readable export are written and read back, and the year is deleted through a real
 * purge login, leaving FY 2024-25 untouched; the purge record and the audit trail say so.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let owner: LoginResponse;
const folder = mkdtempSync(join(tmpdir(), 'rp-archive-'));
const purger = `rp_purger_${randomBytes(4).toString('hex')}`;

async function admin<T extends pg.QueryResultRow>(sql: string, database?: string): Promise<T[]> {
  const url = new URL(testAdminUrl());
  if (database !== undefined) url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

const api = () => request(httpServer(app));
const archives = async () =>
  ArchivesResponse.parse(
    (await api().get('/api/v1/archives').set(authHeaders(kit.deviceId, owner.accessToken))).body,
  );
const start = (body: object) =>
  api().post('/api/v1/archives').set(authHeaders(kit.deviceId, owner.accessToken)).send(body);

/** Rows of each table in a business-date range. */
async function countIn(from: string, to: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['orders', 'order_items', 'kots', 'invoices', 'payments', 'shifts']) {
    const [row] = await admin<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE business_date BETWEEN '${from}' AND '${to}'`,
      database.name,
    );
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

beforeAll(async () => {
  database = await createTestDatabase();
  // The installer's purge login: a member of rp_purge only (P0-16).
  await admin(`CREATE ROLE ${purger} LOGIN PASSWORD 'purge' IN ROLE rp_purge`);
  const purgeUrl = new URL(database.url);
  purgeUrl.username = purger;
  purgeUrl.password = 'purge';
  app = await createTestApp({
    databaseUrl: database.url,
    config: {
      dataDir: mkdtempSync(join(tmpdir(), 'rp-archive-data-')),
      purgeDatabaseUrl: purgeUrl.toString(),
    },
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  // 29 March to 2 April 2024: three days of FY 2023-24 and two of FY 2024-25.
  await seedDesignCapacity(app, kit, { lastDay: '2024-04-02', days: 5, ordersPerDay: 12 });
  // As on a real PC, the old years' audit entries come first in the chain: the kit's own entries
  // (written today) move after the generated ones.
  await admin(
    `BEGIN; SET LOCAL session_replication_role = replica;
     UPDATE audit_log SET chain_seq = chain_seq + 5000000 WHERE chain_seq < 1000000; COMMIT;`,
    database.name,
  );
  owner = await signIn(app, kit, 'OWNER');
  await prisma.session.update({
    where: { id: owner.session.id },
    data: { secondFactorAt: new Date() },
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await database.drop();
  await admin(`DROP ROLE IF EXISTS ${purger}`);
});

describe('[DATA-008] [AUD-004] archive-then-purge of a financial year', () => {
  it('offers whole years oldest first, with the statutory warning', async () => {
    const view = await archives();
    expect(view.years.map((year) => year.financialYear)).toEqual(['2023-24', '2024-25', '2025-26']);
    expect(view.years[0]).toMatchObject({
      next: true,
      withinStatutoryPeriod: true,
      statutoryUntil: '2030-12-31',
    });
    expect(view.years[0]?.invoices).toBeGreaterThan(0);
    const later = await start({
      financialYear: '2024-25',
      folder,
      acknowledgeStatutory: true,
      reason: 'Too soon',
    });
    expect([later.status, ApiError.parse(later.body).code]).toEqual([409, 'YEAR_NOT_OLDEST']);
    const unacknowledged = await start({
      financialYear: '2023-24',
      folder,
      acknowledgeStatutory: false,
      reason: 'Disk space',
    });
    expect([unacknowledged.status, ApiError.parse(unacknowledged.body).code]).toEqual([
      422,
      'STATUTORY_NOT_ACKNOWLEDGED',
    ]);
    // A manager may not.
    const manager = await signIn(app, kit, 'MANAGER');
    const refused = await api()
      .post('/api/v1/archives')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ financialYear: '2023-24', folder, acknowledgeStatutory: true, reason: 'x' });
    expect(refused.status).toBe(403);
  });

  it('archives, exports, reads back and purges the year, and keeps the next one', async () => {
    const before = await countIn('2024-03-29', '2024-03-31');
    const nextYear = await countIn('2024-04-01', '2024-04-02');
    expect(before.invoices).toBeGreaterThan(0);
    const [{ n: auditBefore } = { n: 0 }] = await admin<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log',
      database.name,
    );

    const started = await start({
      financialYear: '2023-24',
      folder,
      acknowledgeStatutory: true,
      reason: 'The drive is getting full',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(ArchiveRunView.parse(started.body).status).toBe('ARCHIVING');
    await app.get(ArchiveService).settled();

    const view = await archives();
    const run = view.runs[0];
    expect(run, JSON.stringify(run)).toMatchObject({
      financialYear: '2023-24',
      status: 'DONE',
      error: null,
      requestedBy: expect.any(String) as string,
    });
    expect(run?.counts?.invoices).toBe(before.invoices);
    expect(run?.counts?.payments).toBe(before.payments);

    // The year is gone; the next one is whole.
    expect(await countIn('2024-03-29', '2024-03-31')).toEqual({
      orders: 0,
      order_items: 0,
      kots: 0,
      invoices: 0,
      payments: 0,
      shifts: 0,
    });
    expect(await countIn('2024-04-01', '2024-04-02')).toEqual(nextYear);
    expect(view.years.map((year) => year.financialYear)).toEqual(['2024-25', '2025-26']);

    // The archive reads back with every row, with this PC's backup key.
    const yearFolder = join(folder, 'rp-archive-FY2023-24');
    const file = run?.archiveFile ?? '';
    expect(existsSync(file)).toBe(true);
    const info = await verifyBusinessArchive(
      file,
      await app.get<SecretStore>(SECRET_STORE).get('backup-key'),
    );
    expect(info).toMatchObject({ financialYear: '2023-24', counts: run?.counts });

    // The human-readable export: the invoice register and a PDF book a day.
    const register = readFileSync(join(yearFolder, 'invoice-register-FY2023-24.csv'), 'utf8');
    const lines = register.trim().split('\r\n');
    expect(lines[0]).toMatch(/^Invoice number,Invoice date,Status,/);
    expect(lines).toHaveLength((before.invoices ?? 0) + 1);
    expect(readdirSync(join(yearFolder, 'invoices', '2024-03'))).toEqual([
      '2024-03-29.pdf',
      '2024-03-30.pdf',
      '2024-03-31.pdf',
    ]);
    const pdf = readFileSync(join(yearFolder, 'invoices', '2024-03', '2024-03-29.pdf'), 'latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('TOTAL Rs');

    // The audit chain lost its start, up to the year's last entry, and gained the record.
    const [{ n: auditAfter } = { n: 0 }] = await admin<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log',
      database.name,
    );
    expect(auditAfter).toBeLessThan(auditBefore);
    expect(run?.counts?.audit_log).toBeGreaterThan(0);
    const record = await prisma.auditLog.findFirst({
      where: { action: 'BUSINESS_RECORDS_PURGED' },
    });
    expect(record).toMatchObject({ actorId: kit.staff.OWNER, reason: 'The drive is getting full' });
    expect(await prisma.auditLog.count({ where: { action: 'ARCHIVE_REQUESTED' } })).toBe(1);
  }, 120_000);

  it('never lets the application role delete what the purge may (AUD-004)', async () => {
    const [row] = await admin<{ app: boolean; purge: boolean }>(
      `SELECT has_table_privilege('rp_app', 'invoices', 'DELETE') AS app,
              has_table_privilege('rp_purge', 'invoices', 'DELETE') AS purge`,
      database.name,
    );
    expect(row).toEqual({ app: false, purge: true });
  });
});
