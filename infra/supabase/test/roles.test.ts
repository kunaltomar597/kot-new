import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingDefinition } from '@rp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_ROLES,
  openRelayDb,
  RELAY_ROLES,
  RELAY_TABLES,
  type RelayDb,
  refusal,
} from './helpers/relay-db.js';
import { RELAY_DIR } from './setup/global-setup.js';

/**
 * The relay's shape (ADR-0015): RLS on every table with policies only for the relay's roles,
 * nothing granted to PUBLIC or Supabase's API roles, functions executable only by the role that
 * needs them, and the schema kept out of the Data API.
 */

let db: RelayDb;

beforeAll(async () => {
  db = await openRelayDb();
});

afterAll(async () => {
  await db.close();
});

const query = async <T extends object>(sql: string, params: unknown[] = []) =>
  (await db.admin.query<T>(sql, params)).rows;

describe('[SEC-005] Row-Level Security on every relay table, deny by default', () => {
  it('lists exactly the tables the tests cover', async () => {
    const tables = await query<{ name: string }>(
      `SELECT relname AS name FROM pg_class
       WHERE relnamespace = 'relay'::regnamespace AND relkind IN ('r', 'p') ORDER BY relname`,
    );
    expect(tables.map((table) => table.name)).toEqual([...RELAY_TABLES].sort());
  });

  it('enables RLS on every table', async () => {
    const open = await query<{ name: string }>(
      `SELECT relname AS name FROM pg_class
       WHERE relnamespace = 'relay'::regnamespace AND relkind IN ('r', 'p')
         AND NOT relrowsecurity`,
    );
    expect(open).toEqual([]);
  });

  it('gives every policy to a relay role, never to PUBLIC or an API role', async () => {
    const policies = await query<{ name: string; roles: string[] }>(
      `SELECT policyname AS name, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'relay'`,
    );
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(policy.roles.length, policy.name).toBe(1);
      expect(RELAY_ROLES, policy.name).toContain(policy.roles[0]);
    }
  });
});

describe('[SEC-005] privileges', () => {
  it('grants nothing on the schema, its tables or its functions to an API role', async () => {
    for (const role of API_ROLES) {
      const [schema] = await query<{ usage: boolean }>(
        `SELECT has_schema_privilege($1, 'relay', 'USAGE') AS usage`,
        [role],
      );
      expect(schema?.usage, role).toBe(false);
      const tables = await query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c
         WHERE c.relnamespace = 'relay'::regnamespace AND c.relkind IN ('r', 'p')
           AND (has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             OR has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))`,
        [role],
      );
      expect(tables, role).toEqual([]);
      const functions = await query<{ name: string }>(
        `SELECT p.proname AS name FROM pg_proc p
         WHERE p.pronamespace = 'relay'::regnamespace
           AND has_function_privilege($1, p.oid, 'EXECUTE')`,
        [role],
      );
      expect(functions, role).toEqual([]);
    }
  });

  it('grants no function to PUBLIC', async () => {
    const open = await query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p
       WHERE p.pronamespace = 'relay'::regnamespace
         AND (p.proacl IS NULL
           OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS acl WHERE acl.grantee = 0))`,
    );
    expect(open).toEqual([]);
  });

  it('lets each role run only the functions it needs', async () => {
    const callable = await query<{ role: string; name: string }>(
      `SELECT r.rolname AS role, p.proname AS name
       FROM pg_proc p CROSS JOIN pg_roles r
       WHERE p.pronamespace = 'relay'::regnamespace AND r.rolname = ANY($1)
         AND p.prorettype <> 'trigger'::regtype
         AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
       ORDER BY r.rolname, p.proname`,
      [[...RELAY_ROLES]],
    );
    const byRole = (role: string) =>
      callable.filter((entry) => entry.role === role).map((entry) => entry.name);
    const claims = ['claim_table', 'claim_tenant', 'claim_uuid'];
    expect(byRole('relay_server')).toEqual(claims);
    expect(byRole('relay_writer')).toEqual(claims);
    expect(byRole('relay_diner')).toEqual([...claims, 'rate_limit_wait']);
    expect(byRole('relay_edge')).toEqual(['resolve_table_token', 'verify_credential']);
    expect(byRole('relay_provisioner')).toEqual([
      'add_credential',
      'provision_tenant',
      'revoke_credential',
      'set_tenant_status',
    ]);
  });

  it('runs every definer-rights function with an empty search_path', async () => {
    const unsafe = await query<{ name: string }>(
      `SELECT proname AS name FROM pg_proc
       WHERE pronamespace = 'relay'::regnamespace AND prosecdef
         AND NOT coalesce(proconfig @> ARRAY['search_path=""'], false)`,
    );
    expect(unsafe).toEqual([]);
  });
});

