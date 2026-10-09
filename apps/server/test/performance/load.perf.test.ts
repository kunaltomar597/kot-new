import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { type LocalPostgres, startLocalPostgres, withDatabase } from '@rp/test-postgres';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { TlsService } from '../../src/tls/tls.service.js';
import { createTestApp } from '../helpers/test-app.js';
import { DESIGN_CAPACITY, type LoadShape } from '../load/plan.js';
import { SimulatedPrinter } from '../load/printer.js';
import { renderReport } from '../load/report.js';
import {
  loadRestaurant,
  readyForToday,
  saveRestaurant,
  setUpLoadRestaurant,
} from '../load/restaurant.js';
import { runRush } from '../load/rush.js';
import { type LoadTarget, startBuiltServer } from '../load/server.js';
import { applyMigrations, migrationFiles } from '../setup/postgres.js';

/**
 * P8-01a: the simulated rush at the BRD's design capacity (§7.2), the figures of every NFR-P
 * target it covers, and S1's "zero lost or duplicate orders/KOTs". The built server (run
 * `pnpm build` first) runs in a process of its own with TLS, on a PostgreSQL that is as durable
 * as the restaurant PC's (fsync, synchronous commit, full-page writes, WAL archiving). Opt-in, as
 * the other runs: `RP_PERF=1 pnpm --filter @rp/server test:perf load`, the rush's 25 minutes and
 * 10 to 60 for the year of history.
 *
 * - `RP_LOAD_MINUTES`, `RP_LOAD_ORDERS_PER_HOUR` and `RP_LOAD_HISTORY_DAYS` change the shape.
 * - `RP_LOAD_ADMIN_URL`: a PostgreSQL to use (its own settings, e.g. with `pg_stat_statements`)
 *   instead of a throwaway one.
 * - `RP_LOAD_BASE`: a folder that keeps the restaurant set up with its history (database
 *   `rp_load_base` with `RP_LOAD_ADMIN_URL`): the first run makes it, later runs copy it, so a run
 *   takes the rush's time only.
 * - The report goes to `RP_LOAD_REPORT` (default: the temporary folder); its figures are recorded
 *   in `docs/build/performance.md`.
 */

const ENABLED = process.env.RP_PERF === '1';

function numberFrom(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : Number(value);
}

const shape: LoadShape = {
  ...DESIGN_CAPACITY,
  minutes: numberFrom('RP_LOAD_MINUTES', DESIGN_CAPACITY.minutes),
  ordersPerHour: numberFrom('RP_LOAD_ORDERS_PER_HOUR', DESIGN_CAPACITY.ordersPerHour),
  historyDays: numberFrom('RP_LOAD_HISTORY_DAYS', DESIGN_CAPACITY.historyDays),
};
const REPORT = process.env.RP_LOAD_REPORT ?? join(tmpdir(), 'rp-load-report.md');
const ADMIN_URL = process.env.RP_LOAD_ADMIN_URL;
const BASE = process.env.RP_LOAD_BASE;
const BASE_DATABASE = 'rp_load_base';
const RUN_DATABASE = 'rp_load';

let cluster: LocalPostgres | undefined;
let walDir: string | undefined;
let setupApp: INestApplication | undefined;
let target: LoadTarget | undefined;
let dropRun: (() => Promise<void>) | undefined;
const printers: SimulatedPrinter[] = [];

afterAll(async () => {
  await setupApp?.close().catch(() => undefined);
  await target?.stop();
  await Promise.all(printers.map((printer) => printer.stop()));
  await dropRun?.();
  await cluster?.stop();
  // The data folder stays in the temporary folder with the server's log.
  if (walDir !== undefined) rmSync(walDir, { recursive: true, force: true });
});

const log = (line: string) => {
  process.stderr.write(`[load ${new Date().toISOString().slice(11, 19)}] ${line}\n`);
};

/** A migration's name: its folder. */
const nameOf = (file: string) => basename(dirname(file));

async function sql(url: string, statement: string): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(statement);
  } finally {
    await client.end();
  }
}

