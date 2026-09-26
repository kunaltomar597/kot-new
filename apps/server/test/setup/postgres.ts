// The local server's throwaway PostgreSQL for integration tests (see @rp/test-postgres): the
// template gets this app's migrations and every database the run creates starts with `rp_`.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as testPostgres from '@rp/test-postgres';

export { type TestDatabaseCluster, withDatabase } from '@rp/test-postgres';

/** Prefix of every database a server test run creates. */
export const DATABASE_PREFIX = 'rp';

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prisma',
  'migrations',
);

/** Migration SQL files in the order Prisma applies them. */
export function migrationFiles(): string[] {
  return testPostgres.migrationFiles(MIGRATIONS_DIR);
}

export function applyMigrations(connectionString: string): Promise<void> {
  return testPostgres.applyMigrations(connectionString, MIGRATIONS_DIR);
}

export function startTestDatabase(): Promise<testPostgres.TestDatabaseCluster> {
  return testPostgres.startTestDatabase({
    migrationsDir: MIGRATIONS_DIR,
    prefix: DATABASE_PREFIX,
  });
}

/** Creates an isolated database for one test file by cloning the migrated template. */
export function cloneTemplateDatabase(
  adminUrl: string,
  templateDatabase: string,
  runId: string,
): Promise<testPostgres.TestDatabase> {
  return testPostgres.cloneTemplateDatabase({
    adminUrl,
    templateDatabase,
    runId,
    prefix: DATABASE_PREFIX,
  });
}
