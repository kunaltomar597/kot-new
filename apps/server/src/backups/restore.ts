import { once } from 'node:events';
import { availableParallelism } from 'node:os';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { SECRET_NAMES, type SecretName, type WritableSecretStore } from '../auth/secret-store.js';
import { readArchive } from './backup-archive.js';
import {
  BackupContentError,
  type BackupInfo,
  BackupSecrets,
  DATABASE_DUMP,
  FILES_PREFIX,
  SECRETS,
  verifyBackupFile,
} from './backup-contents.js';
import { decryptBackup } from './backup-file.js';
import { pgProgram, runPgTool } from './pg-tools.js';

/** Folders under the data folder a backup brings back. */
export const RESTORED_FOLDERS = ['photos', 'tls'] as const;
/** The database roles the dump's grants name (migration `roles_and_protection`). */
const GROUP_ROLES = ['rp_owner', 'rp_app', 'rp_purge'] as const;
/** Where the server learns that a restore happened, to audit it when it starts. */
export const RESTORE_RECORD_KEY = 'backups.last_restore';

export const RestoreRecord = z.object({
  restoredAt: z.iso.datetime(),
  backupCreatedAt: z.iso.datetime(),
  fileName: z.string().nullable(),
  /** For a restore to a point in time (P7-05c): the last change brought back. */
  restoredTo: z.iso.datetime().nullable().default(null),
  requestedBy: z.object({ staffId: z.string(), deviceId: z.string().nullable() }).nullable(),
  audited: z.boolean(),
});
export type RestoreRecord = z.infer<typeof RestoreRecord>;
/** The event stream id: removed so every device refreshes in full (P0-12). */
const STREAM_ID_KEY = 'events.stream_id';

