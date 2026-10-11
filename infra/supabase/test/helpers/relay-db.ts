import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { QrMenuDocument } from '@rp/contracts/relay';
import { cloneTemplateDatabase } from '@rp/test-postgres';
import pg from 'pg';
import { inject } from 'vitest';
import type { RelayDatabase } from '../../src/db.js';
import { pgRelayDatabase } from '../../src/testing/index.js';

/** The relay's own roles (ADR-0015), the last two of them logins. */
export const RELAY_ROLES = [
  'relay_server',
  'relay_writer',
  'relay_diner',
  'relay_provisioner',
  'relay_edge',
  'relay_control_plane',
] as const;
/** Supabase's Data API roles: none of them may reach the relay. */
export const API_ROLES = ['anon', 'authenticated', 'service_role', 'authenticator'] as const;
export type Role = (typeof RELAY_ROLES)[number] | (typeof API_ROLES)[number];

export const RELAY_TABLES = [
  'tenants',
  'credentials',
  'tenant_settings',
  'dining_tables',
  'menu_snapshots',
  'photos',
  'presence',
  'qr_orders',
  'qr_service_requests',
] as const;
export type RelayTable = (typeof RELAY_TABLES)[number];
/** The column naming each table's tenant. */
export const tenantColumn = (table: RelayTable) => (table === 'tenants' ? 'id' : 'tenant_id');

export interface Claims {
  readonly tenant_id?: string;
  readonly table_id?: string;
}

