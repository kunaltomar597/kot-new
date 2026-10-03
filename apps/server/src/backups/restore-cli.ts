import 'reflect-metadata';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createSecretStore } from '../auth/secret-store.js';
import { type AppConfig, loadConfig } from '../config/app-config.js';
import { verifyBackupFile } from './backup-contents.js';
import { readBackupHeader } from './backup-file.js';
import { runPendingRestore } from './pending-restore.js';
import { parseRecoveryKey } from './recovery-key.js';
import { restoreBackup } from './restore.js';

const USAGE = `Usage:
  node dist/backups/restore-cli.js verify <backup file>
  node dist/backups/restore-cli.js restore <backup file>
  node dist/backups/restore-cli.js pending

verify   checks a backup end to end and says what it holds.
restore  replaces this PC's database, secrets, photos and TLS files with the backup's. Stop the
         restaurant server first. The earlier database is kept as <name>_before_<time>.
pending  runs a restore requested from the System page (the Windows service runs it before the
         server starts).

The backup key is this PC's own unless RP_RECOVERY_KEY (or RP_RECOVERY_KEY_FILE) gives the
Owner's recovery key, for a backup made on another PC. A restore needs RP_ADMIN_DATABASE_URL, a
role that may create and rename databases.
`;

export interface CliOutput {
  write(text: string): void;
}

/** The administrator connection: as configured, or the server's own on the `postgres` database. */
export function adminUrlOf(config: AppConfig): string {
  if (config.adminDatabaseUrl !== undefined) return config.adminDatabaseUrl;
  const url = new URL(config.databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

async function keyFor(config: AppConfig, env: NodeJS.ProcessEnv): Promise<Buffer> {
  const typed =
    env.RP_RECOVERY_KEY_FILE !== undefined && env.RP_RECOVERY_KEY_FILE !== ''
      ? await readFile(env.RP_RECOVERY_KEY_FILE, 'utf8')
      : env.RP_RECOVERY_KEY;
  if (typed === undefined || typed.trim() === '') {
    return createSecretStore(config).get('backup-key');
  }
  const key = parseRecoveryKey(typed);
  if (key === undefined) {
    throw new Error('That recovery key has a mistake in it. Check each group of letters.');
  }
  return key;
}

/** The restore tool (DATA-004, P7-05b). Returns the exit code. */
export async function runRestoreCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: CliOutput,
): Promise<number> {
  const [command, file] = argv;
  const config = loadConfig(env);
  const log = (message: string) => {
    out.write(`${message}\n`);
  };
  if (command === 'verify' && file !== undefined) {
    const header = await readBackupHeader(file);
    const verified = await verifyBackupFile(createReadStream(file), await keyFor(config, env), {
      pgBin: config.pgBin,
      databaseUrl: config.databaseUrl,
    });
    log(`The backup is complete and unchanged (${String(verified.entries.length)} entries).`);
    log(`Made ${verified.info.createdAt} by server ${verified.info.appVersion} (${header.kind}).`);
    log(`Restaurants: ${verified.info.restaurants.map((r) => r.name).join(', ') || 'none'}`);
    return 0;
  }
  if (command === 'restore' && file !== undefined) {
    const result = await restoreBackup({
      file,
      key: await keyFor(config, env),
      databaseUrl: config.databaseUrl,
      adminUrl: adminUrlOf(config),
      dataDir: config.dataDir,
      secrets: createSecretStore(config),
      pgBin: config.pgBin,
      log,
    });
    const seconds = Math.round((result.finishedAt.getTime() - result.startedAt.getTime()) / 1000);
    log(`Restored the backup made ${result.info.createdAt} in ${String(seconds)} s.`);
    if (result.previousDatabase !== null) {
      log(`The database as it was before is kept as ${result.previousDatabase}.`);
    }
    log('Start the restaurant server. Every device refreshes everything when it reconnects.');
    return 0;
  }
  if (command === 'pending') {
    const outcome = await runPendingRestore({
      dataDir: config.dataDir,
      databaseUrl: config.databaseUrl,
      adminUrl: adminUrlOf(config),
      pgBin: config.pgBin,
      secrets: createSecretStore(config),
      log,
    });
    if (outcome === null) log('No restore is waiting.');
    return outcome === null || outcome.ok ? 0 : 1;
  }
  out.write(USAGE);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRestoreCli(process.argv.slice(2), process.env, process.stdout).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