export interface RestoreOptions {
  readonly file: string;
  readonly key: Buffer;
  /** The server's database: replaced by the backup's. */
  readonly databaseUrl: string;
  /** A role that may create, rename and drop databases (the installer's administrator). */
  readonly adminUrl: string;
  readonly dataDir: string;
  readonly secrets: WritableSecretStore;
  readonly pgBin: string | undefined;
  /** The role that owns the restored objects (`rp_owner`). */
  readonly ownerRole?: string;
  /** Who asked, for the audit entry the server writes when it starts. */
  readonly requestedBy?: { readonly staffId: string; readonly deviceId: string | null } | null;
  /**
   * A database dump to restore instead of the backup's own (a point in time, P7-05c); the
   * backup still brings the secrets, photos and TLS files.
   */
  readonly databaseDump?: string;
  /** For a point in time: the last change the dump holds, for the record. */
  readonly restoredTo?: Date | null;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export interface RestoreResult {
  readonly info: BackupInfo;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  /** The database as it was before, kept to go back to; null when it held nothing. */
  readonly previousDatabase: string | null;
}

/** Why a restore stopped before changing anything. */
export class RestoreError extends Error {
  constructor(
    readonly code: 'DATABASE_IN_USE' | 'TOO_NEW' | 'NOT_A_BACKUP',
    message: string,
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
    .toLowerCase();
}

/** Runs a PostgreSQL program to the end and returns what it printed. */
async function textOf(
  program: string,
  args: readonly string[],
  databaseUrl: string,
): Promise<string> {
  const tool = runPgTool(program, args, databaseUrl);
  tool.stdin.end();
  const parts: Buffer[] = [];
  tool.stdout.on('data', (part: Buffer) => parts.push(part));
  await tool.done;
  return Buffer.concat(parts).toString('utf8');
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The longest PostgreSQL identifier. */
const MAX_IDENT = 63;

function nameWith(base: string, suffix: string): string {
  return `${base.slice(0, MAX_IDENT - suffix.length)}${suffix}`;
}

/** Writes an entry to a file in the staging folder. */
function fileSink(path: string) {
  let stream: ReturnType<typeof createWriteStream> | undefined;
  const ready = mkdir(dirname(path), { recursive: true, mode: 0o700 }).then(() => {
    stream = createWriteStream(path, { mode: 0o600 });
  });
  return {
    async write(bytes: Buffer) {
      await ready;
      if (stream !== undefined && !stream.write(bytes)) {
        await once(stream, 'drain');
      }
    },
    async end() {
      await ready;
      await new Promise<void>((resolve, reject) => {
        stream?.end((error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

/**
 * Restores a backup onto this PC (DATA-004, P7-05b), the same one or a new one:
 *
 * 1. checks the whole file (every chunk, the manifest, `pg_restore --list`);
 * 2. unpacks it into a private folder under the data folder;
 * 3. refuses while anything is connected to the database (stop the server first);
 * 4. restores the database into a new one, `<name>_restoring` (in parallel), and removes
 *    the event stream id so every device refreshes in full (P0-12);
 * 5. puts the backup's secrets, photos and TLS files in place, keeping the ones there before;
 * 6. swaps the databases by renaming. The one there before is kept as `<name>_before_<time>`
 *    (dropped when it held no restaurant: a fresh install).
 *
 * A failure before step 6 leaves the PC as it was; steps 5 and 6 undo themselves on failure.
 */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const startedAt = now();
  const stamp = stampOf(startedAt);
  const target = databaseOf(options.databaseUrl);
  const adminUrl =
    databaseOf(options.adminUrl) === target
      ? withDatabase(options.adminUrl, 'postgres')
      : options.adminUrl;
  const restoring = nameWith(target, '_restoring');
  const staging = join(options.dataDir, `.restore-${stamp}`);
  const tool = { pgBin: options.pgBin, databaseUrl: adminUrl };
  const ownerRole = options.ownerRole ?? 'rp_owner';

  log('Checking the backup');
  const { info } = await verifyBackupFile(createReadStream(options.file), options.key, tool);

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const undo: (() => Promise<void>)[] = [];
  try {
    log('Unpacking the backup');
    let secrets: BackupSecrets | undefined;
    await readArchive(createReadStream(options.file).pipe(decryptBackup(options.key)), (name) => {
      if (name === DATABASE_DUMP) {
        if (options.databaseDump === undefined) return fileSink(join(staging, DATABASE_DUMP));
        return { write: () => undefined, end: () => undefined };
      }
      if (name.startsWith(FILES_PREFIX)) return fileSink(join(staging, ...name.split('/')));
      const parts: Buffer[] = [];
      return {
        write: (bytes: Buffer) => {
          if (name === SECRETS) parts.push(bytes);
        },
        end: () => {
          if (name !== SECRETS) return;
          const parsed = BackupSecrets.safeParse(JSON.parse(Buffer.concat(parts).toString('utf8')));
          if (!parsed.success)
            throw new BackupContentError('The backup’s secrets are not readable.');
          secrets = parsed.data;
        },
      };
    });
    if (secrets === undefined) throw new BackupContentError('The backup has no secrets.');

    log('Restoring the database');
    await withClient(adminUrl, async (admin) => {
      const inUse = await admin.query<{ who: string | null }>(
        // People's connections only: PostgreSQL stops autovacuum itself to rename a database.
        `SELECT nullif(application_name, '') AS who FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
        [target],
      );
      if (inUse.rows.length > 0) {
        const who = [...new Set(inUse.rows.map((row) => row.who ?? 'a program'))].join(', ');
        throw new RestoreError(
          'DATABASE_IN_USE',
          `The database is in use (${who}). Stop the restaurant server before restoring.`,
        );
      }
      for (const role of GROUP_ROLES) {
        await admin.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
        );
      }
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(restoring)}`);
      // Owned by the owner role, so it may create in `public` (PostgreSQL 15 and later).
      await admin.query(
        `CREATE DATABASE ${quoteIdent(restoring)} OWNER ${quoteIdent(ownerRole)} TEMPLATE template0 ENCODING 'UTF8'`,
      );
    });
    undo.push(() =>
      withClient(adminUrl, (admin) =>
        admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(restoring)}`).then(() => undefined),
      ),
    );
    const dump = options.databaseDump ?? join(staging, DATABASE_DUMP);
    const restoringUrl = withDatabase(adminUrl, restoring);
    // Everything is restored as the owner role, except the default privileges: those name the
    // role that ran the migrations on the old PC, so they are applied for the owner role below.
    const toc = await textOf(
      pgProgram('pg_restore', options.pgBin),
      ['--list', dump],
      restoringUrl,
    );
    const lines = toc.split(/\r?\n/);
    const isDefaultAcl = (line: string) => line.includes(' DEFAULT ACL ') && !line.startsWith(';');
    await writeFile(
      join(staging, 'objects.list'),
      lines.filter((l) => !isDefaultAcl(l)).join('\n'),
    );
    await writeFile(join(staging, 'defaults.list'), lines.filter(isDefaultAcl).join('\n'));
    await textOf(
      pgProgram('pg_restore', options.pgBin),
      [
        '--no-owner',
        `--role=${ownerRole}`,
        '--exit-on-error',
        // In parallel (P0-16's PC has four cores). A failure leaves only `<name>_restoring`,
        // which is dropped, so one transaction is not needed for safety.
        `--jobs=${String(Math.max(1, Math.min(4, availableParallelism())))}`,
        '--no-password',
        `--use-list=${join(staging, 'objects.list')}`,
        `--dbname=${restoring}`,
        dump,
      ],
      restoringUrl,
    );
    const defaults = await textOf(
      pgProgram('pg_restore', options.pgBin),
      [`--use-list=${join(staging, 'defaults.list')}`, '--file=-', dump],
      restoringUrl,
    );
    await withClient(restoringUrl, async (client) => {
      const statements = defaults
        .split(/\r?\n/)
        .filter((line) => line.startsWith('ALTER DEFAULT PRIVILEGES FOR ROLE '))
        .map((line) =>
          line.replace(
            /^ALTER DEFAULT PRIVILEGES FOR ROLE \S+ /,
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(ownerRole)} `,
          ),
        );
      for (const statement of statements) await client.query(statement);
    });
    await withClient(restoringUrl, async (client) => {
      await client.query('DELETE FROM system_meta WHERE key = $1', [STREAM_ID_KEY]);
      await client.query(
        `INSERT INTO system_meta (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [
          RESTORE_RECORD_KEY,
          JSON.stringify({
            restoredAt: startedAt.toISOString(),
            backupCreatedAt: info.createdAt,
            fileName: options.file.split(/[\\/]/).at(-1) ?? null,
            restoredTo: options.restoredTo?.toISOString() ?? null,
            requestedBy: options.requestedBy ?? null,
            audited: false,
          } satisfies RestoreRecord),
        ],
      );
    });

    log('Putting the secrets and files in place');
    const restored: Partial<Record<SecretName, Buffer>> = {};
    for (const name of SECRET_NAMES) {
      const value = secrets.secrets[name];
      if (name !== 'backup-key' && value !== undefined)
        restored[name] = Buffer.from(value, 'base64');
    }
    undo.push(await options.secrets.replace(restored, `before-restore-${stamp}`));
    for (const folder of RESTORED_FOLDERS) {
      const live = join(options.dataDir, folder);
      const kept = join(options.dataDir, `${folder}.before-restore-${stamp}`);
      const incoming = join(staging, 'files', folder);
      const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
      const hadLive = await rename(live, kept).then(
        () => true,
        (error: unknown) => {
          if (missing(error)) return false;
          throw error;
        },
      );
      // A backup without the folder (no photos yet) restores an empty one.
      await rename(incoming, live).catch(async (error: unknown) => {
        if (!missing(error)) throw error;
        await mkdir(live, { recursive: true });
      });
      undo.push(async () => {
        await rm(live, { recursive: true, force: true });
        if (hadLive) await rename(kept, live);
      });
    }

    log('Switching to the restored database');
    let previous: string | null = null;
    await withClient(adminUrl, async (admin) => {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
      let held = false;
      if ((exists.rowCount ?? 0) > 0) {
        held = await withClient(withDatabase(adminUrl, target), async (client) => {
          const table = await client.query<{ present: boolean }>(
            "SELECT to_regclass('public.restaurants') IS NOT NULL AS present",
          );
          if (table.rows[0]?.present !== true) return false;
          const count = await client.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM restaurants',
          );
          return (count.rows[0]?.n ?? 0) > 0;
        });
        previous = nameWith(target, `_before_${stamp}`);
        await admin.query(`ALTER DATABASE ${quoteIdent(target)} RENAME TO ${quoteIdent(previous)}`);
      }
      await admin.query(`ALTER DATABASE ${quoteIdent(restoring)} RENAME TO ${quoteIdent(target)}`);
      // A fresh install held nothing worth keeping.
      if (previous !== null && !held) {
        await admin.query(`DROP DATABASE ${quoteIdent(previous)}`);
        previous = null;
      }
    });
    await rm(staging, { recursive: true, force: true });
    log('Restored');
    return { info, startedAt, finishedAt: now(), previousDatabase: previous };
  } catch (error) {
    for (const step of undo.reverse()) {
      await step().catch((failure: unknown) => {
        log(`Could not undo a step: ${String(failure)}`);
      });
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
