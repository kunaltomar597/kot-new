import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DENIED,
  letExpire,
  openRelayDb,
  type RelayDb,
  refusal,
  seedTenant,
  type SeededTenant,
  someLines,
  submitOrder,
} from './helpers/relay-db.js';

/**
 * The QR order rules the relay keeps whoever writes (QR-007, ORD-013): an order starts as
 * SUBMITTED and expires after T, its idempotency key is unique in its restaurant, its status only
 * moves forward, and an order past T can no longer be received.
 */

let db: RelayDb;
let tenant: SeededTenant;
let other: SeededTenant;

beforeAll(async () => {
  db = await openRelayDb();
  tenant = await seedTenant(db, 'Order House');
  other = await seedTenant(db, 'Other House');
});

afterAll(async () => {
  await db.close();
});

interface OrderRow {
  status: string;
  submitted_at: Date;
  expires_at: Date;
  received_at: Date | null;
}

const orderOf = async (id: string) =>
  (
    await db.admin.query<OrderRow>(
      'SELECT status, submitted_at, expires_at, received_at FROM relay.qr_orders WHERE id = $1',
      [id],
    )
  ).rows[0]!;

const setStatus = (id: string, status: string, detail?: object) =>
  db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
    client.query('UPDATE relay.qr_orders SET status = $2, status_detail = $3 WHERE id = $1', [
      id,
      status,
      detail === undefined ? null : JSON.stringify(detail),
    ]),
  );

describe('[QR-007] a new order', () => {
  it('starts as SUBMITTED, stamped by the relay, and expires after T', async () => {
    const order = await orderOf(tenant.orderIds[0]);
    expect(order.status).toBe('SUBMITTED');
    expect(order.received_at).toBeNull();
    expect(order.expires_at.getTime() - order.submitted_at.getTime()).toBe(60_000);
  });

  it('follows the restaurant’s pickup timeout', async () => {
    await db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
      client.query(
        'UPDATE relay.tenant_settings SET pickup_timeout_seconds = 90 WHERE tenant_id = $1',
        [tenant.id],
      ),
    );
    const order = await orderOf(await submitOrder(db, tenant.id, tenant.tables[0].id));
    expect(order.expires_at.getTime() - order.submitted_at.getTime()).toBe(90_000);
  });

  it('cannot be submitted with a status or deadline of the diner’s choosing', async () => {
    const error = await refusal(
      db.as('relay_diner', { tenant_id: tenant.id, table_id: tenant.tables[0].id }, (client) =>
        client.query(
          `INSERT INTO relay.qr_orders (tenant_id, table_id, idempotency_key, browser_id,
             snapshot_version, lines, status, expires_at)
           VALUES ($1, $2, $3, 'browser-cheat', 1, $4, 'SENT_TO_KITCHEN', now() + interval '1 day')`,
          [tenant.id, tenant.tables[0].id, randomUUID(), someLines()],
        ),
      ),
    );
    expect(error.code).toBe(DENIED);
  });
});

describe('[ORD-013] idempotency', () => {
  it('keeps one order per key in a restaurant, so a replay finds the original', async () => {
    const key = randomUUID();
    const original = await submitOrder(db, tenant.id, tenant.tables[1].id, {
      idempotencyKey: key,
    });
    const replay = await refusal(
      submitOrder(db, tenant.id, tenant.tables[1].id, { idempotencyKey: key }),
    );
    expect(replay.code).toBe('23505');
    const found = await db.as(
      'relay_diner',
      { tenant_id: tenant.id, table_id: tenant.tables[1].id },
      async (client) => {
        const inserted = await client.query(
          `INSERT INTO relay.qr_orders
             (tenant_id, table_id, idempotency_key, browser_id, snapshot_version, lines)
           VALUES ($1, $2, $3, 'browser-replay', 1, $4)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
          [tenant.id, tenant.tables[1].id, key, someLines()],
        );
        expect(inserted.rows).toEqual([]);
        return client.query<{ id: string }>(
          'SELECT id FROM relay.qr_orders WHERE idempotency_key = $1',
          [key],
        );
      },
    );
    expect(found.rows).toEqual([{ id: original }]);
  });

  it('lets another restaurant use the same key', async () => {
    const key = randomUUID();
    await submitOrder(db, tenant.id, tenant.tables[0].id, { idempotencyKey: key });
    await expect(
      submitOrder(db, other.id, other.tables[0].id, { idempotencyKey: key }),
    ).resolves.toEqual(expect.any(String));
  });
});

describe('[QR-007] status moves only forward', () => {
  it('goes received, sent to the kitchen, with item statuses, and no way back', async () => {
    const id = await submitOrder(db, tenant.id, tenant.tables[0].id);
    await setStatus(id, 'RECEIVED');
    const received = await orderOf(id);
    expect(received.status).toBe('RECEIVED');
    expect(received.received_at).toBeInstanceOf(Date);
    expect((await refusal(setStatus(id, 'SUBMITTED'))).code).toBe('RL409');
    await setStatus(id, 'SENT_TO_KITCHEN');
    await setStatus(id, 'SENT_TO_KITCHEN', { items: [{ index: 0, status: 'PREPARING' }] });
    expect((await refusal(setStatus(id, 'REJECTED'))).code).toBe('RL409');
    expect((await refusal(setStatus(id, 'EXPIRED'))).code).toBe('RL409');
    expect((await orderOf(id)).received_at?.getTime()).toBe(received.received_at?.getTime());
  });

  it('keeps a rejected order rejected', async () => {
    const id = await submitOrder(db, tenant.id, tenant.tables[0].id);
    await setStatus(id, 'RECEIVED');
    await setStatus(id, 'REJECTED', { reason: 'Kitchen closing' });
    for (const next of ['RECEIVED', 'SENT_TO_KITCHEN', 'REJECTED']) {
      expect((await refusal(setStatus(id, next))).code, next).toBe('RL409');
    }
  });

  it('never skips receiving', async () => {
    const id = await submitOrder(db, tenant.id, tenant.tables[0].id);
    expect((await refusal(setStatus(id, 'SENT_TO_KITCHEN'))).code).toBe('RL409');
  });
});

describe('[QR-007] an order nobody picked up in time', () => {
  it('can no longer be received; it is marked expired and stays so', async () => {
    const id = await submitOrder(db, tenant.id, tenant.tables[0].id);
    await letExpire(db, id);
    expect((await refusal(setStatus(id, 'RECEIVED'))).code).toBe('RL410');
    await setStatus(id, 'EXPIRED');
    expect((await orderOf(id)).status).toBe('EXPIRED');
    expect((await refusal(setStatus(id, 'RECEIVED'))).code).toBe('RL409');
  });
});

describe('[QR-006] what the diner submitted never changes', () => {
  it('cannot be edited by the local server', async () => {
    const error = await refusal(
      db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
        client.query('UPDATE relay.qr_orders SET lines = $2 WHERE id = $1', [
          tenant.orderIds[0],
          someLines(),
        ]),
      ),
    );
    expect(error.code).toBe(DENIED);
  });

  it('cannot be edited even with full rights, except by turning the rules off', async () => {
    const error = await refusal(
      db.admin.query("UPDATE relay.qr_orders SET instructions = 'Extra spicy' WHERE id = $1", [
        tenant.orderIds[1],
      ]),
    );
    expect(error.code).toBe('RL400');
  });
});
