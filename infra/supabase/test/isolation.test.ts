import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_ROLES,
  DENIED,
  openRelayDb,
  RELAY_TABLES,
  type RelayDb,
  type RelayTable,
  refusal,
  type Role,
  seedTenant,
  type SeededTenant,
  sha256,
  someLines,
  tenantColumn,
} from './helpers/relay-db.js';

/**
 * SEC-005 / QR-014 (S11): no QR code, token or credential of one restaurant can read or write
 * another restaurant's menu or orders. Two restaurants, A and B, are set up the way the Control
 * Plane and their local servers would; then every relay role tries to cross over.
 */

let db: RelayDb;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  db = await openRelayDb();
  a = await seedTenant(db, 'Restaurant A');
  b = await seedTenant(db, 'Restaurant B');
});

afterAll(async () => {
  await db.close();
});

/** The tenants of the rows `role` sees in `table` (A and B only; other test files may share). */
async function tenantsSeen(
  role: Role,
  claims: Parameters<RelayDb['as']>[1],
  table: RelayTable,
): Promise<string[]> {
  const column = tenantColumn(table);
  return db.as(role, claims, async (client) => {
    const { rows } = await client.query<{ tenant: string }>(
      `SELECT ${column}::text AS tenant FROM relay.${table} WHERE ${column} = ANY($1::uuid[])`,
      [[a.id, b.id]],
    );
    return rows.map((row) => row.tenant);
  });
}

const WRITER_TABLES = RELAY_TABLES.filter((table) => table !== 'credentials');

describe('[SEC-005] [QR-014] a local server stays inside its restaurant', () => {
  it.each(WRITER_TABLES)('sees only its own rows in %s', async (table) => {
    const seen = await tenantsSeen('relay_writer', { tenant_id: a.id }, table);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([a.id]));
  });

  it('never sees credentials, not even its own', async () => {
    const error = await refusal(tenantsSeen('relay_writer', { tenant_id: a.id }, 'credentials'));
    expect(error.code).toBe(DENIED);
  });

  it('cannot add rows for another restaurant', async () => {
    const asA = (sql: string, params: unknown[]) =>
      refusal(db.as('relay_writer', { tenant_id: a.id }, (client) => client.query(sql, params)));
    const attempts = [
      asA(
        'INSERT INTO relay.dining_tables (tenant_id, table_id, label, token_hash) VALUES ($1, $2, $3, $4)',
        [b.id, randomUUID(), 'X1', sha256('a-token-for-the-other-restaurant')],
      ),
      asA('INSERT INTO relay.menu_snapshots (tenant_id, version, menu) VALUES ($1, 99, $2)', [
        b.id,
        JSON.stringify({ items: ['free biryani'] }),
      ]),
      asA(
        `INSERT INTO relay.photos (tenant_id, photo_id, storage_path, content_type)
         VALUES ($1, $2, $3, 'image/webp')`,
        [b.id, randomUUID(), `${b.id}/x.webp`],
      ),
      asA('INSERT INTO relay.presence (tenant_id) VALUES ($1)', [b.id]),
      asA('INSERT INTO relay.tenant_settings (tenant_id) VALUES ($1)', [b.id]),
    ];
    for (const error of await Promise.all(attempts)) expect(error.code).toBe(DENIED);
  });

  it('changes nothing of another restaurant', async () => {
    const changed = await db.as('relay_writer', { tenant_id: a.id }, async (client) => {
      const statements: [string, unknown[]][] = [
        ['UPDATE relay.dining_tables SET label = $2 WHERE tenant_id = $1', [b.id, 'Hacked']],
        ['UPDATE relay.photos SET removed_at = now() WHERE tenant_id = $1', [b.id]],
        ['UPDATE relay.presence SET server_version = $2 WHERE tenant_id = $1', [b.id, '6.6.6']],
        [
          'UPDATE relay.tenant_settings SET submissions_per_window = 50 WHERE tenant_id = $1',
          [b.id],
        ],
        ["UPDATE relay.qr_orders SET status = 'RECEIVED' WHERE tenant_id = $1", [b.id]],
      ];
      let rows = 0;
      for (const [sql, params] of statements)
        rows += (await client.query(sql, params)).rowCount ?? 0;
      return rows;
    });
    expect(changed).toBe(0);
    const orders = await db.admin.query<{ status: string }>(
      'SELECT status FROM relay.qr_orders WHERE tenant_id = $1',
      [b.id],
    );
    expect(orders.rows.map((row) => row.status)).toEqual(['SUBMITTED', 'SUBMITTED']);
  });

  it('cannot move its own rows to another restaurant', async () => {
    const error = await refusal(
      db.as('relay_writer', { tenant_id: a.id }, (client) =>
        client.query('UPDATE relay.dining_tables SET tenant_id = $2 WHERE tenant_id = $1', [
          a.id,
          b.id,
        ]),
      ),
    );
    expect(error.code).toBe(DENIED);
  });

  it('keeps its photos in its own Storage folder', async () => {
    const error = await refusal(
      db.as('relay_writer', { tenant_id: a.id }, (client) =>
        client.query(
          `INSERT INTO relay.photos (tenant_id, photo_id, storage_path, content_type)
           VALUES ($1, $2, $3, 'image/webp')`,
          [a.id, randomUUID(), `${b.id}/borrowed.webp`],
        ),
      ),
    );
    expect(error.code).toBe('23514');
  });

  it('sees only its own order and request queues in Realtime, and nothing else', async () => {
    const queues: readonly RelayTable[] = ['qr_orders', 'qr_service_requests'];
    for (const queue of queues) {
      expect(new Set(await tenantsSeen('relay_server', { tenant_id: a.id }, queue)), queue).toEqual(
        new Set([a.id]),
      );
    }
    for (const table of RELAY_TABLES.filter((name) => !queues.includes(name))) {
      const error = await refusal(tenantsSeen('relay_server', { tenant_id: a.id }, table));
      expect(error.code, table).toBe(DENIED);
    }
    const write = await refusal(
      db.as('relay_server', { tenant_id: a.id }, (client) =>
        client.query("UPDATE relay.qr_orders SET status = 'RECEIVED' WHERE tenant_id = $1", [a.id]),
      ),
    );
    expect(write.code).toBe(DENIED);
  });
});

