import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newCredential,
  newTableToken,
  openRelayDb,
  type RelayDb,
  refusal,
  seedTenant,
  type SeededTenant,
  sha256,
} from './helpers/relay-db.js';

/**
 * QR-001 and VCP-002: table tokens and local servers' credentials are stored only as hashes,
 * regenerating a code invalidates the old one, and a suspended restaurant or a revoked credential
 * stops working at once.
 */

let db: RelayDb;
let tenant: SeededTenant;

beforeAll(async () => {
  db = await openRelayDb();
  tenant = await seedTenant(db, 'Token House');
});

afterAll(async () => {
  await db.close();
});

const resolve = (token: string | null) =>
  db.as('relay_edge', undefined, async (client) =>
    (
      await client.query<{ tenant_id: string; table_id: string }>(
        'SELECT tenant_id, table_id FROM relay.resolve_table_token($1)',
        [token],
      )
    ).rows.map((row) => row.table_id),
  );

const verify = (secret: string) =>
  db.as('relay_edge', undefined, async (client) =>
    (
      await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM relay.verify_credential($1)',
        [secret],
      )
    ).rows.map((row) => row.tenant_id),
  );

const asProvisioner = <T>(sql: string, params: unknown[]) =>
  db.as('relay_provisioner', undefined, async (client) => {
    const { rows } = await client.query<{ result: T }>(sql, params);
    return rows[0]?.result;
  });

describe('[QR-001] table tokens', () => {
  it('stores only a hash of each token', async () => {
    const { rows } = await db.admin.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM relay.dining_tables WHERE tenant_id = $1 AND table_id = $2',
      [tenant.id, tenant.tables[0].id],
    );
    expect(rows[0]?.token_hash.equals(sha256(tenant.tables[0].token))).toBe(true);
    expect(rows[0]?.token_hash.toString('utf8')).not.toContain(tenant.tables[0].token);
  });

  it('invalidates the old code when a table’s code is regenerated', async () => {
    const table = tenant.tables[1];
    expect(await resolve(table.token)).toEqual([table.id]);
    const fresh = newTableToken();
    await db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
      client.query(
        'UPDATE relay.dining_tables SET token_hash = $3 WHERE tenant_id = $1 AND table_id = $2',
        [tenant.id, table.id, sha256(fresh)],
      ),
    );
    expect(await resolve(table.token)).toEqual([]);
    expect(await resolve(fresh)).toEqual([table.id]);
  });

  it('opens nothing for a deactivated table, and again once it is back', async () => {
    const table = tenant.tables[0];
    const setActive = (active: boolean) =>
      db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
        client.query(
          'UPDATE relay.dining_tables SET active = $3 WHERE tenant_id = $1 AND table_id = $2',
          [tenant.id, table.id, active],
        ),
      );
    await setActive(false);
    expect(await resolve(table.token)).toEqual([]);
    await setActive(true);
    expect(await resolve(table.token)).toEqual([table.id]);
  });

  it('never looks up a token shorter than 128 bits, or none at all', async () => {
    const short = 'abc123';
    await db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
      client.query(
        `INSERT INTO relay.dining_tables (tenant_id, table_id, label, token_hash)
         VALUES ($1, gen_random_uuid(), 'Short', $2)`,
        [tenant.id, sha256(short)],
      ),
    );
    expect(await resolve(short)).toEqual([]);
    expect(await resolve(null)).toEqual([]);
  });
});

describe('[VCP-002] local servers’ credentials', () => {
  it('stores only a hash and notes when it was last used', async () => {
    const before = await db.admin.query<{ secret_hash: Buffer; last_used_at: Date | null }>(
      'SELECT secret_hash, last_used_at FROM relay.credentials WHERE id = $1',
      [tenant.credentialId],
    );
    expect(before.rows[0]?.secret_hash.equals(sha256(tenant.credential))).toBe(true);
    expect(await verify(tenant.credential)).toEqual([tenant.id]);
    const after = await db.admin.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM relay.credentials WHERE id = $1',
      [tenant.credentialId],
    );
    expect(after.rows[0]?.last_used_at).toBeInstanceOf(Date);
  });

  it('stops a revoked credential at once, and only that one', async () => {
    const second = newCredential();
    const secondId = await asProvisioner<string>(
      'SELECT relay.add_credential($1, $2, $3) AS result',
      [tenant.id, sha256(second), 'Replacement PC'],
    );
    expect(await verify(second)).toEqual([tenant.id]);
    expect(await asProvisioner('SELECT relay.revoke_credential($1) AS result', [secondId])).toBe(
      true,
    );
    expect(await verify(second)).toEqual([]);
    expect(await verify(tenant.credential)).toEqual([tenant.id]);
    // Revoking twice changes nothing.
    expect(await asProvisioner('SELECT relay.revoke_credential($1) AS result', [secondId])).toBe(
      false,
    );
  });

  it('refuses anything that is not a 256-bit hash', async () => {
    const error = await refusal(
      asProvisioner('SELECT relay.add_credential($1, $2, $3) AS result', [
        tenant.id,
        Buffer.from('plain secret'),
        'Wrong',
      ]),
    );
    expect(error.code).toBe('23514');
  });
});

describe('[VCP-002] provisioning a restaurant', () => {
  it('suspending it closes every code and credential until it is reactivated', async () => {
    const setStatus = (status: string) =>
      asProvisioner<boolean>('SELECT relay.set_tenant_status($1, $2) AS result', [
        tenant.id,
        status,
      ]);
    expect(await setStatus('SUSPENDED')).toBe(true);
    expect(await resolve(tenant.tables[0].token)).toEqual([]);
    expect(await verify(tenant.credential)).toEqual([]);
    expect(await setStatus('ACTIVE')).toBe(true);
    expect(await resolve(tenant.tables[0].token)).toEqual([tenant.tables[0].id]);
    expect(await verify(tenant.credential)).toEqual([tenant.id]);
    expect((await refusal(setStatus('DELETED'))).code).toBe('23514');
  });

  it('renames on a second provisioning and keeps the restaurant’s settings', async () => {
    await db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
      client.query(
        'UPDATE relay.tenant_settings SET pickup_timeout_seconds = 90 WHERE tenant_id = $1',
        [tenant.id],
      ),
    );
    await asProvisioner('SELECT relay.provision_tenant($1, $2)', [tenant.id, 'Token House II']);
    const { rows } = await db.admin.query<{ name: string; pickup: number }>(
      `SELECT n.name, s.pickup_timeout_seconds AS pickup
       FROM relay.tenants n JOIN relay.tenant_settings s ON s.tenant_id = n.id WHERE n.id = $1`,
      [tenant.id],
    );
    expect(rows).toEqual([{ name: 'Token House II', pickup: 90 }]);
  });
});
