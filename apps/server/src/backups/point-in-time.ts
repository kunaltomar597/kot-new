import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type BaseBackupInfo, walPosition } from '@rp/domain';
import pg from 'pg';
import type { WritableSecretStore } from '../auth/secret-store.js';
import { BackupFileError, backupKeyId, readBackupHeader } from './backup-file.js';
import { pgProgram, runPgTool } from './pg-tools.js';
import { type RestoreResult, restoreBackup } from './restore.js';
import { extractTar } from './tar.js';
import {
  baseFolder,
  listArchive,
  openArchived,
  restoreWalFile,
  WAL_SUFFIX,
  walFolder,
} from './wal-archive.js';

/** Full backup files (P7-05a), for the photos, TLS files and secrets. */
const FULL_PATTERN = /^rp-backup-(\d{8}T\d{6}Z)-(nightly|manual|update)\.rpbk$/;
/** How long the temporary PostgreSQL may take to replay the log. */
const RECOVERY_TIMEOUT_MS = 2 * 60 * 60_000;
const BEYOND_ARCHIVE = 'recovery ended before configured recovery target was reached';

/** Why a restore to a point in time could not start. */
export class PointInTimeError extends Error {
  constructor(
    readonly code: 'NO_BASE_BACKUP' | 'NO_FULL_BACKUP' | 'RECOVERY_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'PointInTimeError';
  }
}

export interface PointInTimeOptions {
  /** The moment to go back to; null brings back everything archived. */
  readonly to: Date | null;
  /** Archive roots, best first: the data drive's backup folder, the second location's. */
  readonly roots: readonly string[];
  /** Folders holding full backups, for the photos, TLS files and secrets. */
  readonly fullBackupFolders: readonly string[];
  readonly key: Buffer;
  readonly databaseUrl: string;
  readonly adminUrl: string;
  readonly dataDir: string;
  readonly secrets: WritableSecretStore;
  readonly pgBin: string | undefined;
  readonly requestedBy?: { readonly staffId: string; readonly deviceId: string | null } | null;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export interface PointInTimeResult extends RestoreResult {
  /** The last change brought back (the last transaction replayed); null when there was none. */
  readonly restoredTo: Date | null;
  /** False when the archive ended before the moment asked for: everything archived came back. */
  readonly reachedTarget: boolean;
  readonly baseBackup: string;
}

interface Located {
  readonly base: BaseBackupInfo;
  readonly file: string;
  /** Every archived WAL file of its cluster, by name, from the best root that has it. */
  readonly wal: ReadonlyMap<string, string>;
}

function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
    .toLowerCase();
}

/** A time as PostgreSQL's recovery_target_time reads it (it refuses ISO's `T` and `Z`). */
function pgTimestamp(date: Date): string {
  return `${date.toISOString().replace('T', ' ').replace('Z', '')}+00`;
}

