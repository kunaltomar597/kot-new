import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  ArchivedDaysResponse,
  ArchivedInvoiceListResponse,
  ArchivedInvoiceResponse,
  ArchivesResponse,
  AuditVerifyResponse,
  BackupsResponse,
  type InvoiceView,
  type LoginResponse,
  RecoveryKeyResponse,
  StartBackupResponse,
} from '@rp/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import { backupKeyId } from '../../src/backups/backup-file.js';
import { runRestoreCli } from '../../src/backups/restore-cli.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ArchiveService } from '../../src/lifecycle/archive.service.js';
import { verifyBusinessArchive } from '../../src/lifecycle/business-archive.js';
import {
  authHeaders,
  type AuthKit,
  createAuthKit,
  renewDeviceToken,
  signIn,
} from '../helpers/auth-kit.js';
import {
  type SmallRestaurant,
  serveTable,
  setUpSmallRestaurant,
} from '../helpers/small-restaurant.js';
import { api, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase, testAdminUrl } from '../helpers/test-database.js';

/**
 * Phase 7 exit scenario S10 (P7-10, BRD §18.2): backup and restore to a new PC; archive-then-purge
 * with verification; the archive viewer.
 *
 * One restaurant's history, made through the API on the days it happened (the clock set back):
 * the last two days of FY 2023-24 and the first of FY 2024-25, then today's service. The Owner
 * archives the oldest year to the USB drive (read back in full before anything is deleted) and
 * purges it; the audit chain still verifies; the archive viewer opens the year. Tonight's backup
 * goes to the USB drive too, and the Owner keeps the recovery key on paper. Then the PC and its
 * data drive are lost. On a new PC the restore tool brings the backup back with the recovery key:
 * the staff sign in with their PINs on the same POS, today's bills and payments are there, the
 * purged year stays purged, the invoice numbers go on without a gap or a repeat, the audit chain
 * verifies, and the archive viewer still opens the year the old PC archived.
 */

const pgBin = process.env.RP_PG_BIN ?? process.env.PG_BIN;
const backupOptions = {
  provide: BACKUP_OPTIONS,
  useValue: { firstDelayMs: 0, checkEveryMs: 0, now: () => new Date() },
};

let original: TestDatabase;
let oldPc: INestApplication | undefined;
let newPc: INestApplication | undefined;
let fresh: TestDatabase | undefined;
let kit: AuthKit;
let restaurant: SmallRestaurant;
const oldData = mkdtempSync(join(tmpdir(), 'rp-s10-pc1-'));
const newData = mkdtempSync(join(tmpdir(), 'rp-s10-pc2-'));
/** The USB drive: the second backup location, where the archive goes too. */
const usbDrive = mkdtempSync(join(tmpdir(), 'rp-s10-usb-'));
const purger = `rp_purger_${randomBytes(4).toString('hex')}`;
/** Today's bill, made before the backup. */
let todays: InvoiceView;
/** Today's staff on the old PC (a POS allows a few PIN sign-ins a minute). */
let today: Shift;
let backupFile = '';
let recoveryKey = '';
let archiveId = '';
let oldKeyId = '';

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

/** Invoices on the PC, by financial year of their business date. */
async function invoicesByYear(database: string): Promise<Record<string, number>> {
  const rows = await admin<{ year: string; n: number }>(
    `SELECT CASE WHEN business_date < '2024-04-01' THEN '2023-24'
                 WHEN business_date < '2025-04-01' THEN '2024-25' ELSE 'today' END AS year,
            count(*)::int AS n
     FROM invoices GROUP BY 1 ORDER BY 1`,
    database,
  );
  return Object.fromEntries(rows.map((row) => [row.year, row.n]));
}

interface Shift {
  readonly owner: LoginResponse;
  readonly manager: LoginResponse;
  readonly waiter: LoginResponse;
  readonly cashier: LoginResponse;
}