describe('[SEC-005] [QR-014] a diner stays at their table', () => {
  const asDinerAtA1 = () => ({ tenant_id: a.id, table_id: a.tables[0].id });

  it('reads its own restaurant’s menu, photos, presence and settings only', async () => {
    for (const table of [
      'tenants',
      'tenant_settings',
      'menu_snapshots',
      'photos',
      'presence',
    ] as const) {
      expect(new Set(await tenantsSeen('relay_diner', asDinerAtA1(), table)), table).toEqual(
        new Set([a.id]),
      );
    }
  });

  it('sees its own table and its orders, not the next table’s', async () => {
    const tables = await db.as('relay_diner', asDinerAtA1(), (client) =>
      client.query<{ table_id: string }>('SELECT table_id FROM relay.dining_tables'),
    );
    expect(tables.rows.map((row) => row.table_id)).toEqual([a.tables[0].id]);
    const orders = await db.as('relay_diner', asDinerAtA1(), (client) =>
      client.query<{ id: string }>('SELECT id FROM relay.qr_orders'),
    );
    expect(orders.rows.map((row) => row.id)).toEqual([a.orderIds[0]]);
  });

  it('never reads a table’s token hash', async () => {
    const error = await refusal(
      db.as('relay_diner', asDinerAtA1(), (client) =>
        client.query('SELECT token_hash FROM relay.dining_tables'),
      ),
    );
    expect(error.code).toBe(DENIED);
  });

  it('orders only for its own table', async () => {
    const elsewhere = [
      [a.id, a.tables[1].id],
      [b.id, b.tables[0].id],
    ] as const;
    for (const [tenantId, tableId] of elsewhere) {
      const error = await refusal(
        db.as('relay_diner', asDinerAtA1(), (client) =>
          client.query(
            `INSERT INTO relay.qr_orders
               (tenant_id, table_id, idempotency_key, browser_id, snapshot_version, lines)
             VALUES ($1, $2, $3, 'browser-cross', 1, $4)`,
            [tenantId, tableId, randomUUID(), someLines()],
          ),
        ),
      );
      expect(error.code).toBe(DENIED);
    }
  });

  it('changes no order and deletes nothing', async () => {
    const update = await refusal(
      db.as('relay_diner', asDinerAtA1(), (client) =>
        client.query("UPDATE relay.qr_orders SET status = 'RECEIVED'"),
      ),
    );
    expect(update.code).toBe(DENIED);
  });
});

