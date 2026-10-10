import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DataExportView } from '@rp/contracts';
import { csvCell, financialYearFromStart, financialYearOf } from '@rp/domain';
import pg from 'pg';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { SettingsService } from '../settings/settings.service.js';
import { writeInvoiceBooks, writeInvoiceRegister } from './invoice-books.js';

/** Tables never exported: credentials, sessions, one-time codes and the server's own plumbing. */
export const NOT_EXPORTED = new Set([
  '_prisma_migrations',
  'credentials',
  'sessions',
  'recovery_codes',
  'pairing_codes',
  'override_grants',
  'system_meta',
  'idempotency_records',
  'outbox',
  'inbox',
  'event_consumer_cursors',
]);

/** Columns never exported: secret hashes. */
const SECRET_COLUMN = /(_hash|secret)$/;

const BATCH = 5_000;

/**
 * A value as a CSV field: objects and arrays as JSON. Text a spreadsheet would run as a formula
 * (a note typed as "=HYPERLINK(...)") gets a leading apostrophe (`csvCell`, PC-T8); the JSON
 * lines keep it as typed.
 */
function csvField(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return csvCell(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return csvCell(JSON.stringify(value));
}

/**
 * The full data export (DATA-010, P7-06c): everything the restaurant's data is, in open formats,
 * whenever the Owner asks, including in restricted licence mode (it gates only ordering):
 *
 *   json/<table>.jsonl     every row, one JSON object per line
 *   csv/<table>.csv        the same, a CSV per table (nested values as JSON)
 *   invoice-register.csv   every invoice, amounts in rupees, taxes by code
 *   invoices/<FY>/<month>/<date>.pdf   every invoice as printed
 *   README.txt
 *
 * Secrets stay out: no credentials, sessions or codes, and no `*_hash` column.
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);
  private current: Promise<void> | undefined;
  private last: DataExportView | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The last export since the server started (a new start forgets it; the folder stays). */
  view(): DataExportView | null {
    return this.last;
  }

  async settled(): Promise<void> {
    await this.current?.catch(() => undefined);
  }

  /** Starts the export in the background. The Owner (DATA_ADMIN); audited. */
  async start(principal: Principal, folder: string | null): Promise<DataExportView> {
    if (this.last?.status === 'RUNNING') {
      throw new AppError(409, 'EXPORT_RUNNING', 'An export is being made already. Wait for it.');
    }
    const settings = await this.settings.snapshot(principal.restaurantId);
    const second = settings.get('backups.secondLocation');
    const base = folder ?? (second === null ? null : join(second, 'rp-exports'));
    if (base === null) {
      throw new AppError(
        422,
        'NO_EXPORT_FOLDER',
        'Choose a folder for the export, or set a second backup location.',
      );
    }
    // A relative folder would land wherever the service happens to run from.
    if (!isAbsolute(base)) {
      throw new AppError(
        422,
        'NO_EXPORT_FOLDER',
        'Give the whole path of the folder, starting with its drive (like D:\\Exports).',
      );
    }
    const startedAt = new Date();
    const target = join(
      base,
      `rp-export-${startedAt
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '')}`,
    );
    const running: DataExportView = {
      status: 'RUNNING',
      folder: target,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      tables: null,
      error: null,
    };
    this.last = running;
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        action: 'DATA_EXPORTED',
        entityType: 'restaurant',
        entityId: principal.restaurantId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { folder: target },
      }),
    );
    const work = this.write(target).then(
      (tables) => {
        this.last = {
          ...running,
          status: 'DONE',
          finishedAt: new Date().toISOString(),
          tables,
        };
      },
      (error: unknown) => {
        this.logger.error({ err: error }, 'The data export failed');
        this.last = {
          ...running,
          status: 'FAILED',
          finishedAt: new Date().toISOString(),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 480),
        };
      },
    );
    this.current = work;
    return this.last;
  }

  /**
   * Every table in one read-only transaction at REPEATABLE READ, so the files are one consistent
   * moment however long the export takes; each table through a cursor, a batch at a time.
   */
  private async write(folder: string): Promise<number> {
    await mkdir(join(folder, 'json'), { recursive: true });
    await mkdir(join(folder, 'csv'), { recursive: true });
    const client = new pg.Client({ connectionString: this.config.databaseUrl });
    await client.connect();
    let written = 0;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows: tables } = await client.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      for (const { name } of tables) {
        if (NOT_EXPORTED.has(name)) continue;
        await this.writeTable(client, folder, name);
        written += 1;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
    const [range] = await this.prisma.$queryRaw<{ first: string | null; last: string | null }[]>`
      SELECT MIN(business_date)::text AS first, MAX(business_date)::text AS last FROM invoices`;
    const first = range?.first ?? null;
    const last = range?.last ?? null;
    if (first !== null && last !== null) {
      await writeInvoiceRegister(this.prisma, join(folder, 'invoice-register.csv'), {
        startDate: first,
        endDate: last,
      });
      for (
        let year = financialYearOf(first).startYear;
        year <= financialYearOf(last).startYear;
        year += 1
      ) {
        const fy = financialYearFromStart(year);
        await writeInvoiceBooks(this.prisma, join(folder, 'invoices', `FY${fy.label}`), fy);
      }
    }
    await writeFile(join(folder, 'README.txt'), README);
    return written;
  }

  /** One table as JSON lines and as CSV, without its secret columns. */
  private async writeTable(client: pg.Client, folder: string, table: string): Promise<void> {
    const { rows: described } = await client.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    const columns = described.map((row) => row.name).filter((name) => !SECRET_COLUMN.test(name));
    const json = createWriteStream(join(folder, 'json', `${table}.jsonl`));
    const csv = createWriteStream(join(folder, 'csv', `${table}.csv`));
    const write = async (stream: WriteStream, text: string) => {
      if (!stream.write(text)) await once(stream, 'drain');
    };
    try {
      await write(csv, `${columns.map(csvField).join(',')}\r\n`);
      const quoted = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(', ');
      await client.query(`DECLARE export_rows NO SCROLL CURSOR FOR
        SELECT row_to_json(t)::text AS row FROM (SELECT ${quoted} FROM "${table}") t`);
      for (;;) {
        const { rows } = await client.query<{ row: string }>(
          `FETCH FORWARD ${String(BATCH)} FROM export_rows`,
        );
        if (rows.length === 0) break;
        let jsonText = '';
        let csvText = '';
        for (const { row } of rows) {
          jsonText += `${row}\n`;
          const values = JSON.parse(row) as Record<string, unknown>;
          csvText += `${columns.map((name) => csvField(values[name])).join(',')}\r\n`;
        }
        await write(json, jsonText);
        await write(csv, csvText);
      }
      await client.query('CLOSE export_rows');
    } finally {
      await Promise.all([
        new Promise<void>((done) => {
          json.end(() => {
            done();
          });
        }),
        new Promise<void>((done) => {
          csv.end(() => {
            done();
          });
        }),
      ]);
    }
  }
}

const README = `Restaurant data export (DATA-010)

json/<table>.jsonl  every row of each table, one JSON object per line
csv/<table>.csv     the same rows as CSV (values that are lists or objects are written as JSON;
                    text that a spreadsheet would run as a formula starts with an apostrophe)
invoice-register.csv  every invoice: number, date, status, customer, taxable value, taxes,
                    totals, in rupees
invoices/FY<year>/<month>/<date>.pdf  every invoice of the day as printed

Amounts in the tables are in paise (1/100 rupee). Times are UTC. Dates are the restaurant's
business dates. Passwords, PINs, keys, sessions and one-time codes are not included.
`;