/** The staff on duty at the PC's clock now (the POS renews its device token first). */
async function onDuty(app: INestApplication): Promise<Shift> {
  await renewDeviceToken(app, kit.deviceId);
  const owner = await signIn(app, kit, 'OWNER');
  // The Owner has just answered the second factor (AUTH-006), as the console asks first.
  await app.get(PrismaService).session.update({
    where: { id: owner.session.id },
    data: { secondFactorAt: new Date() },
  });
  return {
    owner,
    manager: await signIn(app, kit, 'MANAGER'),
    waiter: await signIn(app, kit, 'WAITER'),
    cashier: await signIn(app, kit, 'CASHIER'),
  };
}

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);

/** A day the restaurant worked, in India's time: the clock is set to it. */
function on(isoInstant: string): void {
  vi.setSystemTime(new Date(isoInstant));
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 29 March 2024: the PC is installed, the menu set up.
  on('2024-03-29T05:30:00.000Z');
  original = await createTestDatabase();
  // The installer's purge login: a member of rp_purge only (P0-16).
  await admin(`CREATE ROLE ${purger} LOGIN PASSWORD 'purge' IN ROLE rp_purge`);
  const purgeUrl = new URL(original.url);
  purgeUrl.username = purger;
  purgeUrl.password = 'purge';
  oldPc = await createTestApp({
    databaseUrl: original.url,
    config: {
      dataDir: oldData,
      purgeDatabaseUrl: purgeUrl.toString(),
      ...(pgBin !== undefined && { pgBin }),
    },
    overrides: [backupOptions],
  });
  kit = await createAuthKit(oldPc);
  const { manager } = await onDuty(oldPc);
  restaurant = await setUpSmallRestaurant(oldPc, kit, manager);
  const { Dal, Naan, Lassi } = restaurant.items;
  const { T1, T2, T3 } = restaurant.tables as Record<'T1' | 'T2' | 'T3', string>;

  // Lunch on 30 March and dinner on 31 March 2024: the last days of FY 2023-24.
  on('2024-03-30T07:00:00.000Z');
  let staff = await onDuty(oldPc);
  await serveTable(oldPc, kit, staff, T1, [
    [Dal, 2],
    [Naan, 4],
  ]);
  await serveTable(oldPc, kit, staff, T2, [[Lassi, 2]]);
  on('2024-03-31T14:30:00.000Z');
  staff = await onDuty(oldPc);
  await serveTable(oldPc, kit, staff, T1, [
    [Dal, 1],
    [Lassi, 1],
  ]);
  // Lunch on 1 April 2024: FY 2024-25 begins.
  on('2024-04-01T07:30:00.000Z');
  staff = await onDuty(oldPc);
  await serveTable(oldPc, kit, staff, T3, [[Dal, 3]]);

  // Today.
  vi.useRealTimers();
  today = await onDuty(oldPc);
  todays = await serveTable(oldPc, kit, today, T2, [
    [Naan, 2],
    [Dal, 1],
  ]);
  // The Owner sets the USB drive as the second backup location.
  const second = await api(oldPc)
    .put('/api/v1/settings/backups.secondLocation')
    .set(as(today.owner))
    .send({ value: usbDrive, reason: 'The USB drive in the drawer' });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await oldPc?.close();
  await newPc?.close();
  await fresh?.drop();
  await original.drop();
  await admin(`DROP ROLE IF EXISTS ${purger}`);
});

