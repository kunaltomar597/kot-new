import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openRelayDb,
  type RelayDb,
  seedTenant,
  type SeededTenant,
  submitOrder,
} from './helpers/relay-db.js';

/**
 * QR-007: orders nobody picked up in time are marked expired by the relay, every minute where
 * pg_cron runs; the local server then can no longer receive them.
 */

let db: RelayDb;
let tenant: SeededTenant;

beforeAll(async () => {
  db = await openRelayDb();
  tenant = await seedTenant(db, 'Expiry House');
});

afterAll(async () => {
  await db.close();
});

const statusOf = async (id: string) =>
  (
    await db.admin.query<{ status: string }>('SELECT status FROM relay.qr_orders WHERE id = $1', [
      id,
    ])
  ).rows[0]?.status;

describe('[QR-007] the expiry job', () => {
  it('marks orders past their pickup time expired, and only those', async () => {
    const overdue = await submitOrder(db, tenant.id, tenant.tables[0].id);
    const received = await submitOrder(db, tenant.id, tenant.tables[0].id);
    await db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
      client.query("UPDATE relay.qr_orders SET status = 'RECEIVED' WHERE id = $1", [received]),
    );
    const fresh = await submitOrder(db, tenant.id, tenant.tables[1].id);
    // 61 seconds from now, both new orders are past T (60 s); the received one is not affected.
    const { rows } = await db.admin.query<{ expired: string }>(
      "SELECT relay.expire_orders(now() + interval '61 seconds') AS expired",
    );
    expect(Number(rows[0]?.expired)).toBeGreaterThanOrEqual(2);
    expect(await statusOf(overdue)).toBe('EXPIRED');
    expect(await statusOf(fresh)).toBe('EXPIRED');
    expect(await statusOf(received)).toBe('RECEIVED');
  });

  it('leaves orders still within their pickup time', async () => {
    const id = await submitOrder(db, tenant.id, tenant.tables[0].id);
    await db.admin.query('SELECT relay.expire_orders()');
    expect(await statusOf(id)).toBe('SUBMITTED');
  });

  it('is scheduled every minute where pg_cron exists (Supabase)', async (context) => {
    const { rows } = await db.admin.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS installed",
    );
    if (rows[0]?.installed !== true) context.skip();
    const jobs = await db.admin.query<{ schedule: string; command: string }>(
      "SELECT schedule, command FROM cron.job WHERE jobname = 'relay-expire'",
    );
    expect(jobs.rows).toEqual([{ schedule: '* * * * *', command: 'SELECT relay.expire_orders()' }]);
  });
});
