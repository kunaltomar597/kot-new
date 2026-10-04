import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createSecretStore } from '../auth/secret-store.js';
import {
  databaseUrl,
  defaultInstallationFile,
  inheritedEnvironment,
  type InstallationFile,
  readDatabasePasswords,
  readInstallationFile,
  restoreEnvironment,
  serverEnvironment,
} from '../installation/installation.js';
import { migrate } from '../installation/migrations.js';
import { probeHealth } from './health-probe.js';
import { hostStatePath } from './host-state.js';
import { type HostLog, jsonLog, type PrepareContext, ServiceHost } from './service-host.js';

/**
 * The server's Windows service runs this (P0-16b):
 *
 *   node dist/service/service-host-main.js [--installation <installation.json>]
 */

const dist = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** Where the System page leaves a restore request (`requestPath` in `backups/pending-restore`). */
export function restoreRequestPath(dataDir: string): string {
  return join(dataDir, 'backups', 'restore-request.json');
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Waits until PostgreSQL takes connections (at boot its service may still be starting). */
export async function waitForDatabase(
  url: string,
  signal: AbortSignal,
  log: HostLog,
): Promise<void> {
  let attempts = 0;
  while (!signal.aborted) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch (error) {
      attempts += 1;
      // Once at first, then every half minute, so a long wait does not fill the log.
      if (attempts === 1 || attempts % 30 === 0) {
        log('warn', 'Waiting for the database', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      await client.end().catch(() => undefined);
    }
    await sleep(1_000, signal);
  }
}

/** Runs one of the server's tools with the same Node.js; resolves its exit code. */
function runTool(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code);
    });
  });
}

/** Wait for the database, run a requested restore, apply the migrations. */
export function prepareSteps(
  installation: InstallationFile,
  env: { readonly restore: Readonly<Record<string, string>>; readonly migratorUrl: string },
) {
  return async ({ signal, phase, log }: PrepareContext): Promise<void> => {
    const stopping = () => signal.aborted;
    phase('WAITING_FOR_DATABASE');
    await waitForDatabase(env.migratorUrl, signal, log);
    if (stopping()) return;
    const requested = await access(restoreRequestPath(installation.dataDir)).then(
      () => true,
      () => false,
    );
    if (requested) {
      phase('RESTORING');
      log('info', 'Running the restore asked for on the System page');
      const code = await runTool(dist('backups/restore-cli.js'), ['pending'], env.restore);
      // A failed restore leaves the database as it was and says why on the System page.
      if (code !== 0) log('error', 'The restore did not succeed', { code });
      if (stopping()) return;
    }
    phase('MIGRATING');
    const result = await migrate({
      url: env.migratorUrl,
      log: (message) => {
        log('info', message);
      },
    });
    if (result.changed.length > 0) {
      log('warn', 'Migrations changed after they were applied', { migrations: result.changed });
    }
    if (result.unknown.length > 0) {
      log('warn', 'The database has migrations this version does not know', {
        migrations: result.unknown,
      });
    }
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { installation: { type: 'string' } },
    allowPositionals: false,
  });
  const log = jsonLog();
  const installation = await readInstallationFile(values.installation ?? defaultInstallationFile());
  const secrets = createSecretStore(installation);
  const passwords = await readDatabasePasswords(secrets);
  const inherited = inheritedEnvironment(process.env);
  const host = new ServiceHost({
    serverEntry: dist('main.js'),
    env: { ...inherited, ...serverEnvironment(installation, passwords) },
    stateFile: hostStatePath(installation.dataDir),
    probe: () =>
      probeHealth({
        port: installation.server.port,
        caFile: join(installation.dataDir, 'tls', 'ca.crt'),
      }),
    prepare: prepareSteps(installation, {
      restore: { ...inherited, ...restoreEnvironment(installation, passwords) },
      migratorUrl: databaseUrl(installation, 'migrator', passwords),
    }),
    execArgv: ['--enable-source-maps'],
    log,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void host.stop().finally(() => process.exit(0));
  };
  // WinSW stops the service with Ctrl+C (SIGINT); Ctrl+Break is SIGBREAK.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, stop);
  log('info', 'Service host started', { pid: process.pid, version: installation.productVersion });
  await host.start();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `The service host failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
