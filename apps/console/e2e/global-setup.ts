import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { cloneTemplateDatabase, startTestDatabase } from '../../server/test/setup/postgres.js';
import { CONSOLE_DIST, SERVER_DIST } from './paths.js';

/**
 * A throwaway PostgreSQL with every migration and the development seed, shared with the tests
 * through environment variables. Uses TEST_DATABASE_URL when set (CI), otherwise starts a
 * temporary cluster (see apps/server/test/setup/postgres.ts).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const built of [join(SERVER_DIST, 'main.js'), join(CONSOLE_DIST, 'index.html')]) {
    if (!existsSync(built)) throw new Error(`${built} is missing: run pnpm build first`);
  }
  const cluster = await startTestDatabase();
  const database = await cloneTemplateDatabase(
    cluster.adminUrl,
    cluster.templateDatabase,
    cluster.runId,
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'rp-e2e-data-'));
  // The seed hashes PINs with the pepper in the data folder the server will use.
  execFileSync('node', [join(SERVER_DIST, 'database', 'seed-cli.js')], {
    env: { ...process.env, DATABASE_URL: database.url, RP_DATA_DIR: dataDir },
    stdio: 'inherit',
  });
  // Kitchen staff sign in individually here, so every role can be tried at the PIN pad. One
  // browser stands in for a terminal that many people sign in on within a minute, so it gets the
  // highest per-device attempt limit the setting allows (the restaurant default is 10, SEC-009).
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO settings (id, restaurant_id, key, value, updated_at)
       SELECT gen_random_uuid(), id, setting.key, setting.value, now()
       FROM restaurants,
            (VALUES ('auth.kitchenIndividualLogins', 'true'::jsonb),
                    ('auth.attemptsPerMinutePerDevice', '100'::jsonb)) AS setting (key, value)`,
    );
  } finally {
    await client.end();
  }
  process.env.RP_E2E_DATABASE_URL = database.url;
  process.env.RP_E2E_DATA_DIR = dataDir;
  return async () => {
    await database.drop().catch(() => undefined);
    await cluster.stop();
  };
}