describe('[QR-014] tokens and credentials open one restaurant only', () => {
  it('resolves each table’s token to that table', async () => {
    for (const tenant of [a, b]) {
      for (const table of tenant.tables) {
        const { rows } = await db.as('relay_edge', undefined, (client) =>
          client.query<{ tenant_id: string; table_id: string; label: string }>(
            'SELECT * FROM relay.resolve_table_token($1)',
            [table.token],
          ),
        );
        expect(rows).toEqual([{ tenant_id: tenant.id, table_id: table.id, label: table.label }]);
      }
    }
  });

  it('verifies each credential to its own restaurant', async () => {
    for (const tenant of [a, b]) {
      const { rows } = await db.as('relay_edge', undefined, (client) =>
        client.query<{ tenant_id: string; credential_id: string }>(
          'SELECT * FROM relay.verify_credential($1)',
          [tenant.credential],
        ),
      );
      expect(rows).toEqual([{ tenant_id: tenant.id, credential_id: tenant.credentialId }]);
    }
  });

  it('never takes a table token for a credential, or the other way round', async () => {
    const found = await db.as('relay_edge', undefined, async (client) => {
      const credentials = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM relay.verify_credential($1)',
        [a.tables[0].token],
      );
      const tables = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM relay.resolve_table_token($1)',
        [a.credential],
      );
      return [...credentials.rows, ...tables.rows];
    });
    expect(found).toEqual([]);
  });
});

describe('[SEC-005] without a valid scope there is nothing', () => {
  it.each([
    ['no claims', undefined],
    ['empty claims', '{}'],
    ['a tenant that is not a UUID', JSON.stringify({ tenant_id: "' OR true --" })],
    ['an unknown tenant', JSON.stringify({ tenant_id: randomUUID() })],
  ])('with %s a local server and a diner see no rows', async (_label, claims) => {
    for (const role of ['relay_writer', 'relay_diner'] as const) {
      for (const table of ['tenants', 'menu_snapshots', 'qr_orders'] as const) {
        expect(await tenantsSeen(role, claims, table), `${role} ${table}`).toEqual([]);
      }
    }
    expect(await tenantsSeen('relay_server', claims, 'qr_orders')).toEqual([]);
  });

  it('a diner without a table claim cannot order', async () => {
    const error = await refusal(
      db.as('relay_diner', { tenant_id: a.id }, (client) =>
        client.query(
          `INSERT INTO relay.qr_orders
             (tenant_id, table_id, idempotency_key, browser_id, snapshot_version, lines)
           VALUES ($1, $2, $3, 'browser-no-table', 1, $4)`,
          [a.id, a.tables[0].id, randomUUID(), someLines()],
        ),
      ),
    );
    expect(error.code).toBe(DENIED);
  });
});

describe('[SEC-005] [QR-006] browsers and Supabase’s API roles never reach the relay', () => {
  it.each(API_ROLES)('%s reads, writes and calls nothing', async (role) => {
    for (const table of RELAY_TABLES) {
      const error = await refusal(tenantsSeen(role, { tenant_id: a.id }, table));
      expect(error.code, table).toBe(DENIED);
    }
    for (const call of [
      'SELECT * FROM relay.resolve_table_token($1)',
      'SELECT * FROM relay.verify_credential($1)',
    ]) {
      const error = await refusal(
        db.as(role, undefined, (client) => client.query(call, [a.tables[0].token])),
      );
      expect(error.code, call).toBe(DENIED);
    }
    const insert = await refusal(
      db.as(role, undefined, (client) =>
        client.query(
          `INSERT INTO relay.qr_orders
             (tenant_id, table_id, idempotency_key, browser_id, snapshot_version, lines)
           VALUES ($1, $2, $3, 'browser-direct', 1, $4)`,
          [a.id, a.tables[0].id, randomUUID(), someLines()],
        ),
      ),
    );
    expect(insert.code).toBe(DENIED);
  });
});

describe('[AUD-004] nothing is deleted through the relay roles', () => {
  it.each(['relay_server', 'relay_writer', 'relay_diner'] as const)(
    '%s deletes nothing',
    async (role) => {
      for (const table of RELAY_TABLES) {
        const column = tenantColumn(table);
        const error = await refusal(
          db.as(role, { tenant_id: a.id, table_id: a.tables[0].id }, (client) =>
            client.query(`DELETE FROM relay.${table} WHERE ${column} = $1`, [a.id]),
          ),
        );
        expect(error.code, table).toBe(DENIED);
      }
    },
  );
});
