import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { ArchiveRunView, ArchivesResponse, StartArchiveRequest } from '@rp/contracts';
import {
  calendarDateOf,
  type FinancialYear,
  financialYearOfLabel,
  purgeableYears,
  statutoryRetentionEnd,
  withinStatutoryPeriod,
} from '@rp/domain';
import pg from 'pg';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { type ArchiveEntry, writeArchive } from '../backups/backup-archive.js';
import { withManifest } from '../backups/backup-contents.js';
import { encryptBackup } from '../backups/backup-file.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { ArchiveRun } from '../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  ARCHIVE_INFO,
  type ArchiveInfo,
  TABLES_PREFIX,
  verifyBusinessArchive,
} from './business-archive.js';
import { writeInvoiceBooks, writeInvoiceRegister } from './invoice-books.js';
import { paramsFor, YEAR_TABLES, type YearTable } from './year-records.js';

/** Rows read per query while archiving. */
const BATCH = 2_000;
const ACTIVE = ['ARCHIVING', 'VERIFYING', 'PURGING'] as const;

const errors = {
  notSetUp: () =>
    new AppError(
      422,
      'ARCHIVE_NOT_SET_UP',
      'This PC has no purge login yet, so no year can be purged. The installer sets it up.',
    ),
  running: () =>
    new AppError(409, 'ARCHIVE_RUNNING', 'An archive is being made already. Wait for it.'),
  notPurgeable: () =>
    new AppError(
      422,
      'YEAR_NOT_PURGEABLE',
      'That year cannot be archived: it has not ended, or holds no records.',
    ),
  notOldest: (oldest: string) =>
    new AppError(
      409,
      'YEAR_NOT_OLDEST',
      `Years are archived oldest first: archive ${oldest} before this one.`,
      { oldest },
    ),
  statutory: (until: string) =>
    new AppError(
      422,
      'STATUTORY_NOT_ACKNOWLEDGED',
      `GST law asks for this year's records until ${until}. Confirm that the restaurant keeps the archive until then.`,
      { until },
    ),
  noFolder: () =>
    new AppError(
      422,
      'NO_ARCHIVE_FOLDER',
      'Choose a folder for the archive, or set a second backup location.',
    ),
};

function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 480);
}

function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function viewOf(run: ArchiveRun): ArchiveRunView {
  return {
    id: run.id,
    financialYear: run.financialYear,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    requestedBy: null,
    folder: run.folder,
    archiveFile: run.archiveFile,
    sizeBytes: run.sizeBytes === null ? null : Number(run.sizeBytes),
    sha256: run.sha256,
    counts: (run.counts as Record<string, number> | null) ?? null,
    error: run.error,
  };
}

/**
 * Archive-then-purge (DATA-008, AUD-004, P7-06b), for the Owner with a fresh second factor:
 *
 * 1. only the oldest whole financial year still in the database, so what stays is always one
 *    stretch of time and the audit chain keeps its tail;
 * 2. an encrypted, checksummed archive of every business record of the year (the backup file
 *    format, kind ARCHIVE), and a human-readable export: the invoice register as CSV and the
 *    invoices as PDF books, a file a day. In a folder of the Owner's choice, the second backup
 *    location by default; queued for the cloud backup set;
 * 3. the archive read back in full;
 * 4. the year deleted through the purge login (`RP_PURGE_DATABASE_URL`, a member of `rp_purge`),
 *    each table losing exactly the rows archived or nothing at all, and the purge record written
 *    in the same transaction. Audited.
 *
 * While the year is within the 72 months GST law asks records to be kept (§12), the Owner must
 * confirm the restaurant keeps the archive until then.
 */
