import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import pg from 'pg';
import { BackupContentError } from './backup-contents.js';
import { encryptBackup } from './backup-file.js';
import { pgProgram, runPgTool } from './pg-tools.js';
import { readTar } from './tar.js';
import { baseBackupName, baseFolder, openArchived, syncFile } from './wal-archive.js';

/** What a base backup must hold to be recovered from. */
const REQUIRED = ['backup_label', 'backup_manifest', 'global/pg_control', 'PG_VERSION'];

export interface ClusterPosition {
  /** `pg_control_system()`'s system identifier. */
  readonly systemId: string;
  /** The WAL segment being written now. */
  readonly segment: string;
}

/** Which cluster this is and where its log stands; any role may ask. */
export async function clusterPosition(databaseUrl: string): Promise<ClusterPosition> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ system_id: string; segment: string }>(
      `SELECT system_identifier::text AS system_id,
              pg_walfile_name(pg_current_wal_lsn()) AS segment
         FROM pg_control_system()`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error('PostgreSQL did not say which cluster it is');
    return { systemId: row.system_id, segment: row.segment };
  } finally {
    await client.end();
  }
}

/**
 * Checks a base backup file end to end: every chunk decrypts and authenticates, it decompresses,
 * the tar reads to its end marker, and it holds what recovery needs.
 */
export async function verifyBaseBackup(file: string, key: Buffer): Promise<number> {
  const entries = await readTar(openArchived(file, key), () => undefined);
  const names = new Set(entries.map((entry) => entry.name));
  const missing = REQUIRED.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new BackupContentError(`The base backup is missing ${missing.join(', ')}.`);
  }
  return entries.length;
}

/**
 * Takes a base backup (DATA-002, P7-05c): `pg_basebackup` as one tar on its output, with the WAL
 * it needs (`--wal-method=fetch`), compressed and encrypted on the way to disk, checked in full,
 * then named after when it finished and the first WAL segment it needs.
 */
export async function takeBaseBackup(options: {
  /** The backup role (REPLICATION). */
  readonly backupDatabaseUrl: string;
  readonly pgBin: string | undefined;
  readonly key: Buffer;
  /** The archive root: `<data>/backups` or `<second location>/rp-backups`. */
  readonly root: string;
  readonly appVersion: string;
  readonly now?: () => Date;
}): Promise<{ readonly file: string; readonly systemId: string; readonly sizeBytes: number }> {
  const now = options.now ?? (() => new Date());
  const position = await clusterPosition(options.backupDatabaseUrl);
  const folder = baseFolder(options.root, position.systemId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const partial = join(folder, `rp-base-${String(process.pid)}-${String(Date.now())}.partial`);
  let sizeBytes = 0;
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  const tool = runPgTool(
    pgProgram('pg_basebackup', options.pgBin),
    [
      '--pgdata=-',
      '--format=tar',
      '--wal-method=fetch',
      '--checkpoint=fast',
      '--label=rp-base',
      '--no-password',
    ],
    options.backupDatabaseUrl,
  );
  tool.stdin.end();
  tool.done.catch(() => undefined);
  try {
    await pipeline(
      tool.stdout,
      createGzip({ level: 1 }),
      encryptBackup(options.key, { kind: 'BASE', appVersion: options.appVersion, now: now() }),
      counting,
      createWriteStream(partial, { mode: 0o600 }),
    );
    await tool.done;
    await syncFile(partial);
    await verifyBaseBackup(partial, options.key);
    const file = join(folder, baseBackupName(now(), position.segment));
    await rename(partial, file);
    return { file, systemId: position.systemId, sizeBytes: (await stat(file)).size || sizeBytes };
  } catch (error) {
    tool.stdout.destroy();
    await rm(partial, { force: true });
    throw error;
  }
}
