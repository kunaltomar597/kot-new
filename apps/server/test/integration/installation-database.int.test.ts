import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPgBin } from '@rp/test-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupDatabase } from '../../src/installation/database-setup.js';
import {
  databasePassword,
  type DatabasePasswords,
  databaseUrl,
  InstallationFile,
  installationPaths,
} from '../../src/installation/installation.js';
import {
  MIGRATIONS_DIR,
  MigrationError,
  migrate,
  readMigrations,
} from '../../src/installation/migrations.js';
import { initPostgres } from '../../src/installation/postgres-setup.js';

/**
 * The installer's database steps on a real PostgreSQL 16 (P0-16b): `initdb` with the settings it
 * owns, the logins, every migration applied by the runner as the migrator (not a superuser), and
 * what each login may then do. initdb refuses to run as root, so this is skipped there (cloud
 * containers); CI and developers' PCs run it.
 */

const asRoot = process.getuid?.() === 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

const passwords: DatabasePasswords = {
  admin: databasePassword(Buffer.alloc(32, 11)),
  migrator: databasePassword(Buffer.alloc(32, 12)),
  server: databasePassword(Buffer.alloc(32, 13)),
  purger: databasePassword(Buffer.alloc(32, 14)),
  backup: databasePassword(Buffer.alloc(32, 15)),
};

let folder = '';
let bin = '';
let installation: InstallationFile;
let pgData = '';

async function query<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, values)).rows;
  } finally {
    await client.end();
  }
}

const url = (login: keyof DatabasePasswords, database?: string) =>
  databaseUrl(installation, login, passwords, database);

