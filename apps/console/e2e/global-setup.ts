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
    // A system alert for the alert centre and an update on offer for the System page (P4-04).
    // The dedupe key is not the server's own `disk`, so its disk check leaves this one alone.
    await client.query(
      `INSERT INTO alerts (id, restaurant_id, business_date, type, payload, dedupe_key)
       SELECT gen_random_uuid(), id, current_date, 'DISK_OR_BACKUP',
              '{"usedPercent": 91, "freeBytes": 20000000000}'::jsonb, 'e2e:disk'
       FROM restaurants`,
    );
    await client.query(`INSERT INTO system_meta (key, value, updated_at) VALUES ($1, $2, now())`, [
      'control_plane.offered_update',
      JSON.stringify({
        component: 'RESTAURANT_PC',
        channel: 'STABLE',
        version: '9.9.0',
        url: 'https://downloads.example.com/restaurant-pc.exe',
        sha256: 'a'.repeat(64),
        sizeBytes: 120_000_000,
        notes: 'Faster bills.',
        publishedAt: '2026-09-30T10:00:00.000Z',
      }),
    ]);
  } finally {
    await client.end();
  }
  process.env.RP_E2E_DATABASE_URL = database.url;
  process.env.RP_E2E_DATA_DIR = dataDir;
  // A second, empty database and data folder: a fresh install for the first-run test (P7-07b).
  const fresh = await cloneTemplateDatabase(
    cluster.adminUrl,
    cluster.templateDatabase,
    cluster.runId,
  );
  process.env.RP_E2E_FRESH_DATABASE_URL = fresh.url;
  process.env.RP_E2E_FRESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'rp-e2e-fresh-'));
  // A restaurant of the design capacity's size for the speed test (P8-01b, NFR-P07): the
  // development seed with 970 more dishes in 20 more sections (1,000 in all) and 90 more tables.
  const speed = await cloneTemplateDatabase(
    cluster.adminUrl,
    cluster.templateDatabase,
    cluster.runId,
  );
  const speedDir = mkdtempSync(join(tmpdir(), 'rp-e2e-speed-'));
  execFileSync('node', [join(SERVER_DIST, 'database', 'seed-cli.js')], {
    env: { ...process.env, DATABASE_URL: speed.url, RP_DATA_DIR: speedDir },
    stdio: 'inherit',
  });
  await designCapacity(speed.url);
  process.env.RP_E2E_SPEED_DATABASE_URL = speed.url;
  process.env.RP_E2E_SPEED_DATA_DIR = speedDir;
  return async () => {
    await speed.drop().catch(() => undefined);
    await fresh.drop().catch(() => undefined);
    await database.drop().catch(() => undefined);
    await cluster.stop();
  };
}

/**
 * Grows the development seed to §7.2's size: 1,000 dishes (each section about 50) and 100 tables
 * in 4 sections. The new dishes are in the draft menu; the speed test publishes it.
 */
async function designCapacity(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO settings (id, restaurant_id, key, value, updated_at)
      SELECT gen_random_uuid(), id, setting.key, setting.value, now()
      FROM restaurants,
           (VALUES ('auth.kitchenIndividualLogins', 'true'::jsonb),
                   ('auth.attemptsPerMinutePerDevice', '100'::jsonb)) AS setting (key, value);
      INSERT INTO sections (id, restaurant_id, name, display_order)
      SELECT gen_random_uuid(), id, name, position
      FROM restaurants, (VALUES ('Garden', 3), ('Rooftop', 4)) AS section (name, position);
      INSERT INTO tables (id, restaurant_id, section_id, label, display_order)
      SELECT gen_random_uuid(), r.id, s.id, n::text, n
      FROM restaurants r, generate_series(11, 100) n,
           LATERAL (SELECT id FROM sections WHERE restaurant_id = r.id
                    ORDER BY display_order OFFSET n % 4 LIMIT 1) s;
      INSERT INTO categories (id, restaurant_id, name, display_order)
      SELECT gen_random_uuid(), id, 'Section ' || n, 100 + n
      FROM restaurants, generate_series(1, 20) n;
      INSERT INTO items (id, restaurant_id, category_id, name, base_price, tax_group_id,
                         food_type, station_id, display_order)
      SELECT gen_random_uuid(), r.id, c.id, 'Dish ' || n, 10000 + (n % 33) * 1000, g.id,
             (CASE WHEN n % 3 = 0 THEN 'NON_VEG' ELSE 'VEG' END)::"FoodType", st.id, n
      FROM restaurants r, generate_series(1, 970) n,
           LATERAL (SELECT id FROM categories
                    WHERE restaurant_id = r.id AND name = 'Section ' || (1 + n % 20)) c,
           LATERAL (SELECT id FROM tax_groups WHERE restaurant_id = r.id
                    ORDER BY name LIMIT 1) g,
           LATERAL (SELECT id FROM stations WHERE restaurant_id = r.id
                    AND name = 'Kitchen') st;
    `);
  } finally {
    await client.end();
  }
}
