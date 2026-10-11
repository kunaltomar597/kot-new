import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';

/**
 * The database copy an update can go back to (UPD-005, P7-04c). The updater stops the server,
 * then copies the database (`CREATE DATABASE ... TEMPLATE`) before the installer runs, so going
 * back loses nothing written before the update. When the new version fails its health check, the
 * updater leaves a rollback request and installs the previous version again; that version's
 * service host swaps the copy back in before its server starts (`runPendingUpdateRollback`). The
 * database as the failed version left it is kept for support, under another name.
 *
 * Every statement runs as the cluster's administrator (`adminUrl`, connected to `postgres`).
 */

/** PostgreSQL's longest name. */
const NAME_LIMIT = 63;
const SNAPSHOT_SUFFIX = '_before_update';
const FAILED_SUFFIX = '_failed_update';
/** Room the copy needs beyond the database's size: the write-ahead log and the drive's margin. */
const SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

export class UpdateSnapshotError extends Error {
  constructor(
    readonly code:
      | 'NO_DATABASE'
      | 'MIGRATION_HALF_DONE'
      | 'NOT_ENOUGH_SPACE'
      | 'DATABASE_IN_USE'
      | 'NO_SNAPSHOT',
    message: string,
  ) {
    super(message);
    this.name = 'UpdateSnapshotError';
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function withSuffix(database: string, suffix: string): string {
  return `${database.slice(0, NAME_LIMIT - suffix.length)}${suffix}`;
}

/** The copy taken before an update. */
export function snapshotDatabaseName(database: string): string {
  return withSuffix(database, SNAPSHOT_SUFFIX);
}

/** The database a failed update left, kept for support. */
export function failedDatabaseName(database: string): string {
  return withSuffix(database, FAILED_SUFFIX);
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function exists(admin: pg.Client, database: string): Promise<boolean> {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    database,
  ]);
  return rowCount === 1;
}

/** Programs still connected to `database` (autovacuum aside, which PostgreSQL stops itself). */
async function clientsOf(admin: pg.Client, database: string): Promise<string[]> {
  const { rows } = await admin.query<{ who: string | null }>(
    `SELECT nullif(application_name, '') AS who FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
    [database],
  );
  return [...new Set(rows.map((row) => row.who ?? 'a program'))];
}

export interface SnapshotResult {
  readonly snapshot: string;
  readonly sizeBytes: number;
}

/**
 * Copies `database` to its snapshot, replacing an older one. Refuses while a program is connected
 * (the server must be stopped), while a migration is half done (the new version's migrations
 * would stop on it) or when the data drive lacks the room (`freeBytes`, null when unknown).
 */
export async function createUpdateSnapshot(options: {
  readonly adminUrl: string;
  readonly database: string;
  readonly freeBytes: number | null;
  readonly log?: (message: string) => void;
}): Promise<SnapshotResult> {
  const { adminUrl, database } = options;
  const log = options.log ?? (() => undefined);
  const snapshot = snapshotDatabaseName(database);
  return withClient(adminUrl, async (admin) => {
    if (!(await exists(admin, database))) {
      throw new UpdateSnapshotError('NO_DATABASE', `There is no database ${database} to copy.`);
    }
    // The integrity check (UPD-005): no migration left half done by an earlier failure.
    const halfDone = await withClient(withDatabase(adminUrl, database), async (client) => {
      const table = await client.query<{ present: boolean }>(
        "SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present",
      );
      if (table.rows[0]?.present !== true) return [];
      const { rows } = await client.query<{ name: string }>(
        `SELECT migration_name AS name FROM "_prisma_migrations"
          WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
      );
      return rows.map((row) => row.name);
    });
    if (halfDone.length > 0) {
      throw new UpdateSnapshotError(
        'MIGRATION_HALF_DONE',
        `Migration ${halfDone.join(', ')} was left half done; the database needs support before it can be updated.`,
      );
    }
    const size = await admin.query<{ bytes: string }>(
      'SELECT pg_database_size($1)::text AS bytes',
      [database],
    );
    const sizeBytes = Number(size.rows[0]?.bytes ?? '0');
    if (options.freeBytes !== null && options.freeBytes < sizeBytes + SPACE_MARGIN_BYTES) {
      const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
      throw new UpdateSnapshotError(
        'NOT_ENOUGH_SPACE',
        `The data drive has ${gb(options.freeBytes)} GB free; copying the database before the update needs ${gb(sizeBytes + SPACE_MARGIN_BYTES)} GB.`,
      );
    }
    const users = await clientsOf(admin, database);
    if (users.length > 0) {
      throw new UpdateSnapshotError(
        'DATABASE_IN_USE',
        `The database is in use (${users.join(', ')}). Stop the restaurant server first.`,
      );
    }
    const owner = await admin.query<{ owner: string }>(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(snapshot)} WITH (FORCE)`);
    log(`Copying the database ${database} to ${snapshot}`);
    // A file copy writes almost nothing to the log the continuous backup archives.
    await admin.query(
      `CREATE DATABASE ${quoteIdent(snapshot)} TEMPLATE ${quoteIdent(database)} OWNER ${quoteIdent(
        owner.rows[0]?.owner ?? 'rp_owner',
      )} STRATEGY FILE_COPY`,
    );
    return { snapshot, sizeBytes };
  });
}

/** Drops the snapshot once the new version is healthy, or when the update did not happen. */
export async function dropUpdateSnapshot(options: {
  readonly adminUrl: string;
  readonly database: string;
}): Promise<boolean> {
  const snapshot = snapshotDatabaseName(options.database);
  return withClient(options.adminUrl, async (admin) => {
    if (!(await exists(admin, snapshot))) return false;
    await admin.query(`DROP DATABASE ${quoteIdent(snapshot)} WITH (FORCE)`);
    return true;
  });
}

/**
 * Puts the snapshot back as `database`. The database the failed version used is kept as
 * `<database>_failed_update` (replacing an older one) for support. Run before the server starts.
 */
export async function revertToUpdateSnapshot(options: {
  readonly adminUrl: string;
  readonly database: string;
}): Promise<{ readonly failedDatabase: string | null }> {
  const { adminUrl, database } = options;
  const snapshot = snapshotDatabaseName(database);
  const failed = failedDatabaseName(database);
  return withClient(adminUrl, async (admin) => {
    if (!(await exists(admin, snapshot))) {
      throw new UpdateSnapshotError(
        'NO_SNAPSHOT',
        'There is no copy of the database from before the update.',
      );
    }
    const users = await clientsOf(admin, database);
    if (users.length > 0) {
      throw new UpdateSnapshotError(
        'DATABASE_IN_USE',
        `The database is in use (${users.join(', ')}); it was not switched back.`,
      );
    }
    let kept: string | null = null;
    if (await exists(admin, database)) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(failed)} WITH (FORCE)`);
      await admin.query(`ALTER DATABASE ${quoteIdent(database)} RENAME TO ${quoteIdent(failed)}`);
      kept = failed;
    }
    try {
      await admin.query(`ALTER DATABASE ${quoteIdent(snapshot)} RENAME TO ${quoteIdent(database)}`);
    } catch (error) {
      if (kept !== null) {
        await admin.query(`ALTER DATABASE ${quoteIdent(failed)} RENAME TO ${quoteIdent(database)}`);
      }
      throw error;
    }
    return { failedDatabase: kept };
  });
}