describe.skipIf(asRoot)('[ONB-001] [DATA-001] [AUD-004] the installer sets up PostgreSQL', () => {
  beforeAll(async () => {
    const found = findPgBin();
    if (found === undefined) throw new Error('PostgreSQL 16 is needed: set PG_BIN');
    bin = found;
    folder = mkdtempSync(join(tmpdir(), 'rp-installer-'));
    installation = InstallationFile.parse({
      format: 1,
      installDir: join(folder, 'program files'),
      dataDir: join(folder, 'data'),
      productVersion: '1.0.0',
      secretStore: 'file',
      postgres: { port: await freePort() },
    });
    mkdirSync(installation.dataDir, { recursive: true });
    pgData = installationPaths(installation).pgData;
    expect(await initPostgres(installation, passwords.admin, { pgBin: bin })).toBe(true);
    const started = spawnSync(
      join(bin, 'pg_ctl'),
      ['-D', pgData, '-l', join(folder, 'postgres.log'), '-w', '-t', '60', 'start'],
      { encoding: 'utf8' },
    );
    if (started.status !== 0) throw new Error(`pg_ctl start failed: ${started.stderr}`);
  }, 120_000);

  afterAll(() => {
    if (pgData !== '') {
      spawnSync(join(bin, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    }
    if (folder !== '') rmSync(folder, { recursive: true, force: true });
  });

  it('creates the cluster with SCRAM passwords, checksums, UTC and WAL archiving', async () => {
    const admin = url('admin', 'postgres');
    const settings = await query<{ name: string; setting: string }>(
      admin,
      `SELECT name, setting FROM pg_settings
       WHERE name IN ('data_checksums', 'TimeZone', 'wal_level', 'archive_mode',
                      'listen_addresses', 'password_encryption', 'server_encoding')`,
    );
    expect(Object.fromEntries(settings.map((row) => [row.name, row.setting]))).toEqual({
      archive_mode: 'on',
      data_checksums: 'on',
      listen_addresses: 'localhost',
      password_encryption: 'scram-sha-256',
      server_encoding: 'UTF8',
      TimeZone: 'UTC',
      wal_level: 'replica',
    });
    // The password counts: a wrong one is refused.
    const wrong = new URL(admin);
    wrong.password = 'not-the-password-at-all-not-at-all';
    await expect(query(wrong.toString(), 'SELECT 1')).rejects.toThrow(/password/);
  });

  it('writes its settings again on repair without a second block', async () => {
    expect(await initPostgres(installation, passwords.admin, { pgBin: bin })).toBe(false);
    const conf = readFileSync(join(pgData, 'postgresql.conf'), 'utf8');
    expect(conf.match(/BEGIN Restaurant Platform/g)).toHaveLength(1);
  });

  it('makes the logins and the database, and every migration applies as the migrator', async () => {
    const first = await setupDatabase({
      adminUrl: url('admin', 'postgres'),
      database: 'restaurant',
      passwords,
    });
    expect(first.databaseCreated).toBe(true);
    const result = await migrate({ url: url('migrator') });
    const all = await readMigrations(MIGRATIONS_DIR);
    expect(result).toEqual({ applied: all.map((m) => m.name), changed: [], unknown: [] });

    const history = await query<{ migration_name: string; checksum: string }>(
      url('migrator'),
      'SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name',
    );
    expect(history).toEqual(all.map((m) => ({ migration_name: m.name, checksum: m.checksum })));
    // Everything belongs to rp_owner, not to the login that ran the migrations.
    const owners = await query<{ owner: string }>(
      url('migrator'),
      `SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(owners).toEqual([{ owner: 'rp_owner' }]);
  });

  it('is idempotent: repair changes nothing and finds no migration to apply', async () => {
    const again = await setupDatabase({
      adminUrl: url('admin', 'postgres'),
      database: 'restaurant',
      passwords,
    });
    expect(again.databaseCreated).toBe(false);
    expect(await migrate({ url: url('migrator') })).toEqual({
      applied: [],
      changed: [],
      unknown: [],
    });
  });

  it("gives the server's login only what it needs", async () => {
    const server = url('server');
    expect(await query(server, 'SELECT count(*)::int AS n FROM restaurants')).toEqual([{ n: 0 }]);
    await expect(query(server, 'DELETE FROM invoices')).rejects.toThrow(/permission denied/);
    await expect(query(server, 'DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
    // It reads the migration history for the backup's record, and cannot change it.
    expect(
      (
        await query<{ name: string }>(
          server,
          'SELECT migration_name AS name FROM _prisma_migrations',
        )
      ).length,
    ).toBeGreaterThan(40);
    await expect(query(server, 'DELETE FROM _prisma_migrations')).rejects.toThrow(
      /permission denied/,
    );
    await expect(query(server, 'CREATE TABLE intruder (id int)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(query(url('server', 'postgres'), 'CREATE DATABASE other')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('[DATA-002] lets the server take the nightly backup with pg_dump', () => {
    const target = new URL(url('server'));
    const dump = spawnSync(
      join(bin, 'pg_dump'),
      [
        '--format=custom',
        '--no-owner',
        '--no-password',
        '--host',
        target.hostname,
        '--port',
        target.port,
        '--username',
        target.username,
        '--file',
        join(folder, 'nightly.dump'),
        'restaurant',
      ],
      { encoding: 'utf8', env: { ...process.env, PGPASSWORD: passwords.server } },
    );
    expect(dump.stderr).toBe('');
    expect(dump.status).toBe(0);
  });

  it('[DATA-008] [DATA-002] gives the purge and backup logins their own rights only', async () => {
    const [purge] = await query<{ invoices: boolean; orders: boolean }>(
      url('purger'),
      `SELECT has_table_privilege('invoices', 'DELETE') AS invoices,
              has_table_privilege('orders', 'DELETE') AS orders`,
    );
    expect(purge).toEqual({ invoices: true, orders: true });
    await expect(query(url('purger'), 'UPDATE restaurants SET id = id')).rejects.toThrow(
      /permission denied/,
    );
    const [wal] = await query<{ lsn: string }>(
      url('backup', 'postgres'),
      'SELECT pg_switch_wal()::text AS lsn',
    );
    expect(wal?.lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    await expect(query(url('backup'), 'SELECT 1')).rejects.toThrow(/permission denied/);
  });

  it('keeps everyone else out of the restaurant database', async () => {
    await query(
      url('admin', 'postgres'),
      `CREATE ROLE outsider LOGIN PASSWORD '${passwords.backup}'`,
    );
    const outsider = new URL(url('backup'));
    outsider.username = 'outsider';
    await expect(query(outsider.toString(), 'SELECT 1')).rejects.toThrow(/permission denied/);
  });

  it("gives the server a later migration's new table (the owner's default privileges)", async () => {
    const directory = join(folder, 'later-migrations');
    cpSync(MIGRATIONS_DIR, directory, { recursive: true });
    mkdirSync(join(directory, '29991231000000_later_table'));
    writeFileSync(
      join(directory, '29991231000000_later_table', 'migration.sql'),
      'CREATE TABLE "later_things" ("id" TEXT PRIMARY KEY, "note" TEXT);',
    );
    expect((await migrate({ url: url('migrator'), directory })).applied).toEqual([
      '29991231000000_later_table',
    ]);
    await query(url('server'), `INSERT INTO later_things VALUES ('a', 'b')`);
    await query(url('server'), `UPDATE later_things SET note = 'c'`);
    expect(await query(url('server'), 'SELECT note FROM later_things')).toEqual([{ note: 'c' }]);
    // The program without that migration sees a newer database and says so.
    expect((await migrate({ url: url('migrator') })).unknown).toEqual([
      '29991231000000_later_table',
    ]);
  });

  it('[UPD-005] undoes a failed migration whole and records nothing', async () => {
    const directory = join(folder, 'failing-migrations');
    cpSync(MIGRATIONS_DIR, directory, { recursive: true });
    mkdirSync(join(directory, '29991231000001_broken'));
    writeFileSync(
      join(directory, '29991231000001_broken', 'migration.sql'),
      'CREATE TABLE "half_done" ("id" TEXT);\nSELECT * FROM "no_such_table";',
    );
    const failed = migrate({ url: url('migrator'), directory });
    await expect(failed).rejects.toBeInstanceOf(MigrationError);
    await expect(failed).rejects.toThrow(/29991231000001_broken failed and was undone/);
    expect(
      await query(url('migrator'), `SELECT to_regclass('public.half_done') IS NULL AS gone`),
    ).toEqual([{ gone: true }]);
    expect(
      await query(
        url('migrator'),
        `SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name LIKE '%broken'`,
      ),
    ).toEqual([{ n: 0 }]);
  });
});
