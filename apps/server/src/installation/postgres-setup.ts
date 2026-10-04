import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DATABASE_LOGINS,
  type InstallationFile,
  installationPaths,
  SERVICE_NAMES,
} from './installation.js';

/**
 * PostgreSQL 16 on the data drive (DATA-001, ONB-001, P0-16b): `initdb`, the settings the
 * installer owns in `postgresql.conf` and `pg_hba.conf`, and registering the Windows service.
 * Every step can run again (repair) without losing data.
 */

const BEGIN = '# BEGIN Restaurant Platform (written by the installer; repair writes it again)';
const END = '# END Restaurant Platform';

/** A value for postgresql.conf, quoted. */
export function confValue(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

/** Windows paths with forward slashes, which PostgreSQL and Node both read. */
function slashes(path: string): string {
  return path.replaceAll('\\', '/');
}

/** A program for `archive_command`, in double quotes for paths with spaces. */
function quoted(path: string): string {
  if (path.includes('"')) throw new Error(`A path with a double quote cannot be used: ${path}`);
  return `"${slashes(path)}"`;
}

/**
 * The settings the installer owns, appended to `postgresql.conf` (later lines win):
 * - localhost only (DATA-001, SEC-007);
 * - UTC, like every session the server opens (decision 219);
 * - WAL archiving into the server's staging folder for the continuous backup (DATA-002, P7-05c);
 * - its own log, a week of daily files.
 */
export function managedPostgresSettings(installation: InstallationFile): Record<string, string> {
  const paths = installationPaths(installation);
  const archiveCommand = [
    quoted(paths.node),
    quoted(join(paths.serverDir, 'dist', 'backups', 'wal-stage.js')),
    '"%p"',
    '"%f"',
    quoted(paths.walStaging),
  ].join(' ');
  return {
    listen_addresses: 'localhost',
    port: String(installation.postgres.port),
    timezone: 'UTC',
    log_timezone: 'UTC',
    password_encryption: 'scram-sha-256',
    wal_level: 'replica',
    archive_mode: 'on',
    archive_timeout: '3600',
    archive_command: archiveCommand,
    max_wal_senders: '4',
    logging_collector: 'on',
    log_directory: 'log',
    log_filename: 'postgresql-%a.log',
    log_truncate_on_rotation: 'on',
    log_rotation_age: '1d',
    log_rotation_size: '0',
  };
}

/** `postgresql.conf` with the installer's block replaced (or added at the end). */
export function withManagedBlock(conf: string, settings: Record<string, string>): string {
  const block = [
    BEGIN,
    ...Object.entries(settings).map(([key, value]) => `${key} = ${confValue(value)}`),
    END,
  ].join('\n');
  const start = conf.indexOf(BEGIN);
  const end = conf.indexOf(END);
  if (start !== -1 && end > start) {
    return `${conf.slice(0, start)}${block}${conf.slice(end + END.length)}`;
  }
  return `${conf.replace(/\n*$/, '\n')}\n${block}\n`;
}

/**
 * `pg_hba.conf`, all of it: passwords (SCRAM) from this PC only, and replication for the continuous
 * backup's login only.
 */
export function managedHbaConf(): string {
  const backup = DATABASE_LOGINS.backup.role;
  return [
    '# Written by the Restaurant Platform installer; repair writes it again (DATA-001, SEC-007).',
    '# TYPE  DATABASE     USER        ADDRESS        METHOD',
    'local   all          all                        scram-sha-256',
    'host    all          all         127.0.0.1/32   scram-sha-256',
    'host    all          all         ::1/128        scram-sha-256',
    `host    replication  ${backup.padEnd(10)}  127.0.0.1/32   scram-sha-256`,
    `host    replication  ${backup.padEnd(10)}  ::1/128        scram-sha-256`,
    '',
  ].join('\n');
}

/** Writes the installer's settings into an existing cluster's files. */
export async function writePostgresConfig(installation: InstallationFile): Promise<void> {
  const { pgData } = installationPaths(installation);
  const confPath = join(pgData, 'postgresql.conf');
  const conf = await readFile(confPath, 'utf8');
  await writeFile(confPath, withManagedBlock(conf, managedPostgresSettings(installation)));
  await writeFile(join(pgData, 'pg_hba.conf'), managedHbaConf());
}

export interface RunResult {
  readonly code: number | null;
  readonly output: string;
}

/** Runs a program and collects what it printed. */
export function runProgram(
  program: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env ?? process.env,
    });
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, output: Buffer.concat(output).toString('utf8') });
    });
  });
}

function program(bin: string, name: string): string {
  return join(bin, process.platform === 'win32' ? `${name}.exe` : name);
}

/** `initdb`'s arguments: SCRAM everywhere, UTF-8, data checksums, the administrator's name. */
export function initdbArgs(pgData: string, passwordFile: string): string[] {
  return [
    '-D',
    pgData,
    `--username=${DATABASE_LOGINS.admin.role}`,
    `--pwfile=${passwordFile}`,
    '--auth-local=scram-sha-256',
    '--auth-host=scram-sha-256',
    '--encoding=UTF8',
    '--locale=C',
    // Disk errors on a shop PC are found when a page is read, not later in a backup.
    '--data-checksums',
  ];
}

/**
 * Creates the cluster on the data drive if there is none yet, then writes the installer's
 * settings. Returns whether it was created.
 */
export async function initPostgres(
  installation: InstallationFile,
  adminPassword: string,
  options: { readonly pgBin?: string } = {},
): Promise<boolean> {
  const paths = installationPaths(installation);
  const exists = await access(join(paths.pgData, 'PG_VERSION')).then(
    () => true,
    () => false,
  );
  if (!exists) {
    // The password reaches initdb in a file, never on its command line; the file goes at once.
    const passwordFile = join(installation.dataDir, `.pw-${randomUUID()}`);
    await writeFile(passwordFile, `${adminPassword}\n`, { mode: 0o600, flag: 'wx' });
    try {
      const result = await runProgram(
        program(options.pgBin ?? paths.pgBin, 'initdb'),
        initdbArgs(paths.pgData, passwordFile),
      );
      if (result.code !== 0) {
        throw new Error(`initdb failed (exit ${String(result.code)}): ${result.output.trim()}`);
      }
    } finally {
      await rm(passwordFile, { force: true });
    }
  }
  await writePostgresConfig(installation);
  return !exists;
}

/**
 * `pg_ctl register`'s arguments for the database service: started by Windows at boot before anyone
 * signs in (NFR-A04), as Network Service, which owns nothing else of ours.
 */
export function pgCtlRegisterArgs(installation: InstallationFile): string[] {
  return [
    'register',
    '-N',
    SERVICE_NAMES.database,
    '-U',
    'NT AUTHORITY\\NetworkService',
    '-D',
    installationPaths(installation).pgData,
    '-S',
    'auto',
    '-w',
    '-t',
    '300',
  ];
}