/**
 * The updater's request to go back to the snapshot, written before it installs the previous
 * version again: `%ProgramData%\RestaurantPlatform\update-rollback.json`, which only
 * administrators write. The service host cannot remove it, so it runs each request once by its
 * id, and writes how it went in `<data>/backups/update-rollback-outcome.json` for the updater.
 */
export const UpdateRollbackRequest = z.object({
  format: z.literal(1),
  requestId: z.string().min(1).max(64),
  /** The version that failed. */
  version: z.string().min(1).max(64),
  requestedAt: z.iso.datetime(),
});
export type UpdateRollbackRequest = z.infer<typeof UpdateRollbackRequest>;

export const UpdateRollbackOutcome = z.object({
  requestId: z.string(),
  version: z.string(),
  at: z.iso.datetime(),
  ok: z.boolean(),
  error: z.string().nullable(),
  /** Where the failed version's database is kept. */
  failedDatabase: z.string().nullable(),
});
export type UpdateRollbackOutcome = z.infer<typeof UpdateRollbackOutcome>;

export const updateRollbackRequestPath = (programDataDir: string) =>
  join(programDataDir, 'update-rollback.json');
export const updateRollbackOutcomePath = (dataDir: string) =>
  join(dataDir, 'backups', 'update-rollback-outcome.json');

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    // The updater is Windows PowerShell 5.1, whose UTF-8 may start with a byte order mark.
    const parsed = schema.safeParse(JSON.parse(text.replace(/^\uFEFF/, '')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A rollback request this PC has not run yet, or null. */
export async function pendingUpdateRollback(options: {
  readonly requestFile: string;
  readonly dataDir: string;
}): Promise<UpdateRollbackRequest | null> {
  const request = await readJson(options.requestFile, UpdateRollbackRequest);
  if (request === null) return null;
  const done = await readJson(updateRollbackOutcomePath(options.dataDir), UpdateRollbackOutcome);
  return done?.requestId === request.requestId ? null : request;
}

/** Goes back to the snapshot for `request` and writes how it went, for the updater. */
export async function runUpdateRollback(
  request: UpdateRollbackRequest,
  options: {
    readonly dataDir: string;
    readonly adminUrl: string;
    readonly database: string;
    readonly now?: () => Date;
  },
): Promise<UpdateRollbackOutcome> {
  const now = options.now ?? (() => new Date());
  let outcome: UpdateRollbackOutcome;
  try {
    const { failedDatabase } = await revertToUpdateSnapshot(options);
    outcome = {
      requestId: request.requestId,
      version: request.version,
      at: now().toISOString(),
      ok: true,
      error: null,
      failedDatabase,
    };
  } catch (error) {
    outcome = {
      requestId: request.requestId,
      version: request.version,
      at: now().toISOString(),
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      failedDatabase: null,
    };
  }
  await mkdir(join(options.dataDir, 'backups'), { recursive: true });
  await writeFile(updateRollbackOutcomePath(options.dataDir), JSON.stringify(outcome));
  return outcome;
}

/** Runs a rollback request not run yet (once), or returns null. */
export async function runPendingUpdateRollback(options: {
  readonly requestFile: string;
  readonly dataDir: string;
  readonly adminUrl: string;
  readonly database: string;
  readonly now?: () => Date;
}): Promise<UpdateRollbackOutcome | null> {
  const request = await pendingUpdateRollback(options);
  return request === null ? null : runUpdateRollback(request, options);
}
