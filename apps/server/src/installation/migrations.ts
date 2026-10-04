import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Applies the server's migrations on the restaurant PC (P0-16b) without the Prisma CLI and its
 * engines: each `prisma/migrations/<name>/migration.sql` in name order, in a transaction of its
 * own, recorded in Prisma's `_prisma_migrations` table the way `prisma migrate deploy` records
 * it, so either tool sees the other's work. Forward only (UPD-005): nothing is ever rolled back.
 */

/** `prisma/migrations` beside the built server (`dist/installation/` → `prisma/migrations`). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations', import.meta.url));

/** Prisma's own lock, so this and `prisma migrate deploy` never run at once. */
const MIGRATION_LOCK = 72_707_369;

const HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                  VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum"            VARCHAR(64) NOT NULL,
  "finished_at"         TIMESTAMPTZ,
  "migration_name"      VARCHAR(255) NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      TIMESTAMPTZ,
  "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  /** SHA-256 of the file, as Prisma computes it. */
  readonly checksum: string;
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** The migrations in the folder, in the order they apply. */
export async function readMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const migrations: Migration[] = [];
  for (const name of names) {
    let sql: string;
    try {
      sql = await readFile(join(directory, name, 'migration.sql'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    migrations.push({ name, sql, checksum: checksumOf(sql) });
  }
  return migrations;
}

export interface MigrationResult {
  /** Applied now, in order. */
  readonly applied: string[];
  /** Applied earlier, but the file has changed since (a warning: Prisma warns too). */
  readonly changed: string[];
  /** In the database but not in this program: the database is newer than the program. */
  readonly unknown: string[];
}

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

interface HistoryRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/** Applies the pending migrations at `url` (the migrator's login). */
export async function migrate(options: {
  readonly url: string;
  readonly directory?: string;
  readonly log?: (message: string) => void;
}): Promise<MigrationResult> {
  const log = options.log ?? (() => undefined);
  const migrations = await readMigrations(options.directory ?? MIGRATIONS_DIR);
  const client = new pg.Client({ connectionString: options.url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      await client.query(HISTORY_TABLE);
      const { rows } = await client.query<HistoryRow>(
        'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
      );
      const failed = rows.find((row) => row.finished_at === null && row.rolled_back_at === null);
      if (failed !== undefined) {
        throw new MigrationError(
          failed.migration_name,
          `Migration ${failed.migration_name} failed earlier and was left half done. ` +
            'Restore the last backup or ask support.',
        );
      }
      const done = new Map(
        rows
          .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
          .map((row) => [row.migration_name, row.checksum]),
      );
      const known = new Set(migrations.map((migration) => migration.name));
      const result: MigrationResult = {
        applied: [],
        changed: [],
        unknown: [...done.keys()].filter((name) => !known.has(name)).sort(),
      };
      for (const migration of migrations) {
        const checksum = done.get(migration.name);
        if (checksum !== undefined) {
          // A checkout with Windows line endings must not count as a change.
          const lf = checksumOf(migration.sql.replaceAll('\r\n', '\n'));
          if (checksum !== migration.checksum && checksum !== lf) {
            result.changed.push(migration.name);
          }
          continue;
        }
        log(`Applying migration ${migration.name}`);
        const startedAt = new Date();
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO "_prisma_migrations"
               (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
             VALUES ($1, $2, now(), $3, NULL, NULL, $4, 1)`,
            [randomUUID(), migration.checksum, migration.name, startedAt],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new MigrationError(
            migration.name,
            `Migration ${migration.name} failed and was undone: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        result.applied.push(migration.name);
      }
      return result;
    } finally {
      // Ending the session releases it anyway, so a broken connection is no new error.
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}
