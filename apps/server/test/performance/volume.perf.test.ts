import { createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ApiClient } from '@rp/api-client';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { CredentialHasher } from '../../src/auth/credential-hasher.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DEV_PINS, seedDevelopmentData } from '../../src/database/dev-seed.js';
import { createAuthKit } from '../helpers/auth-kit.js';
import { appUrl, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { runServiceDay } from '../scenario/service-day.js';
import { seedDesignRestaurant } from './design-capacity.js';
import { generateYear } from './generate-year.js';
import { type BulkTable, type FlowTable, projectVolume } from './volume-model.js';

/**
 * DATA-012: five years of a restaurant at design capacity (§7.2) fit in 100 GB, photos and
 * backups aside (P7-06d). Two measurements, then the projection in `volume-model.ts`:
 *
 * 1. a service day of about 100 orders through the real API: the rows each order writes in every
 *    table, and their size;
 * 2. RP_PERF_DAYS days (default 30) at 2,000 orders a day: what a row costs on disk with its
 *    indexes.
 *
 * Opt-in like the other runs: `RP_PERF=1 pnpm --filter @rp/server test:perf volume`. Its report
 * is what `docs/build/data-volume.md` records.
 */

const ENABLED = process.env.RP_PERF === '1';
const DAYS = Number(process.env.RP_PERF_DAYS ?? 30);
const ORDERS_A_DAY = 2_000;
/** The target, in the disk maker's gigabytes (the smaller kind). */
const TARGET_BYTES = 100 * 1_000_000_000;
/** What the daily retention (P7-06a) and the event bus keep to 90 days. */
const RETAINED = new Set([
  'alerts',
  'service_requests',
  'print_notices',
  'idempotency_records',
  'outbox',
  'inbox',
]);
const RETENTION_DAYS = 90;
/** PostgreSQL's write-ahead log at its default `max_wal_size`. */
const WAL_BYTES = 1_024 ** 3;
/** Dead rows and free space left by updates: orders, bills and sessions change many times. */
const ALLOWANCE = 1.3;
/**
 * Tables neither run writes, with generous figures: a QR order's inbox row keeps the whole order
 * as JSON (one order in four from QR, as in generate-year); diners' calls from QR; feedback and
 * diners' numbers (one bill in five); waiter-app approvals; cash paid in and out.
 */
const ASSUMED = [
  { table: 'relay_orders', rowsPerOrder: 0.25, bytesPerRow: 2_000 },
  { table: 'relay_service_requests', rowsPerOrder: 0.1, bytesPerRow: 600 },
  { table: 'feedback', rowsPerOrder: 0.2, bytesPerRow: 500 },
  { table: 'diner_contacts', rowsPerOrder: 0.2, bytesPerRow: 500 },
  { table: 'approvals', rowsPerOrder: 0.1, bytesPerRow: 600 },
  { table: 'cash_movements', rowsPerOrder: 0.01, bytesPerRow: 400 },
];

interface TableStats {
  readonly rows: number;
  readonly totalBytes: number;
  readonly heapBytes: number;
  readonly averageRowBytes: number;
}

async function query<T extends pg.QueryResultRow>(
  url: string,
  run: (client: pg.Client) => Promise<T[]>,
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Every table's exact row count, size with indexes, size without, and average row size. */
async function tableStats(url: string): Promise<Map<string, TableStats>> {
  const rows = await query(url, async (client) => {
    const tables = await client.query<{ name: string; total: string; heap: string }>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS total,
              pg_table_size(c.oid)::text AS heap
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const out: { name: string; stats: TableStats }[] = [];
    for (const table of tables.rows) {
      const counted = await client.query<{ rows: string; average: string | null }>(
        `SELECT count(*)::text AS rows, avg(pg_column_size(t.*))::text AS average
         FROM "${table.name}" t`,
      );
      out.push({
        name: table.name,
        stats: {
          rows: Number(counted.rows[0]?.rows ?? 0),
          totalBytes: Number(table.total),
          heapBytes: Number(table.heap),
          averageRowBytes: Number(counted.rows[0]?.average ?? 0),
        },
      });
    }
    return out;
  });
  return new Map(rows.map((row) => [row.name, row.stats]));
}

/** What each table gained between two measurements. */
function growth(
  before: ReadonlyMap<string, TableStats>,
  after: ReadonlyMap<string, TableStats>,
): { readonly table: string; readonly stats: TableStats }[] {
  return [...after].flatMap(([table, stats]) => {
    const was = before.get(table);
    const rows = stats.rows - (was?.rows ?? 0);
    return rows > 0
      ? [
          {
            table,
            stats: {
              rows,
              totalBytes: stats.totalBytes - (was?.totalBytes ?? 0),
              heapBytes: stats.heapBytes - (was?.heapBytes ?? 0),
              averageRowBytes: stats.averageRowBytes,
            },
          },
        ]
      : [];
  });
}

async function databaseBytes(url: string): Promise<number> {
  const [row] = await query(url, async (client) => {
    const result = await client.query<{ bytes: string }>(
      'SELECT pg_database_size(current_database())::text AS bytes',
    );
    return result.rows;
  });
  return Number(row?.bytes ?? 0);
}

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 2 : 0);

describe.skipIf(!ENABLED)('[DATA-012] five years at design capacity within 100 GB', () => {
  const databases: TestDatabase[] = [];
  const apps: INestApplication[] = [];
  let printer: Server | undefined;

  afterAll(async () => {
    for (const app of apps) await app.close();
    await new Promise((resolve) => {
      if (printer === undefined) resolve(undefined);
      else printer.close(resolve);
    });
    for (const database of databases) await database.drop();
  });

  it('projects the database from a real service day and days at design capacity', async () => {
    // 1. A service day through the real API (P1-14's scenario) on the demo restaurant.
    const flowDatabase = await createTestDatabase();
    databases.push(flowDatabase);
    const flowApp = await createTestApp({ databaseUrl: flowDatabase.url });
    apps.push(flowApp);
    const hasher = flowApp.get(CredentialHasher);
    await seedDevelopmentData(flowApp.get(PrismaService), { hashPin: (pin) => hasher.hash(pin) });
    printer = createServer((socket) => {
      socket.resume();
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => printer?.listen(0, '127.0.0.1', resolve));
    const address = printer.address();
    if (address === null || typeof address === 'string') throw new Error('No printer port');
    await flowApp
      .get(PrismaService)
      .printer.updateMany({ data: { host: '127.0.0.1', port: address.port } });
    const baseUrl = appUrl(flowApp);
    const flowBefore = await tableStats(flowDatabase.url);
    const day = await runServiceDay({
      baseUrl,
      pairingCodes: async (manager) =>
        manager === null
          ? (await new ApiClient({ baseUrl }).api.createBootstrapPairingCode()).code
          : (await manager.api.createPairingCode({ body: { type: 'POS', name: 'Counter 2' } }))
              .code,
      manager: { name: 'Vikram (Manager)', pin: DEV_PINS['Vikram (Manager)'] },
      cashier: { name: 'Neha (Cashier)', pin: DEV_PINS['Neha (Cashier)'] },
    });
    const flowTables: FlowTable[] = growth(flowBefore, await tableStats(flowDatabase.url)).map(
      ({ table, stats }) => ({ table, rows: stats.rows, averageRowBytes: stats.averageRowBytes }),
    );

    // 2. Days at design capacity: 2,000 orders a day on a 1,000-dish menu and 100 tables.
    const bulkDatabase = await createTestDatabase();
    databases.push(bulkDatabase);
    const bulkApp = await createTestApp({ databaseUrl: bulkDatabase.url });
    apps.push(bulkApp);
    const kit = await createAuthKit(bulkApp);
    const refs = await seedDesignRestaurant(bulkApp, kit);
    const fixedBytes = (await databaseBytes(bulkDatabase.url)) + WAL_BYTES;
    const bulkBefore = await tableStats(bulkDatabase.url);
    await generateYear(bulkApp.get(PrismaService), refs, {
      lastDay: '2027-03-31',
      days: DAYS,
      ordersPerDay: ORDERS_A_DAY,
    });
    const bulkDatabaseBytes = await databaseBytes(bulkDatabase.url);
    const bulkTables: BulkTable[] = growth(bulkBefore, await tableStats(bulkDatabase.url)).map(
      ({ table, stats }) => ({
        table,
        rows: stats.rows,
        totalBytes: stats.totalBytes,
        heapBytes: stats.heapBytes,
      }),
    );

    const projection = projectVolume({
      flow: { orders: day.counts.orders, tables: flowTables },
      bulk: { orders: DAYS * ORDERS_A_DAY, tables: bulkTables },
      assumed: ASSUMED,
      ordersPerDay: ORDERS_A_DAY,
      years: 5,
      retained: RETAINED,
      retentionDays: RETENTION_DAYS,
      fixedBytes,
      allowance: ALLOWANCE,
    });
    const lines = [
      `Service day: ${String(day.counts.orders)} orders; design capacity: ${String(DAYS)} days of ${String(ORDERS_A_DAY)} orders.`,
      `The design-capacity database after ${String(DAYS)} days: ${megabytes(bulkDatabaseBytes)} MB on disk.`,
      `Five years: ${String(projection.days)} days, ${String(projection.orders)} orders; index factor ${projection.indexFactor.toFixed(2)}.`,
      '',
      '| Table | Rows per order | Bytes per row | Basis | Five years (MB) |',
      '| --- | ---: | ---: | --- | ---: |',
      ...projection.tables.map(
        (entry) =>
          `| ${entry.table}${RETAINED.has(entry.table) ? ' (90 days)' : ''} | ${entry.rowsPerOrder.toFixed(2)} | ${entry.bytesPerRow.toFixed(0)} | ${entry.basis} | ${megabytes(entry.bytes)} |`,
      ),
      '',
      `Growing tables: ${megabytes(projection.growingBytes)} MB; with the ${String(ALLOWANCE)}× allowance and ${megabytes(fixedBytes)} MB fixed (schema, menu, WAL): ${megabytes(projection.totalBytes)} MB of ${megabytes(TARGET_BYTES)} MB.`,
    ];
    process.stdout.write(`\n${lines.join('\n')}\n`);
    expect(projection.tables.find((entry) => entry.table === 'invoices')?.basis).toBe('MEASURED');
    expect(projection.totalBytes).toBeLessThanOrEqual(TARGET_BYTES);
  }, 3_600_000);
});
