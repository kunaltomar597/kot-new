import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_ROLES,
  DENIED,
  openRelayDb,
  RELAY_ROLES,
  type RelayDb,
  refusal,
  seedTenant,
  type SeededTenant,
  someLines,
} from './helpers/relay-db.js';

/**
 * Relay retention (BRD §9.3): QR orders go 7 days after they were received or expired; every menu
 * snapshot but the latest goes after a day. The relay is a transient queue; the local server keeps
 * the records.
 */

let db: RelayDb;
let tenant: SeededTenant;
let quiet: SeededTenant;

beforeAll(async () => {
  db = await openRelayDb();
  tenant = await seedTenant(db, 'Retention House');
  quiet = await seedTenant(db, 'Quiet House');
});

afterAll(async () => {
  await db.close();
});

/** Writes rows with timestamps in the past, which only a superuser with the rules off can do. */
async function backdate(
  work: (sql: (text: string, params: unknown[]) => Promise<void>) => Promise<void>,
) {
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await work(async (text, params) => {
      await client.query(text, params);
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const ORDERS: readonly (readonly [
  label: string,
  status: string,
  receivedDaysAgo: number | null,
  expiredDaysAgo: number,
])[] = [
  ['received 8 days ago', 'SENT_TO_KITCHEN', 8, 8],
  ['received 6 days ago', 'SENT_TO_KITCHEN', 6, 6],
  ['rejected 8 days ago', 'REJECTED', 8, 8],
  ['expired 8 days ago', 'EXPIRED', null, 8],
  ['expired 2 days ago', 'EXPIRED', null, 2],
  ['never picked up, due 8 days ago', 'SUBMITTED', null, 8],
];

describe('[BRD §9.3] relay retention', () => {
  it('deletes orders 7 days after they were received or expired, and old menus', async () => {
    await backdate(async (sql) => {
      for (const [label, status, receivedDaysAgo, expiredDaysAgo] of ORDERS) {
        await sql(
          `INSERT INTO relay.qr_orders (tenant_id, table_id, idempotency_key, browser_id,
             snapshot_version, lines, instructions, status, submitted_at, expires_at, received_at)
           VALUES ($1, $2, $3, 'browser-old', 1, $4, $5, $6,
             now() - make_interval(days => $7) - interval '1 minute',
             now() - make_interval(days => $7),
             now() - make_interval(days => $8::int))`,
          [
            tenant.id,
            tenant.tables[0].id,
            randomUUID(),
            someLines(),
            label,
            status,
            expiredDaysAgo,
            receivedDaysAgo,
          ],
        );
      }
      for (const [version, hoursAgo] of [
        [2, 72],
        [3, 2],
        [4, 1],
      ] as const) {
        await sql(
          `INSERT INTO relay.menu_snapshots (tenant_id, version, menu, published_at)
           VALUES ($1, $2, '{}', now() - make_interval(hours => $3))`,
          [tenant.id, version, hoursAgo],
        );
      }
      await sql(
        "UPDATE relay.menu_snapshots SET published_at = now() - interval '48 hours' WHERE tenant_id = $1 AND version = 1",
        [tenant.id],
      );
      // A restaurant that has not changed its menu for a month keeps it.
      await sql(
        "UPDATE relay.menu_snapshots SET published_at = now() - interval '30 days' WHERE tenant_id = $1",
        [quiet.id],
      );
    });

    const { rows } = await db.admin.query<{ orders: string; snapshots: string }>(
      'SELECT * FROM relay.purge()',
    );
    expect(Number(rows[0]?.orders)).toBeGreaterThanOrEqual(4);
    expect(Number(rows[0]?.snapshots)).toBeGreaterThanOrEqual(2);

    const orders = await db.admin.query<{ instructions: string | null }>(
      'SELECT instructions FROM relay.qr_orders WHERE tenant_id = $1 ORDER BY instructions',
      [tenant.id],
    );
    // The seeded orders are fresh and stay; of the old ones, only those inside 7 days.
    expect(orders.rows.map((row) => row.instructions)).toEqual([
      'expired 2 days ago',
      'received 6 days ago',
      null,
      null,
    ]);
    const menus = await db.admin.query<{ tenant: string; version: string }>(
      `SELECT tenant_id::text AS tenant, version::text FROM relay.menu_snapshots
       WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id = $2 DESC, version`,
      [[tenant.id, quiet.id], tenant.id],
    );
    expect(menus.rows).toEqual([
      { tenant: tenant.id, version: '3' },
      { tenant: tenant.id, version: '4' },
      { tenant: quiet.id, version: '1' },
    ]);
  });

  it('forgets a photo a day after its files were swept, and keeps the others', async () => {
    const photo = (purgedHoursAgo: number | null) => ({ id: randomUUID(), purgedHoursAgo });
    const photos = [photo(null), photo(2), photo(30)];
    await backdate(async (sql) => {
      for (const { id, purgedHoursAgo } of photos) {
        await sql(
          `INSERT INTO relay.photos (tenant_id, photo_id, storage_path, content_type, removed_at,
             purged_at)
           VALUES ($1::uuid, $2::uuid, $1::text || '/' || $2::text, 'image/webp', now() - interval '100 days',
             now() - make_interval(hours => $3::int))`,
          [tenant.id, id, purgedHoursAgo],
        );
      }
    });
    const { rows } = await db.admin.query<{ photos: string }>('SELECT * FROM relay.purge()');
    expect(Number(rows[0]?.photos)).toBe(1);
    const left = await db.admin.query<{ photo_id: string }>(
      'SELECT photo_id FROM relay.photos WHERE tenant_id = $1 AND photo_id = ANY($2::uuid[])',
      [tenant.id, photos.map(({ id }) => id)],
    );
    expect(left.rows.map((row) => row.photo_id).sort()).toEqual(
      [photos[0]?.id, photos[1]?.id].sort(),
    );
  });

  it('is run by the database itself, never by a relay or API role', async () => {
    for (const role of [...RELAY_ROLES, ...API_ROLES]) {
      const error = await refusal(
        db.as(role, { tenant_id: tenant.id }, (client) => client.query('SELECT relay.purge()')),
      );
      expect(error.code, role).toBe(DENIED);
    }
  });

  it('is scheduled hourly where pg_cron exists (Supabase)', async (context) => {
    const { rows } = await db.admin.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS installed",
    );
    if (rows[0]?.installed !== true) {
      context.skip();
    }
    const jobs = await db.admin.query<{ schedule: string; command: string }>(
      "SELECT schedule, command FROM cron.job WHERE jobname = 'relay-purge'",
    );
    expect(jobs.rows).toEqual([{ schedule: '17 * * * *', command: 'SELECT relay.purge()' }]);
  });
});
