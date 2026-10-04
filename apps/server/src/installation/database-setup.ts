import pg from 'pg';
import { DATABASE_LOGINS, type DatabasePasswords } from './installation.js';

/**
 * The database and its logins (AUD-004, SEC-007, P0-16b), made by the installer as the cluster's
 * administrator. Every statement can run again: repair sets the passwords from the secret store
 * again and changes nothing else.
 *
 * - `rp_owner`, `rp_app`, `rp_purge`: the group roles the migrations grant to (they make them too
 *   when missing; made here first so the logins can join them).
 * - `rp_migrator` runs the migrations. Its sessions start as `rp_owner`, so `rp_owner` owns every
 *   object and the default privileges that give `rp_app` each new table are `rp_owner`'s: the same
 *   after a restore, which restores as `rp_owner` (P7-05b).
 * - `rp_server` (in `rp_app`), `rp_purger` (in `rp_purge`), `rp_backup` (replication and
 *   `pg_switch_wal()`, P7-05c).
 */

/** An identifier the installer chose itself, checked before it is put in SQL. */
function identifier(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return name;
}

/** A password as an SQL literal: base64url, so nothing to escape, but checked all the same. */
function passwordLiteral(password: string): string {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(password)) throw new Error('Unexpected password format');
  return `'${password}'`;
}

const GROUP_ROLES = ['rp_owner', 'rp_app', 'rp_purge'] as const;

async function roleExists(client: pg.ClientBase, role: string): Promise<boolean> {
  const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  return rowCount === 1;
}

/** Makes the login, or brings an existing one back to what it should be. */
async function login(
  client: pg.ClientBase,
  role: string,
  password: string,
  attributes: string,
  memberOf?: string,
): Promise<void> {
  const name = identifier(role);
  const verb = (await roleExists(client, name)) ? 'ALTER' : 'CREATE';
  await client.query(
    `${verb} ROLE ${name} WITH LOGIN ${attributes} PASSWORD ${passwordLiteral(password)}`,
  );
  if (memberOf !== undefined) await client.query(`GRANT ${identifier(memberOf)} TO ${name}`);
}

export interface DatabaseSetupResult {
  readonly databaseCreated: boolean;
}

/**
 * Sets up the logins and the database. `adminUrl` connects as the administrator to the `postgres`
 * database; the administrator's own password was set by `initdb`.
 */
export async function setupDatabase(options: {
  readonly adminUrl: string;
  readonly database: string;
  readonly passwords: DatabasePasswords;
}): Promise<DatabaseSetupResult> {
  const database = identifier(options.database);
  const client = new pg.Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    for (const role of GROUP_ROLES) {
      if (!(await roleExists(client, role))) await client.query(`CREATE ROLE ${role} NOLOGIN`);
    }
    const { migrator, server, purger, backup } = DATABASE_LOGINS;
    const { passwords } = options;
    await login(
      client,
      migrator.role,
      passwords.migrator,
      'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT',
      'rp_owner',
    );
    await client.query(`ALTER ROLE ${migrator.role} SET role = 'rp_owner'`);
    await login(
      client,
      server.role,
      passwords.server,
      'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT',
      'rp_app',
    );
    await login(
      client,
      purger.role,
      passwords.purger,
      'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT',
      'rp_purge',
    );
    await login(
      client,
      backup.role,
      passwords.backup,
      'NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION INHERIT',
    );
    await client.query(`GRANT EXECUTE ON FUNCTION pg_switch_wal() TO ${backup.role}`);
    // The administrator's password follows the secret store too (repair after it was replaced).
    await client.query(`ALTER ROLE CURRENT_USER WITH PASSWORD ${passwordLiteral(passwords.admin)}`);

    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      database,
    ]);
    const databaseCreated = rowCount === 0;
    if (databaseCreated) {
      await client.query(
        `CREATE DATABASE ${database} OWNER rp_owner TEMPLATE template0 ENCODING 'UTF8'`,
      );
    }
    // Only our roles may connect to the restaurant's database.
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO rp_app, rp_purge`);
    await client.query(`GRANT ALL ON DATABASE ${database} TO rp_owner`);
    return { databaseCreated };
  } finally {
    await client.end();
  }
}