export interface RelayDb {
  /** Where the database is, as the superuser that set it up. */
  readonly url: string;
  /** The superuser connection that set the database up. */
  readonly admin: pg.Pool;
  /**
   * Runs `work` in one transaction as `role`, with `claims` in request.jwt.claims, exactly as
   * PostgREST, Realtime and the edge functions do. A string is sent as the claims verbatim.
   * The transaction rolls back when `work` throws.
   */
  as<T>(
    role: Role,
    claims: Claims | string | undefined,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

/** A database with the relay schema for one test file: a clone of the template, or Supabase. */
export async function openRelayDb(): Promise<RelayDb> {
  const direct = inject('relayDirectUrl');
  let url = direct;
  let drop = () => Promise.resolve();
  if (direct === '') {
    const database = await cloneTemplateDatabase({
      adminUrl: inject('pgAdminUrl'),
      templateDatabase: inject('pgTemplateDatabase'),
      runId: inject('pgRunId'),
      prefix: 'relay',
    });
    url = database.url;
    drop = () => database.drop();
  }
  const admin = new pg.Pool({ connectionString: url, max: 4 });
  // The pool's end() resolves before its connections have closed. Dropping the database first
  // would end them from the server's side: an uncaught error on a client the pool has let go.
  const closed: Promise<void>[] = [];
  admin.on('connect', (client) => {
    closed.push(
      new Promise((resolve) => {
        client.once('end', () => {
          resolve();
        });
      }),
    );
  });
  return {
    url,
    admin,
    async as(role, claims, work) {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${pg.escapeIdentifier(role)}`);
        if (claims !== undefined) {
          await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
            typeof claims === 'string' ? claims : JSON.stringify({ role, ...claims }),
          ]);
        }
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await admin.end();
      await Promise.all(closed);
      await drop();
    },
  };
}

/** The database error `work` fails with; fails the test when it succeeds. */
export async function refusal(work: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error('Expected the database to refuse');
}

/** SQLSTATE of a privilege or Row-Level Security refusal. */
export const DENIED = '42501';

/** A QR table token: 128 random bits (P5-04 makes them on the local server). */
export const newTableToken = () => randomBytes(16).toString('base64url');
/** A local server's credential: 256 random bits (the Control Plane makes them, VCP-002). */
export const newCredential = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export interface SeededTable {
  readonly id: string;
  readonly label: string;
  readonly token: string;
}

export interface SeededTenant {
  readonly id: string;
  readonly name: string;
  readonly credential: string;
  readonly credentialId: string;
  readonly tables: readonly [SeededTable, SeededTable];
  readonly photoId: string;
  /** One order at each table. */
  readonly orderIds: readonly [string, string];
}

/** Lines of a QR order as the relay stores them (`OrderLineRequest`, without prices). */
export const someLines = () =>
  JSON.stringify([
    { clientLineId: randomUUID(), itemId: randomUUID(), quantity: 1, modifiers: [] },
  ]);

/** Inserts an order as the diner at `table`, returning its id. */
export async function submitOrder(
  db: RelayDb,
  tenantId: string,
  tableId: string,
  options: { idempotencyKey?: string; browserId?: string } = {},
): Promise<string> {
  return db.as('relay_diner', { tenant_id: tenantId, table_id: tableId }, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO relay.qr_orders
         (tenant_id, table_id, idempotency_key, browser_id, snapshot_version, lines)
       VALUES ($1, $2, $3, $4, 1, $5) RETURNING id`,
      [
        tenantId,
        tableId,
        options.idempotencyKey ?? randomUUID(),
        options.browserId ?? `browser-${randomUUID()}`,
        someLines(),
      ],
    );
    return rows[0]!.id;
  });
}

/**
 * A restaurant as the Control Plane and its local server set it up: provisioned with a
 * credential, two tables with QR codes, a menu, a photo, presence, and an order at each table.
 */
export async function seedTenant(db: RelayDb, name: string): Promise<SeededTenant> {
  const id = randomUUID();
  const credential = newCredential();
  const credentialId = await db.as('relay_provisioner', undefined, async (client) => {
    await client.query('SELECT relay.provision_tenant($1, $2)', [id, name]);
    const { rows } = await client.query<{ id: string }>(
      'SELECT relay.add_credential($1, $2, $3) AS id',
      [id, sha256(credential), 'Counter PC'],
    );
    return rows[0]!.id;
  });
  const tables: [SeededTable, SeededTable] = [
    { id: randomUUID(), label: 'T1', token: newTableToken() },
    { id: randomUUID(), label: 'T2', token: newTableToken() },
  ];
  const photoId = randomUUID();
  await db.as('relay_writer', { tenant_id: id }, async (client) => {
    for (const table of tables) {
      await client.query(
        `INSERT INTO relay.dining_tables (tenant_id, table_id, label, token_hash)
         VALUES ($1, $2, $3, $4)`,
        [id, table.id, table.label, sha256(table.token)],
      );
    }
    await client.query(
      'INSERT INTO relay.menu_snapshots (tenant_id, version, menu) VALUES ($1, 1, $2)',
      [id, JSON.stringify({ restaurant: name, items: [] })],
    );
    await client.query(
      `INSERT INTO relay.photos (tenant_id, photo_id, storage_path, content_type)
       VALUES ($1, $2, $3, 'image/webp')`,
      [id, photoId, `${id}/${photoId}.webp`],
    );
    await client.query('INSERT INTO relay.presence (tenant_id, server_version) VALUES ($1, $2)', [
      id,
      '1.0.0',
    ]);
  });
  const orderIds: [string, string] = [
    await submitOrder(db, id, tables[0].id),
    await submitOrder(db, id, tables[1].id),
  ];
  await db.as('relay_diner', { tenant_id: id, table_id: tables[0].id }, (client) =>
    client.query(
      `INSERT INTO relay.qr_service_requests (tenant_id, table_id, idempotency_key, browser_id, type)
       VALUES ($1, $2, $3, $4, 'WAITER')`,
      [id, tables[0].id, randomUUID(), `browser-${randomUUID()}`],
    ),
  );
  return { id, name, credential, credentialId, tables, photoId, orderIds };
}

/** The functions' database as on Supabase, on this file's database (`@rp/relay/testing`). */
export function edgeDatabase(db: RelayDb): RelayDatabase {
  return pgRelayDatabase(db.admin);
}

/** Publishes `document` as the tenant's menu `version`, as the sync agent will (P5-03). */
export async function publishMenu(
  db: RelayDb,
  tenantId: string,
  version: number,
  document: QrMenuDocument,
): Promise<void> {
  await db.as('relay_writer', { tenant_id: tenantId }, (client) =>
    client.query(
      'INSERT INTO relay.menu_snapshots (tenant_id, version, menu) VALUES ($1, $2, $3)',
      [tenantId, version, JSON.stringify(document)],
    ),
  );
}

/** The restaurant was last heard from `secondsAgo` ago (QR-008), whatever the trigger stamps. */
export async function lastSeen(db: RelayDb, tenantId: string, secondsAgo: number): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `UPDATE relay.presence SET last_seen_at = now() - make_interval(secs => $2)
       WHERE tenant_id = $1`,
      [tenantId, secondsAgo],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

/** Moves an order's pickup deadline into the past, as if T had passed (superuser, rules off). */
export async function letExpire(db: RelayDb, orderId: string): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      "UPDATE relay.qr_orders SET expires_at = now() - interval '1 second' WHERE id = $1",
      [orderId],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}