describe('[S10] [DATA-008] [AUD-004] archive-then-purge with verification', () => {
  it('archives the oldest year to the USB drive, reads it back in full, then purges it', async () => {
    const app = oldPc!;
    const { owner, manager } = today;
    expect(await invoicesByYear(original.name)).toEqual({ '2023-24': 3, '2024-25': 1, today: 1 });
    const offered = ArchivesResponse.parse(
      (await api(app).get('/api/v1/archives').set(as(owner))).body,
    );
    expect(offered.years[0]).toMatchObject({
      financialYear: '2023-24',
      invoices: 3,
      next: true,
      withinStatutoryPeriod: true,
    });

    const started = await api(app).post('/api/v1/archives').set(as(owner)).send({
      financialYear: '2023-24',
      folder: null,
      acknowledgeStatutory: true,
      reason: 'The old year is on the USB drive; the PC’s drive is filling up',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await app.get(ArchiveService).settled();
    const view = ArchivesResponse.parse(
      (await api(app).get('/api/v1/archives').set(as(owner))).body,
    );
    const run = view.runs[0];
    expect(run, JSON.stringify(run)).toMatchObject({
      financialYear: '2023-24',
      status: 'DONE',
      error: null,
    });
    archiveId = run!.id;
    expect(run?.counts).toMatchObject({ invoices: 3, payments: 3, orders: 3 });
    expect(run?.archiveFile?.startsWith(usbDrive)).toBe(true);

    // The verification: the archive on the drive opens with this PC's key and holds every row
    // the purge removed; the year is gone and the next one is whole.
    const key = await app.get<SecretStore>(SECRET_STORE).get('backup-key');
    oldKeyId = backupKeyId(key);
    const info = await verifyBusinessArchive(run?.archiveFile ?? '', key);
    expect(info).toMatchObject({ financialYear: '2023-24', counts: run?.counts });
    expect(await invoicesByYear(original.name)).toEqual({ '2024-25': 1, today: 1 });
    expect(view.years.map((year) => year.financialYear)).not.toContain('2023-24');

    // The audit trail: the purge is recorded, and the chain that is left still verifies.
    const purged = await app
      .get(PrismaService)
      .auditLog.findFirst({ where: { action: 'BUSINESS_RECORDS_PURGED' } });
    expect(purged).toMatchObject({ actorId: kit.staff.OWNER });
    const chain = AuditVerifyResponse.parse(
      (await api(app).get('/api/v1/audit/verify').set(as(manager))).body,
    );
    expect(chain, JSON.stringify(chain.firstBreak)).toMatchObject({ valid: true });
  }, 120_000);

  it('[DATA-009] opens the archived year in the archive viewer', async () => {
    const app = oldPc!;
    const { manager } = today;
    const days = ArchivedDaysResponse.parse(
      (await api(app).get(`/api/v1/archives/${archiveId}/days`).set(as(manager))).body,
    );
    expect(days.days.map((day) => [day.date, day.invoices])).toEqual([
      ['2024-03-30', 2],
      ['2024-03-31', 1],
    ]);
    const [first] = ArchivedInvoiceListResponse.parse(
      (
        await api(app)
          .get(`/api/v1/archives/${archiveId}/invoices?date=2024-03-31`)
          .set(as(manager))
      ).body,
    ).invoices;
    const opened = ArchivedInvoiceResponse.parse(
      (
        await api(app)
          .get(`/api/v1/archives/${archiveId}/invoices/${first?.id ?? ''}`)
          .set(as(manager))
      ).body,
    );
    expect(opened.invoice.invoiceNumber).toMatch(/^INV\/23-24\//);
    expect(opened.printed.join('\n')).toContain(opened.invoice.invoiceNumber);
    expect(opened.printed.join('\n')).toContain('TOTAL Rs');
  });
});

describe('[S10] [DATA-004] backup and restore to a new PC', () => {
  it('backs up to the USB drive; the Owner keeps the recovery key', async () => {
    const app = oldPc!;
    const { owner, manager } = today;
    const started = await api(app).post('/api/v1/backups').set(as(manager));
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const { run } = StartBackupResponse.parse(started.body);
    await app.get(BackupService).settled();
    const overview = BackupsResponse.parse(
      (await api(app).get('/api/v1/backups').set(as(manager))).body,
    );
    const done = overview.runs.find((entry) => entry.id === run.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED' });
    const usb = overview.locations.find((location) => location.location === 'SECOND');
    const copy = usb?.files.find((file) => file.name === done?.fileName);
    expect(copy, JSON.stringify(overview.locations)).toBeDefined();
    backupFile = join(usb?.path ?? '', copy?.name ?? '');
    expect(existsSync(backupFile)).toBe(true);

    const shown = await api(app).post('/api/v1/backups/recovery-key').set(as(owner));
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    recoveryKey = RecoveryKeyResponse.parse(shown.body).recoveryKey;
  }, 120_000);

  it('restores onto a new PC with the recovery key: the staff, today’s bills and the archive', async () => {
    // The PC and its data drive are lost; the USB drive and the paper are not.
    await oldPc?.close();
    oldPc = undefined;
    fresh = await createTestDatabase();
    const output: string[] = [];
    const code = await runRestoreCli(
      ['restore', backupFile],
      {
        NODE_ENV: 'test',
        DATABASE_URL: fresh.url,
        RP_DATA_DIR: newData,
        RP_ADMIN_DATABASE_URL: testAdminUrl(),
        ...(pgBin !== undefined && { RP_PG_BIN: pgBin }),
        RP_RECOVERY_KEY: recoveryKey,
      },
      { write: (text) => output.push(text) },
    );
    expect(code, output.join('')).toBe(0);

    newPc = await createTestApp({
      databaseUrl: fresh.url,
      config: { dataDir: newData, ...(pgBin !== undefined && { pgBin }) },
      overrides: [backupOptions],
    });
    const app = newPc;
    // The same POS and the same PINs.
    const staff = await onDuty(app);
    expect(staff.manager.staff.id).toBe(kit.staff.MANAGER);

    // Today's bill and its payment, FY 2024-25 as it was, FY 2023-24 still purged.
    expect(await invoicesByYear(fresh.name)).toEqual({ '2024-25': 1, today: 1 });
    const bill = await app.get(PrismaService).invoice.findUniqueOrThrow({
      where: { id: todays.id },
      include: { payments: true },
    });
    expect(bill).toMatchObject({ status: 'SETTLED', invoiceNumber: todays.invoiceNumber });
    expect(bill.payments.map((payment) => payment.amount)).toEqual([todays.grandTotal]);

    // [BILL-003] the numbers go on: the next bill takes the next number, none is used twice.
    const next = await serveTable(app, kit, staff, restaurant.tables.T4 ?? '', [
      [restaurant.items.Lassi, 1],
    ]);
    const numberOf = (invoice: string) => Number(invoice.split('/').at(-1));
    expect(next.invoiceNumber.replace(/\d+$/, '')).toBe(todays.invoiceNumber.replace(/\d+$/, ''));
    expect(numberOf(next.invoiceNumber)).toBe(numberOf(todays.invoiceNumber) + 1);

    // The audit trail came with it, and still verifies.
    const chain = AuditVerifyResponse.parse(
      (await api(app).get('/api/v1/audit/verify').set(as(staff.manager))).body,
    );
    expect(chain, JSON.stringify(chain.firstBreak)).toMatchObject({ valid: true });
    expect(
      await app.get(PrismaService).auditLog.count({ where: { action: 'BACKUP_RESTORED' } }),
    ).toBe(1);

    // The new PC backs up with a key of its own (decision 536) ...
    const overview = BackupsResponse.parse(
      (await api(app).get('/api/v1/backups').set(as(staff.manager))).body,
    );
    expect(overview.keyId).not.toBe(oldKeyId);
    // ... and still opens the year the old PC archived, from the USB drive (P7-10).
    const archives = ArchivesResponse.parse(
      (await api(app).get('/api/v1/archives').set(as(staff.owner))).body,
    );
    expect(archives.runs.map((run) => [run.id, run.status])).toEqual([[archiveId, 'DONE']]);
    const days = await api(app).get(`/api/v1/archives/${archiveId}/days`).set(as(staff.manager));
    expect(days.status, JSON.stringify(days.body)).toBe(200);
    expect(ArchivedDaysResponse.parse(days.body).totals.invoices).toBe(3);
    const found = ArchivedInvoiceListResponse.parse(
      (
        await api(app)
          .get(`/api/v1/archives/${archiveId}/invoices?date=2024-03-30`)
          .set(as(staff.manager))
      ).body,
    ).invoices;
    expect(found).toHaveLength(2);
  }, 180_000);
});