describe('[SEC-005] roles', () => {
  it('none of the relay roles can log in by default', async () => {
    const login = await query<{ name: string }>(
      `SELECT rolname AS name FROM pg_roles WHERE rolname = ANY($1) AND rolcanlogin
         AND rolname <> 'relay_edge'`,
      [[...RELAY_ROLES]],
    );
    expect(login).toEqual([]);
  });

  it('keeps every relay role away from the Data API', async () => {
    for (const role of RELAY_ROLES) {
      const [membership] = await query<{ member: boolean }>(
        `SELECT pg_has_role('authenticator', $1, 'MEMBER') AS member`,
        [role],
      );
      expect(membership?.member, role).toBe(false);
    }
  });

  it('lets the edge functions switch to a writer, diner or provisioner, inheriting nothing', async () => {
    const memberships = await query<{ role: string; member: boolean; inherits: boolean }>(
      `SELECT r AS role, pg_has_role('relay_edge', r, 'MEMBER') AS member,
              pg_has_role('relay_edge', r, 'USAGE') AS inherits
       FROM unnest($1::text[]) AS r ORDER BY r`,
      [['relay_diner', 'relay_provisioner', 'relay_server', 'relay_writer']],
    );
    expect(memberships).toEqual([
      { role: 'relay_diner', member: true, inherits: false },
      { role: 'relay_provisioner', member: true, inherits: false },
      { role: 'relay_server', member: false, inherits: false },
      { role: 'relay_writer', member: true, inherits: false },
    ]);
  });

  it('lets only the edge functions’ login switch, and only to a writer, diner or provisioner', async () => {
    const [admin] = await query<{ name: string }>('SELECT current_user AS name');
    const targets = [
      'relay_server',
      'relay_writer',
      'relay_diner',
      'relay_provisioner',
      admin!.name,
    ];
    const allowed: string[] = [];
    for (const session of RELAY_ROLES) {
      for (const target of targets.filter((name) => name !== session)) {
        const client = await db.admin.connect();
        try {
          await client.query('BEGIN');
          // The connection logs in as `session`, as the edge functions' does as relay_edge.
          await client.query(`SET LOCAL SESSION AUTHORIZATION ${session}`);
          const switched = await client.query(`SET LOCAL ROLE ${target}`).then(
            () => true,
            (error: unknown) => {
              expect((error as { code?: string }).code).toBe('42501');
              return false;
            },
          );
          if (switched) allowed.push(`${session} -> ${target}`);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
    }
    expect(allowed).toEqual([
      'relay_edge -> relay_writer',
      'relay_edge -> relay_diner',
      'relay_edge -> relay_provisioner',
    ]);
  });

  it('gives the edge functions’ login nothing until it takes a role', async () => {
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL SESSION AUTHORIZATION relay_edge');
      const error = await refusal(client.query('SELECT count(*) FROM relay.qr_orders'));
      expect(error.code).toBe('42501');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('[QR-006] browsers never reach the database directly', () => {
  it('keeps the relay schema out of the Data API', () => {
    const config = readFileSync(join(RELAY_DIR, 'config.toml'), 'utf8');
    const api = /^\[api\]\n([\s\S]*?)(?=^\[)/m.exec(config)?.[1] ?? '';
    const schemas = /^schemas\s*=\s*\[([^\]]*)\]/m.exec(api)?.[1];
    expect(schemas).toBeDefined();
    const exposed = (schemas ?? '').split(',').map((entry) => entry.trim().replace(/"/g, ''));
    expect(exposed).not.toContain('relay');
    expect(exposed).toEqual(['public', 'graphql_public']);
  });

  it('publishes only the order queue to Realtime', async () => {
    const published = await query<{ name: string }>(
      `SELECT tablename AS name FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'relay'`,
    );
    expect(published).toEqual([{ name: 'qr_orders' }]);
  });
});

describe('[QR-006] [QR-007] [QR-008] the relay enforces the restaurant’s QR settings', () => {
  const COLUMNS = [
    ['submissions_per_window', 'qr.submissionsPerWindow', 1, 50],
    ['rate_limit_window_minutes', 'qr.rateLimitWindowMinutes', 1, 120],
    ['pickup_timeout_seconds', 'qr.pickupTimeoutSeconds', 15, 600],
    ['presence_interval_seconds', 'qr.presenceIntervalSeconds', 5, 300],
    ['read_only_after_seconds', 'qr.readOnlyAfterSeconds', 30, 1800],
  ] as const;

  it.each(COLUMNS)('%s has the default and limits of %s', async (column, key, min, max) => {
    const definition = settingDefinition(key);
    expect(definition).toBeDefined();
    const [row] = await query<{ value: string }>(
      `SELECT column_default AS value FROM information_schema.columns
       WHERE table_schema = 'relay' AND table_name = 'tenant_settings' AND column_name = $1`,
      [column],
    );
    expect(Number(row?.value)).toBe(definition?.defaultValue);
    for (const [value, valid] of [
      [min - 1, false],
      [min, true],
      [max, true],
      [max + 1, false],
    ] as const) {
      expect(definition?.schema.safeParse(value).success, `registry ${String(value)}`).toBe(valid);
      const client = await db.admin.connect();
      const tenant = randomUUID();
      try {
        await client.query('BEGIN');
        await client.query("SELECT relay.provision_tenant($1, 'Limits')", [tenant]);
        const result = await client
          .query(`UPDATE relay.tenant_settings SET ${column} = $2 WHERE tenant_id = $1`, [
            tenant,
            value,
          ])
          .then(
            () => true,
            () => false,
          );
        expect(result, `database ${String(value)}`).toBe(valid);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });
});