@Injectable()
export class ArchiveService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ArchiveService.name);
  private current: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** An archive cut off by a crash failed; the purge's own transaction never half-happened. */
  async onApplicationBootstrap(): Promise<void> {
    await this.prisma.archiveRun
      .updateMany({
        where: { status: { in: [...ACTIVE] } },
        data: { status: 'FAILED', finishedAt: new Date(), error: 'The server stopped.' },
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Interrupted archives could not be marked');
      });
  }

  /** Waits for the archive in progress (tests, shutdown). */
  async settled(): Promise<void> {
    await this.current?.catch(() => undefined);
  }

  /** The Owner's archive page: the years that may go, and every run (the purge records). */
  async overview(restaurantId: string, now = new Date()): Promise<ArchivesResponse> {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { timeZone: true },
    });
    const today = calendarDateOf(now, restaurant.timeZone);
    const [oldest, runs] = await Promise.all([
      this.prisma.$queryRaw<{ date: string | null }[]>`
        SELECT LEAST(
          (SELECT MIN(business_date) FROM orders), (SELECT MIN(business_date) FROM invoices),
          (SELECT MIN(business_date) FROM business_days)
        )::text AS date`,
      this.prisma.archiveRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
    ]);
    const years = purgeableYears({ oldestRecordDate: oldest[0]?.date ?? null, today });
    const listed: ArchivesResponse['years'] = [];
    for (const [index, year] of years.entries()) {
      listed.push({
        financialYear: year.label,
        startDate: year.startDate,
        endDate: year.endDate,
        invoices: await this.prisma.invoice.count({
          where: { businessDate: { gte: new Date(year.startDate), lte: new Date(year.endDate) } },
        }),
        withinStatutoryPeriod: withinStatutoryPeriod(year, today),
        statutoryUntil: statutoryRetentionEnd(year),
        next: index === 0,
      });
    }
    const names = await this.namesOf(runs);
    return {
      years: listed,
      runs: runs.map((run) => ({
        ...viewOf(run),
        requestedBy: run.requestedById === null ? null : (names.get(run.requestedById) ?? null),
      })),
      running: runs.some((run) => (ACTIVE as readonly string[]).includes(run.status)),
    };
  }

  /** Starts archive-then-purge of one year; it runs in the background. Audited. */
  async start(principal: Principal, request: StartArchiveRequest): Promise<ArchiveRunView> {
    if (this.config.purgeDatabaseUrl === undefined) throw errors.notSetUp();
    const overview = await this.overview(principal.restaurantId);
    if (overview.running) throw errors.running();
    const year = overview.years.find((entry) => entry.financialYear === request.financialYear);
    if (year === undefined) throw errors.notPurgeable();
    if (!year.next) throw errors.notOldest(overview.years[0]?.financialYear ?? '');
    if (year.withinStatutoryPeriod && !request.acknowledgeStatutory) {
      throw errors.statutory(year.statutoryUntil);
    }
    const settings = await this.settings.snapshot(principal.restaurantId);
    const second = settings.get('backups.secondLocation');
    const base = request.folder ?? (second === null ? null : join(second, 'rp-archives'));
    if (base === null) throw errors.noFolder();
    const folder = join(base, `rp-archive-FY${request.financialYear}`);
    const run = await this.prisma.transaction(async (tx) => {
      const created = await tx.archiveRun.create({
        data: {
          financialYear: request.financialYear,
          status: 'ARCHIVING',
          startedAt: new Date(),
          requestedById: principal.staffId,
          reason: request.reason,
          folder,
          cloudStatus: settings.get('backups.cloudEnabled') ? 'PENDING' : null,
        },
      });
      await this.audit.record(tx, {
        action: 'ARCHIVE_REQUESTED',
        entityType: 'archive_run',
        entityId: created.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: {
          financialYear: request.financialYear,
          folder,
          withinStatutoryPeriod: year.withinStatutoryPeriod,
          statutoryUntil: year.statutoryUntil,
        },
        reason: request.reason,
      });
      return created;
    });
    const work = this.make(run, financialYearOfLabel(request.financialYear), principal);
    this.current = work;
    return { ...viewOf(run), requestedBy: null };
  }

  /** Archives, exports, reads back and purges; records the outcome. Never throws. */
  private async make(run: ArchiveRun, year: FinancialYear, principal: Principal): Promise<void> {
    const folder = run.folder ?? '';
    try {
      await mkdir(folder, { recursive: true });
      const plan = await this.plan(year);
      const file = join(folder, `rp-archive-FY${year.label}-${stampOf(run.startedAt)}.rpar`);
      const key = await this.secrets.get('backup-key');
      const { sizeBytes, sha256 } = await this.writeArchive(file, key, year, run, plan);
      await this.writeExport(folder, year);
      await this.prisma.archiveRun.update({
        where: { id: run.id },
        data: { status: 'VERIFYING', archiveFile: file, sizeBytes: BigInt(sizeBytes), sha256 },
      });
      // DATA-008 step 3: nothing is deleted until the archive reads back whole.
      const info = await verifyBusinessArchive(file, key);
      if (JSON.stringify(info.counts) !== JSON.stringify(plan.counts)) {
        throw new Error('The archive does not hold what was counted.');
      }
      await this.prisma.archiveRun.update({
        where: { id: run.id },
        data: { status: 'PURGING', counts: plan.counts },
      });
      await this.purge(run, year, plan);
      await this.prisma.transaction((tx) =>
        this.audit.record(tx, {
          action: 'BUSINESS_RECORDS_PURGED',
          entityType: 'archive_run',
          entityId: run.id,
          actorId: principal.staffId,
          deviceId: principal.deviceId,
          restaurantId: principal.restaurantId,
          after: {
            financialYear: year.label,
            archiveFile: file,
            sha256,
            counts: plan.counts,
            auditChainTo: plan.auditTo,
          },
          reason: run.reason,
        }),
      );
      this.logger.log({ financialYear: year.label }, 'The year is archived and purged');
    } catch (error) {
      this.logger.error({ err: error, financialYear: year.label }, 'Archive-then-purge failed');
      await this.prisma.archiveRun
        .update({
          where: { id: run.id },
          data: { status: 'FAILED', finishedAt: new Date(), error: plainError(error) },
        })
        .catch(() => undefined);
    }
  }

  /** What the year holds, counted once; the archive, its check and the purge all use it. */
  private async plan(year: FinancialYear) {
    const head = await this.prisma.$queryRaw<{ seq: bigint | null; hash: string | null }[]>`
      SELECT chain_seq AS seq, hash FROM audit_log
      WHERE chain_seq = (SELECT MAX(chain_seq) FROM audit_log
                         WHERE business_date <= ${year.endDate}::date)`;
    const auditTo = head[0]?.seq === undefined || head[0].seq === null ? null : Number(head[0].seq);
    const counts: Record<string, number> = {};
    for (const entry of YEAR_TABLES) {
      const rows = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.where}`,
        ...paramsFor(entry, year, auditTo),
      );
      counts[entry.table] = rows[0]?.n ?? 0;
    }
    return { counts, auditTo, auditHash: head[0]?.hash ?? null };
  }

  /** Every row of a table that belongs to the year, a batch at a time, as JSON lines. */
  private async *rows(entry: YearTable, year: FinancialYear, auditTo: number | null) {
    const key = entry.table === 'audit_log' ? 'chain_seq' : 'id';
    const params = paramsFor(entry, year, auditTo);
    const limit = `$${String(params.length + 1)}`;
    const from = `$${String(params.length + 2)}::${key === 'id' ? 'uuid' : 'bigint'}`;
    let after: string | null = null;
    for (;;) {
      const batch: { key: string; row: string }[] = await this.prisma.$queryRawUnsafe(
        `SELECT ${key}::text AS key, row_to_json(t)::text AS row FROM ${entry.table} t
         WHERE (${entry.where}) ${after === null ? '' : `AND ${key} > ${from}`}
         ORDER BY ${key} LIMIT ${limit}`,
        ...params,
        BATCH,
        ...(after === null ? [] : [after]),
      );
      if (batch.length === 0) return;
      yield `${batch.map((entry) => entry.row).join('\n')}\n`;
      if (batch.length < BATCH) return;
      after = batch.at(-1)?.key ?? null;
    }
  }

  private async writeArchive(
    file: string,
    key: Buffer,
    year: FinancialYear,
    run: ArchiveRun,
    plan: Awaited<ReturnType<ArchiveService['plan']>>,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const restaurants = await this.prisma.restaurant.findMany({
      select: { id: true, displayName: true },
    });
    const info: ArchiveInfo = {
      format: 1,
      financialYear: year.label,
      startDate: year.startDate,
      endDate: year.endDate,
      createdAt: run.startedAt.toISOString(),
      appVersion: SERVER_PACKAGE.version,
      schemaVersion: await this.schemaVersion(),
      restaurants: restaurants.map((restaurant) => ({
        id: restaurant.id,
        name: restaurant.displayName,
      })),
      counts: plan.counts,
      auditChain: { to: plan.auditTo, hash: plan.auditHash },
    };
    // Each table's rows are read as the archive is written (the generators are lazy).
    const entries: ArchiveEntry[] = [
      { name: ARCHIVE_INFO, content: [JSON.stringify(info)] },
      ...YEAR_TABLES.map((entry) => ({
        name: `${TABLES_PREFIX}${entry.table}.jsonl`,
        content: this.rows(entry, year, plan.auditTo),
      })),
    ];
    const partial = `${file}.partial`;
    const hash = createHash('sha256');
    let sizeBytes = 0;
    try {
      await pipeline(
        Readable.from(writeArchive(withManifest(entries))),
        encryptBackup(key, {
          kind: 'ARCHIVE',
          appVersion: SERVER_PACKAGE.version,
          now: run.startedAt,
        }),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            sizeBytes += chunk.length;
            callback(null, chunk);
          },
        }),
        createWriteStream(partial, { mode: 0o600 }),
      );
      const handle = await open(partial, 'r+');
      await handle.sync().finally(() => handle.close());
      await rename(partial, file);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return { sizeBytes, sha256: hash.digest('hex') };
  }

  /** The human-readable export (DATA-008 step 2): the invoice register and the PDF books. */
  private async writeExport(folder: string, year: FinancialYear): Promise<void> {
    await writeInvoiceRegister(
      this.prisma,
      join(folder, `invoice-register-FY${year.label}.csv`),
      year,
    );
    await writeInvoiceBooks(this.prisma, join(folder, 'invoices'), year);
  }

  /**
   * Deletes the year through the purge login, in one transaction: each table must lose exactly
   * the rows archived, and the purge record is written with them (DATA-008 step 4, AUD-004).
   */
  private async purge(
    run: ArchiveRun,
    year: FinancialYear,
    plan: Awaited<ReturnType<ArchiveService['plan']>>,
  ): Promise<void> {
    const client = new pg.Client({ connectionString: this.config.purgeDatabaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      for (const entry of YEAR_TABLES) {
        const result = await client.query(
          `DELETE FROM ${entry.table} WHERE ${entry.where}`,
          paramsFor(entry, year, plan.auditTo),
        );
        const archived = plan.counts[entry.table] ?? 0;
        if ((result.rowCount ?? 0) !== archived) {
          throw new Error(
            `${entry.table}: ${String(result.rowCount ?? 0)} rows to delete, but ${String(archived)} were archived.`,
          );
        }
      }
      await client.query(
        `UPDATE archive_runs SET status = 'DONE', finished_at = now(), counts = $2::jsonb,
           audit_chain_to = $3, audit_chain_hash = $4, updated_at = now()
         WHERE id = $1`,
        [run.id, JSON.stringify(plan.counts), plan.auditTo, plan.auditHash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  private async schemaVersion(): Promise<string | null> {
    const [table] = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`;
    if (table?.present !== true) return null;
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT migration_name AS name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1`;
    return rows[0]?.name ?? null;
  }

  private async namesOf(runs: readonly ArchiveRun[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(runs.flatMap((run) => (run.requestedById === null ? [] : [run.requestedById]))),
    ];
    const staff =
      ids.length === 0
        ? []
        : await this.prisma.staff.findMany({
            where: { id: { in: ids } },
            select: { id: true, displayName: true },
          });
    return new Map(staff.map((person) => [person.id, person.displayName]));
  }
}
