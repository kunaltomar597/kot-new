// Throwaway PostgreSQL for integration tests.
//
// - If TEST_DATABASE_URL is set (CI service container, a developer's installed PostgreSQL on
//   Windows or macOS), it is used as the admin connection.
// - Otherwise a temporary cluster is created with initdb/pg_ctl from PG_BIN, pg_config, or a known
//   install path, on a random localhost port, and removed afterwards. When running as root (cloud
//   containers) the cluster runs as the `postgres` system user, because initdb refuses root.
//
// A template database with every migration applied is created once; each test file then clones
// it (CREATE DATABASE ... TEMPLATE), which takes milliseconds and isolates test files.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(SERVER_ROOT, 'prisma', 'migrations');

export interface TestDatabaseCluster {
  readonly adminUrl: string;
  readonly templateDatabase: string;
  readonly runId: string;
  stop(): Promise<void>;
}

export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

function findPgBin(): string | undefined {
  const fromEnv = process.env.PG_BIN;
  if (fromEnv !== undefined && existsSync(join(fromEnv, 'initdb'))) return fromEnv;
  try {
    const bindir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    if (existsSync(join(bindir, 'initdb'))) return bindir;
  } catch {
    // pg_config not on PATH; try known locations below.
  }
  const candidates = [
    '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/17/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/usr/local/opt/postgresql@16/bin',
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'initdb')));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function postgresUserIds(): { uid: number; gid: number } {
  const uid = Number(execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim());
  return { uid, gid };
}

function runPg(bin: string, args: string[], asPostgresUser: boolean): void {
  const command = asPostgresUser ? 'runuser' : bin;
  const commandArgs = asPostgresUser ? ['-u', 'postgres', '--', bin, ...args] : args;
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

async function startLocalCluster(): Promise<{ adminUrl: string; stop: () => Promise<void> }> {
  const bin = findPgBin();
  if (bin === undefined) {
    throw new Error(
      'Integration tests need PostgreSQL 16. Set TEST_DATABASE_URL to an admin connection ' +
        '(for example postgresql://postgres:postgres@127.0.0.1:5432/postgres) or install PostgreSQL ' +
        'and set PG_BIN to its bin folder.',
    );
  }
  const asPostgresUser = process.getuid?.() === 0;
  const baseDir = mkdtempSync(join(tmpdir(), 'rp-pg-'));
  if (asPostgresUser) {
    const { uid, gid } = postgresUserIds();
    chownSync(baseDir, uid, gid);
  }
  const dataDir = join(baseDir, 'data');
  const port = await freePort();
  runPg(
    join(bin, 'initdb'),
    ['-D', dataDir, '--auth=trust', '--username=postgres', '--encoding=UTF8', '--no-sync'],
    asPostgresUser,
  );
  const options = [
    '-c listen_addresses=127.0.0.1',
    `-c port=${port}`,
    `-c unix_socket_directories=${baseDir}`,
    '-c fsync=off',
    '-c synchronous_commit=off',
    '-c full_page_writes=off',
  ].join(' ');
  runPg(
    join(bin, 'pg_ctl'),
    ['-D', dataDir, '-o', options, '-l', join(baseDir, 'server.log'), '-w', 'start'],
    asPostgresUser,
  );
  return {
    adminUrl: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    stop: () => {
      try {
        runPg(
          join(bin, 'pg_ctl'),
          ['-D', dataDir, '-m', 'immediate', '-w', 'stop'],
          asPostgresUser,
        );
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
      return Promise.resolve();
    },
  };
}

/** Migration SQL files in the order Prisma applies them. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(MIGRATIONS_DIR, name, 'migration.sql'))
    .filter((file) => existsSync(file));
}

async function withClient<T>(
  connectionString: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function applyMigrations(connectionString: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    for (const file of migrationFiles()) {
      await client.query(readFileSync(file, 'utf8'));
    }
  });
}

export async function startTestDatabase(): Promise<TestDatabaseCluster> {
  const external = process.env.TEST_DATABASE_URL;
  const local = external === undefined ? await startLocalCluster() : undefined;
  const adminUrl = external ?? local?.adminUrl;
  if (adminUrl === undefined) throw new Error('No PostgreSQL available for tests');

  const runId = randomBytes(4).toString('hex');
  const templateDatabase = `rp_template_${runId}`;
  await withClient(adminUrl, (client) =>
    client.query(`CREATE DATABASE ${quoteIdentifier(templateDatabase)}`),
  );
  await applyMigrations(withDatabase(adminUrl, templateDatabase));

  return {
    adminUrl,
    templateDatabase,
    runId,
    stop: async () => {
      if (local !== undefined) {
        await local.stop();
        return;
      }
      // Shared server: drop everything this run created.
      await withClient(adminUrl, async (client) => {
        const { rows } = await client.query<{ datname: string }>(
          'SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname = $2',
          [`rp_test_${runId}_%`, templateDatabase],
        );
        for (const row of rows) {
          await client.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(row.datname)} WITH (FORCE)`,
          );
        }
      });
    },
  };
}

/** Creates an isolated database for one test file by cloning the migrated template. */
export async function cloneTemplateDatabase(
  adminUrl: string,
  templateDatabase: string,
  runId: string,
): Promise<{ url: string; name: string; drop: () => Promise<void> }> {
  const name = `rp_test_${runId}_${randomBytes(4).toString('hex')}`;
  await withClient(adminUrl, async (client) => {
    // Concurrent clones of the same template can briefly conflict; retry a few times.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.query(
          `CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(templateDatabase)}`,
        );
        return;
      } catch (error) {
        const busy =
          error instanceof Error && error.message.includes('is being accessed by other users');
        if (!busy || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  });
  return {
    name,
    url: withDatabase(adminUrl, name),
    drop: () =>
      withClient(adminUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
      }),
  };
}