describe.skipIf(!ENABLED)(
  '[NFR-P01] [NFR-P02] [NFR-P03] [NFR-P04] [NFR-P08] [NFR-P09] [NFR-P10] [NFR-P11] the rush at design capacity',
  () => {
    it(
      'meets every target with nothing lost or duplicated',
      async () => {
        let adminUrl = ADMIN_URL;
        if (adminUrl === undefined) {
          walDir = mkdtempSync(join(tmpdir(), 'rp-load-wal-'));
          // WAL archiving as on the restaurant PC (P7-05c), switched on once the year of history
          // is in: the history alone would archive some 20 GB.
          cluster = await startLocalPostgres({
            fsync: 'on',
            synchronous_commit: 'on',
            full_page_writes: 'on',
            timezone: 'UTC',
            wal_level: 'replica',
            archive_mode: 'on',
            archive_command: 'true',
          });
          adminUrl = cluster.adminUrl;
        }
        const version = (await sql(adminUrl, 'SHOW server_version')).rows[0] as
          { server_version: string } | undefined;

        const stations = await Promise.all(
          Array.from({ length: shape.stations }, (_, index) =>
            SimulatedPrinter.start(`station ${String(index + 1)}`),
          ),
        );
        const bills = await Promise.all(
          Array.from({ length: shape.billPrinters }, (_, index) =>
            SimulatedPrinter.start(`bills ${String(index + 1)}`),
          ),
        );
        printers.push(...stations, ...bills);
        const ports = {
          stations: stations.map((printer) => printer.port),
          bills: bills.map((printer) => printer.port),
        };

        // The set-up writes the data folder (secrets, the CA) the server then runs with.
        const saved = BASE === undefined ? undefined : join(BASE, 'restaurant.json');
        const dataDir =
          BASE === undefined ? mkdtempSync(join(tmpdir(), 'rp-load-data-')) : join(BASE, 'data');
        mkdirSync(dataDir, { recursive: true });
        const setUpDatabase = BASE === undefined ? RUN_DATABASE : BASE_DATABASE;
        let restaurant =
          saved !== undefined && existsSync(saved) ? loadRestaurant(saved) : undefined;
        if (restaurant === undefined) {
          await sql(adminUrl, `DROP DATABASE IF EXISTS ${setUpDatabase} WITH (FORCE)`);
          await sql(adminUrl, `CREATE DATABASE ${setUpDatabase}`);
          const url = withDatabase(adminUrl, setUpDatabase);
          await applyMigrations(url);
          setupApp = await createTestApp({ databaseUrl: url, config: { dataDir, tls: true } });
          log('Setting up the restaurant');
          restaurant = await setUpLoadRestaurant(setupApp, shape, ports, url, log);
          await setupApp.close();
          setupApp = undefined;
          if (saved !== undefined) {
            saveRestaurant(saved, restaurant);
            writeFileSync(`${saved}.migrations`, JSON.stringify(migrationFiles().map(nameOf)));
          }
        }
        if (BASE !== undefined) {
          log('Copying the restaurant for this run');
          await sql(adminUrl, `DROP DATABASE IF EXISTS ${RUN_DATABASE} WITH (FORCE)`);
          // A file copy: the default strategy would write the whole database to the WAL archive.
          await sql(
            adminUrl,
            `CREATE DATABASE ${RUN_DATABASE} TEMPLATE ${BASE_DATABASE} STRATEGY FILE_COPY`,
          );
          const admin = adminUrl;
          dropRun = async () => {
            await sql(admin, `DROP DATABASE IF EXISTS ${RUN_DATABASE} WITH (FORCE)`);
          };
        }
        const databaseUrl = withDatabase(adminUrl, RUN_DATABASE);
        if (saved !== undefined) {
          // The migrations written since the restaurant was set up.
          const had = new Set(JSON.parse(readFileSync(`${saved}.migrations`, 'utf8')) as string[]);
          for (const file of migrationFiles().filter((path) => !had.has(nameOf(path)))) {
            log(`Applying ${nameOf(file)}`);
            await sql(databaseUrl, readFileSync(file, 'utf8'));
          }
        }
        setupApp = await createTestApp({ databaseUrl, config: { dataDir, tls: true } });
        restaurant = await readyForToday(setupApp, restaurant, ports);
        const ca = setupApp.get(TlsService).ca()?.certificate;
        if (ca === undefined) throw new Error('No CA');
        await setupApp.close();
        setupApp = undefined;
        if (walDir !== undefined) {
          await sql(adminUrl, `ALTER SYSTEM SET archive_command = 'cp "%p" "${walDir}/%f"'`);
          await sql(adminUrl, 'SELECT pg_reload_conf()');
        }

        const logFile = join(dataDir, 'server.log');
        target = await startBuiltServer({ databaseUrl, dataDir, ca, logFile });
        log(`Server ${String(target.pid)} at ${target.url}, its log in ${logFile}`);
        const result = await runRush({
          shape,
          target,
          restaurant,
          databaseUrl,
          printers: { stations, bills },
          restart: true,
          log,
        });

        const cpu = cpus();
        const report = renderReport(result, {
          machine: `${platform()} ${release()}, ${cpu[0]?.model ?? 'a CPU'} (${String(cpu.length)} cores), ${String(Math.round(totalmem() / 1_024 ** 3))} GB, Node.js ${process.version}`,
          postgres: version?.server_version ?? 'unknown',
          command: 'RP_PERF=1 pnpm --filter @rp/server test:perf load',
        });
        mkdirSync(join(REPORT, '..'), { recursive: true });
        writeFileSync(REPORT, report);
        writeFileSync(`${REPORT}.json`, JSON.stringify(result, null, 2));
        log(`Report in ${REPORT}`);
        process.stderr.write(report);

        expect(result.checks.filter((check) => !check.ok)).toEqual([]);
        expect(result.targets.filter((entry) => !entry.met).map((entry) => entry.id)).toEqual([]);
      },
      4 * 3_600_000,
    );
  },
);
