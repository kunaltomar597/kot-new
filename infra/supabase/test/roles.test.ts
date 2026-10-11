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
    expect(byRole('relay_diner')).toEqual([...claims, 'rate_limit_wait', 'service_request_wait']);
    expect(byRole('relay_edge')).toEqual(['resolve_table_token', 'verify_credential']);
    expect(byRole('relay_provisioner')).toEqual([
      'add_credential',
      'provision_tenant',
      'revoke_credential',
      'set_tenant_status',
    ]);
    expect(byRole('relay_control_plane')).toEqual([]);
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
    // relay_edge is left out: the Deno smoke test gives it a password while it runs.
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

  it('[QR-009] lets Realtime take on the local server’s role only, to apply its RLS', async () => {
    // Realtime logs in as `supabase_admin` on Supabase, a superuser that may take on any role;
    // where that login does not exist (plain PostgreSQL standing in), Realtime's role is the one
    // that must be able to.
    const [realtime] = await query<{ login: string; superuser: boolean }>(
      `SELECT rolname AS login, rolsuper AS superuser FROM pg_roles
       WHERE rolname IN ('supabase_admin', 'supabase_realtime_admin')
       ORDER BY rolname = 'supabase_admin' DESC LIMIT 1`,
    );
    expect(realtime).toBeDefined();
    const [canServe] = await query<{ member: boolean }>(
      `SELECT pg_has_role($1, 'relay_server', 'MEMBER') AS member`,
      [realtime?.login],
    );
    expect(canServe?.member).toBe(true);
    if (realtime?.login === 'supabase_admin') expect(realtime.superuser).toBe(true);
    // The reserved Realtime role is given nothing else of the relay's, wherever it may be given
    // something: never a writer's, a diner's or the provisioner's rights.
    const memberships = await query<{ role: string; member: boolean }>(
      `SELECT r AS role, pg_has_role('supabase_realtime_admin', r, 'MEMBER') AS member
       FROM unnest($1::text[]) AS r ORDER BY r`,
      [[...RELAY_ROLES]],
    );
    expect(
      memberships.filter((row) => row.member && row.role !== 'relay_server').map((row) => row.role),
    ).toEqual([]);
  });

  it('lets the edge functions switch to a writer or a diner, never the provisioner, inheriting nothing', async () => {
    const memberships = await query<{
      login: string;
      role: string;
      member: boolean;
      inherits: boolean;
    }>(
      `SELECT l AS login, r AS role, pg_has_role(l, r, 'MEMBER') AS member,
              pg_has_role(l, r, 'USAGE') AS inherits
       FROM unnest($1::text[]) AS l CROSS JOIN unnest($2::text[]) AS r ORDER BY l, r`,
      [
        ['relay_control_plane', 'relay_edge'],
        ['relay_diner', 'relay_provisioner', 'relay_server', 'relay_writer'],
      ],
    );
    expect(memberships.filter((row) => row.member)).toEqual([
      { login: 'relay_control_plane', role: 'relay_provisioner', member: true, inherits: false },
      { login: 'relay_edge', role: 'relay_diner', member: true, inherits: false },
      { login: 'relay_edge', role: 'relay_writer', member: true, inherits: false },
    ]);
  });

  it('lets only the two logins switch: the functions’ to a writer or diner, the Control Plane’s to the provisioner', async () => {
    const [admin] = await query<{ name: string }>('SELECT current_user AS name');
    const targets = [...RELAY_ROLES, admin!.name];
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
      'relay_control_plane -> relay_provisioner',
    ]);
  });

  it('gives each login nothing until it takes a role', async () => {
    const tenant = randomUUID();
    for (const [login, statement] of [
      ['relay_edge', 'SELECT count(*) FROM relay.qr_orders'],
      ['relay_control_plane', "SELECT relay.provision_tenant($1, 'Not Yet')"],
    ] as const) {
      const client = await db.admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
        const params = statement.includes('$1') ? [tenant] : [];
        const error = await refusal(client.query(statement, params));
        expect(error.code, login).toBe('42501');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });

  it('[VCP-002] lets the Control Plane’s login provision a restaurant as the provisioner, and the functions’ login never', async () => {
    const tenant = randomUUID();
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL SESSION AUTHORIZATION relay_control_plane');
      await client.query('SET LOCAL ROLE relay_provisioner');
      await client.query("SELECT relay.provision_tenant($1, 'Provisioned House')", [tenant]);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('SET LOCAL SESSION AUTHORIZATION relay_edge');
      const error = await refusal(client.query('SET LOCAL ROLE relay_provisioner'));
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

  it('publishes only the order and request queues to Realtime', async () => {
    const published = await query<{ name: string }>(
      `SELECT tablename AS name FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'relay'`,
    );
    expect(published.map((table) => table.name).sort()).toEqual([
      'qr_orders',
      'qr_service_requests',
    ]);
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

describe('[MENU-008] [SEC-004] the menu-photo bucket', () => {
  it('takes WebP only, in the table, the bucket and the local configuration alike', async () => {
    const config = readFileSync(join(RELAY_DIR, 'config.toml'), 'utf8');
    const bucket = /^\[storage\.buckets\.menu-photos\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(
      config,
    )?.[1];
    const types = /^allowed_mime_types\s*=\s*\[([^\]]*)\]/m.exec(bucket ?? '')?.[1];
    expect(types?.split(',').map((entry) => entry.trim().replace(/"/g, ''))).toEqual([
      'image/webp',
    ]);

    const tenant = randomUUID();
    const photo = randomUUID();
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT relay.provision_tenant($1, 'Photo Types')", [tenant]);
      for (const [type, stored] of [
        ['image/webp', true],
        ['image/jpeg', false],
        ['image/png', false],
      ] as const) {
        await client.query('SAVEPOINT photo');
        const result = await client
          .query(
            `INSERT INTO relay.photos (tenant_id, photo_id, storage_path, content_type)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [tenant, photo, `${tenant}/${photo}`, type],
          )
          .then(
            () => true,
            (error: unknown) => {
              expect((error as { code?: string }).code).toBe('23514');
              return false;
            },
          );
        await client.query(result ? 'RELEASE SAVEPOINT photo' : 'ROLLBACK TO SAVEPOINT photo');
        expect(result, type).toBe(stored);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // On Supabase (the relay-supabase CI job) the bucket itself refuses other types.
    const [storage] = await query<{ exists: boolean }>(
      "SELECT to_regclass('storage.buckets') IS NOT NULL AS exists",
    );
    if (storage?.exists === true) {
      const [row] = await query<{ types: string[] }>(
        "SELECT allowed_mime_types AS types FROM storage.buckets WHERE id = 'menu-photos'",
      );
      expect(row?.types).toEqual(['image/webp']);
    }
  });
});