/** A path for postgresql.conf: forward slashes, quotes and backslashes escaped. */
function confPath(path: string): string {
  return path.replaceAll('\\', '/').replaceAll("'", "''");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** The last lines PostgreSQL logged as errors, for the message people see. */
function problemsIn(log: string): string {
  return log
    .split(/\r?\n/)
    .filter(
      (line) =>
        /\b(FATAL|PANIC|ERROR):/.test(line) ||
        /syntax error|invalid value|unrecognized configuration/.test(line),
    )
    .slice(-3)
    .map((line) => line.replace(/^.*?\b(FATAL|PANIC|ERROR|LOG):\s*/, '$1: '))
    .join(' ')
    .slice(0, 400);
}

/** Runs a program to its exit (pg_ctl leaves the server running in the background). */
async function run(program: string, args: readonly string[]): Promise<void> {
  const child = spawn(program, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    stderr = (stderr + text).slice(-4000);
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${program} failed (exit ${String(code)}): ${stderr.trim()}`));
    });
  });
}

/** The base backup to start from and the log after it, across the archive roots. */
export async function locateRecovery(roots: readonly string[], to: Date | null): Promise<Located> {
  const bases = new Map<string, { base: BaseBackupInfo; file: string }>();
  const wal = new Map<string, Map<string, string>>();
  for (const root of roots) {
    const systems = await listArchive(root).catch(() => []);
    for (const system of systems) {
      for (const base of system.bases) {
        const key = `${system.systemId}/${base.name}`;
        if (!bases.has(key)) {
          bases.set(key, { base, file: join(baseFolder(root, system.systemId), base.name) });
        }
      }
      const files = wal.get(system.systemId) ?? new Map<string, string>();
      for (const name of system.wal) {
        if (!files.has(name)) {
          files.set(name, join(walFolder(root, system.systemId), `${name}${WAL_SUFFIX}`));
        }
      }
      wal.set(system.systemId, files);
    }
  }
  const usable = [...bases.values()]
    .filter(({ base }) => to === null || base.endAt.getTime() <= to.getTime())
    .sort((a, b) => a.base.endAt.getTime() - b.base.endAt.getTime());
  const chosen = usable.at(-1);
  if (chosen === undefined) {
    throw new PointInTimeError(
      'NO_BASE_BACKUP',
      to === null
        ? 'There is no base backup to restore from.'
        : 'There is no base backup from before that time: choose a later time or a nightly backup.',
    );
  }
  return {
    base: chosen.base,
    file: chosen.file,
    wal: wal.get(chosen.base.systemId) ?? new Map<string, string>(),
  };
}

/** The newest full backup made with this key at or before `at`; else the oldest one there is. */
export async function fullBackupFor(
  folders: readonly string[],
  at: Date,
  key: Buffer,
): Promise<string> {
  const keyId = backupKeyId(key);
  const found: { file: string; takenAt: string }[] = [];
  for (const folder of folders) {
    const names = await readdir(folder).catch(() => []);
    for (const name of names) {
      const stamp = FULL_PATTERN.exec(name)?.[1];
      if (stamp === undefined) continue;
      const file = join(folder, name);
      const header = await readBackupHeader(file).catch((error: unknown) => {
        if (error instanceof BackupFileError) return null;
        throw error;
      });
      if (header?.keyId === keyId) found.push({ file, takenAt: header.createdAt });
    }
  }
  found.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const before = found.filter((entry) => new Date(entry.takenAt).getTime() <= at.getTime());
  const chosen = before.at(-1) ?? found[0];
  if (chosen === undefined) {
    throw new PointInTimeError(
      'NO_FULL_BACKUP',
      'There is no nightly backup to take the photos and keys from.',
    );
  }
  return chosen.file;
}

/**
 * Restores the database to a moment (DATA-004, P7-05c), the same PC or a new one:
 *
 * 1. finds the newest base backup that finished before the moment, and the log after it;
 * 2. unpacks it into a private folder and decrypts the log beside it;
 * 3. starts a temporary PostgreSQL on it (loopback only, a free port) that replays the log up to
 *    the moment and then stops replaying. When the archive ends sooner, everything archived
 *    comes back and the result says so;
 * 4. dumps the database it recovered and stops it;
 * 5. restores that dump as P7-05b does (into a new database, then switched in), with the photos,
 *    TLS files and secrets of the nightly backup from before the moment.
 *
 * Nothing on the PC changes before step 5, which undoes itself on failure.
 */
export async function restorePointInTime(options: PointInTimeOptions): Promise<PointInTimeResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const located = await locateRecovery(options.roots, options.to);
  const fullBackup = await fullBackupFor(
    options.fullBackupFolders,
    options.to ?? now(),
    options.key,
  );
  const work = join(options.dataDir, `.pitr-${stampOf(now())}`);
  const pgdata = join(work, 'pgdata');
  const walDir = join(work, 'wal');
  const dump = join(work, 'database.dump');
  let attempt = 0;
  let recoveryLog = join(work, 'recovery-0.log');
  const pgCtl = pgProgram('pg_ctl', options.pgBin);
  const admin = new URL(options.adminUrl);
  const database = decodeURIComponent(new URL(options.databaseUrl).pathname.replace(/^\//, ''));
  /** Whether the temporary PostgreSQL is running (an object: closures change it). */
  const server = { running: false };

  await rm(work, { recursive: true, force: true });
  await mkdir(walDir, { recursive: true, mode: 0o700 });
  try {
    log(`Unpacking the base backup ${located.base.name}`);
    await extractTar(openArchived(located.file, options.key), pgdata);

    log('Decrypting the log after it');
    const from = walPosition(located.base.startSegment) ?? '';
    for (const [name, file] of located.wal) {
      const position = walPosition(name);
      if (position !== null && position < from) continue;
      await restoreWalFile({ file, key: options.key, target: join(walDir, name) });
    }
    const fetch = join(work, 'fetch-wal.cjs');
    await writeFile(
      fetch,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const [name, target] = process.argv.slice(2);',
        "try { fs.copyFileSync(path.join(__dirname, 'wal', name), target); }",
        'catch { process.exit(1); }',
        '',
      ].join('\n'),
    );

    const port = await freePort();
    const settings = (target: Date | null) =>
      [
        '',
        '# Point-in-time recovery by the restore tool (P7-05c).',
        "listen_addresses = '127.0.0.1'",
        `port = ${String(port)}`,
        "unix_socket_directories = ''",
        'archive_mode = off',
        'logging_collector = off',
        'hot_standby = on',
        `restore_command = '"${confPath(process.execPath)}" "${confPath(fetch)}" "%f" "%p"'`,
        "recovery_target_action = 'promote'",
        ...(target === null ? [] : [`recovery_target_time = '${pgTimestamp(target)}'`]),
        '',
      ].join('\n');
    const autoConf = join(pgdata, 'postgresql.auto.conf');
    const original = await readFile(autoConf, 'utf8').catch(() => '');
    // Only this restore connects, from this PC, while it runs.
    await writeFile(join(pgdata, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n');
    await writeFile(join(pgdata, 'recovery.signal'), '');

    const query = async <T extends pg.QueryResultRow>(sql: string): Promise<T[]> => {
      const client = new pg.Client({
        host: '127.0.0.1',
        port,
        user: decodeURIComponent(admin.username) || 'postgres',
        database,
        connectionTimeoutMillis: 5_000,
      });
      await client.connect();
      try {
        return (await client.query<T>(sql)).rows;
      } finally {
        await client.end();
      }
    };
    const recover = async (target: Date | null): Promise<'DONE' | 'BEYOND_ARCHIVE'> => {
      await writeFile(autoConf, original + settings(target));
      // A log of its own for each attempt, so the last one's messages are not read again.
      attempt += 1;
      recoveryLog = join(work, `recovery-${String(attempt)}.log`);
      await writeFile(recoveryLog, '');
      try {
        server.running = true;
        await run(pgCtl, ['-D', pgdata, '-l', recoveryLog, '-w', '-t', '600', 'start']);
      } catch (error) {
        server.running = false;
        const text = await readFile(recoveryLog, 'utf8');
        if (text.includes(BEYOND_ARCHIVE)) return 'BEYOND_ARCHIVE';
        throw new PointInTimeError(
          'RECOVERY_FAILED',
          `The recovery did not start: ${problemsIn(text) || String(error)}`,
        );
      }
      const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
      for (;;) {
        const inRecovery = await query<{ r: boolean }>('SELECT pg_is_in_recovery() AS r').catch(
          () => null,
        );
        if (inRecovery?.[0]?.r === false) return 'DONE';
        const text = await readFile(recoveryLog, 'utf8');
        if (text.includes(BEYOND_ARCHIVE)) {
          server.running = false;
          return 'BEYOND_ARCHIVE';
        }
        if (inRecovery === null && /FATAL|PANIC/.test(text) && text.includes('shut down')) {
          server.running = false;
          throw new PointInTimeError(
            'RECOVERY_FAILED',
            `The recovery stopped: ${problemsIn(text)}`,
          );
        }
        if (Date.now() > deadline) {
          throw new PointInTimeError('RECOVERY_FAILED', 'The recovery took too long.');
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    log(
      options.to === null
        ? 'Replaying the log to its end'
        : `Replaying the log to ${options.to.toISOString()}`,
    );
    let reachedTarget = true;
    if ((await recover(options.to)) === 'BEYOND_ARCHIVE') {
      reachedTarget = false;
      log('The archive ends before that time: bringing back everything archived');
      if ((await recover(null)) === 'BEYOND_ARCHIVE') {
        throw new PointInTimeError('RECOVERY_FAILED', 'The recovery could not finish.');
      }
    }
    const [replayed] = await query<{ at: Date | null }>(
      'SELECT pg_last_xact_replay_timestamp() AS at',
    );
    const restoredTo = replayed?.at ?? null;

    log('Taking the recovered database out');
    const recoveredUrl = new URL(`postgresql://127.0.0.1:${String(port)}/`);
    recoveredUrl.username = admin.username || 'postgres';
    recoveredUrl.pathname = `/${encodeURIComponent(database)}`;
    const dumping = runPgTool(
      pgProgram('pg_dump', options.pgBin),
      ['--format=custom', '--no-owner', '--no-password', `--file=${dump}`],
      recoveredUrl.toString(),
    );
    dumping.stdin.end();
    dumping.stdout.resume();
    await dumping.done;
    await run(pgCtl, ['-D', pgdata, '-m', 'fast', '-w', 'stop']);
    server.running = false;
    await rm(pgdata, { recursive: true, force: true });
    await rm(walDir, { recursive: true, force: true });

    const result = await restoreBackup({
      file: fullBackup,
      key: options.key,
      databaseUrl: options.databaseUrl,
      adminUrl: options.adminUrl,
      dataDir: options.dataDir,
      secrets: options.secrets,
      pgBin: options.pgBin,
      databaseDump: dump,
      restoredTo,
      ...(options.requestedBy !== undefined && { requestedBy: options.requestedBy }),
      now,
      log,
    });
    return { ...result, restoredTo, reachedTarget, baseBackup: located.base.name };
  } finally {
    if (server.running) {
      await run(pgCtl, ['-D', pgdata, '-m', 'immediate', '-w', 'stop']).catch(() => undefined);
    }
    await rm(work, { recursive: true, force: true });
  }
}
