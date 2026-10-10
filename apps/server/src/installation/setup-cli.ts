import { access, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createSecretStore } from '../auth/secret-store.js';
import { probeHealth } from '../service/health-probe.js';
import { hostStatePath, readHostState } from '../service/host-state.js';
import {
  endMaintenance,
  maintenancePath,
  readMaintenance,
  startMaintenance,
} from '../service/maintenance.js';
import { WindowsServiceControl } from '../service/windows-services.js';
import { dataDeletionAllowedUntil, readDataDeletionPermission } from './data-deletion.js';
import { setupDatabase } from './database-setup.js';
import {
  databaseUrl,
  defaultInstallationFile,
  InstallationFile,
  installationPaths,
  readDatabasePasswords,
  readInstallationFile,
  SERVICE_NAMES,
  writeInstallationFile,
} from './installation.js';
import { migrate } from './migrations.js';
import {
  initPostgres,
  pgCtlRegisterArgs,
  pgServiceAccountArgs,
  runProgram,
} from './postgres-setup.js';
import { createUpdateSnapshot, dropUpdateSnapshot } from './update-snapshot.js';
import { writeServiceDefinitions } from './winsw.js';

const USAGE = `Usage: node dist/installation/setup-cli.js <command> [--installation <file>] [options]

The installer runs these in order; each can run again (repair) without losing data.

write-installation  writes the installation file. Options: --install-dir, --data-dir,
                    --product-version, --port, --mqtt-port, --pg-port, --control-plane-url,
                    --relay-url, --qr-site-url, --error-dsn, --tls-hostnames (comma-separated),
                    --update-publisher (the signer updates must carry), --update-issuer (its certificate's issuer), --allow-unsigned-updates
                    on|off (test builds only). On repair, values not given are kept.
secrets             makes the secrets that are missing (Windows DPAPI on the restaurant PC).
postgres-init       creates PostgreSQL's data folder on the data drive if there is none, and
                    writes its settings (localhost only, UTC, WAL archiving) and pg_hba.conf.
postgres-register   registers the database service (Windows; skipped when it exists).
database            makes the logins and the database (PostgreSQL must be running).
migrate             applies the pending migrations.
service-files       writes the WinSW definitions of the server and watchdog services.
maintenance on|off  while on (--minutes, at most 240; --reason), the watchdog leaves the services
                    alone.
status              prints the service host's state and the maintenance flag.
health              asks the server for its health check over TLS; prints it with the host's
                    state as JSON. Exit code 0 when the server runs and answers ok, 1 when not.
update-snapshot create|drop
                    copies the database before an update (the server must be stopped), or drops
                    the copy once the new version is healthy (the updater, P7-04c).
paths               prints the folders, ports and service names as JSON (the set-up scripts').
data-deletion       whether the Owner allowed the uninstaller to delete the data (System page),
                    as JSON; exit code 0 when allowed, 3 when not.

The installation file is ${defaultInstallationFile()} unless --installation names another.
`;

export interface CliOutput {
  write(text: string): void;
}

const OPTIONS = {
  installation: { type: 'string' },
  'install-dir': { type: 'string' },
  'data-dir': { type: 'string' },
  'product-version': { type: 'string' },
  port: { type: 'string' },
  'mqtt-port': { type: 'string' },
  'pg-port': { type: 'string' },
  'control-plane-url': { type: 'string' },
  'relay-url': { type: 'string' },
  'qr-site-url': { type: 'string' },
  'error-dsn': { type: 'string' },
  'tls-hostnames': { type: 'string' },
  'update-publisher': { type: 'string' },
  'update-issuer': { type: 'string' },
  'allow-unsigned-updates': { type: 'string' },
  'secret-store': { type: 'string' },
  minutes: { type: 'string' },
  reason: { type: 'string' },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values'];

const port = (value: string | undefined) => (value === undefined ? undefined : Number(value));

function onOff(value: string, option: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`${option} takes on or off`);
}

/** The installation file from the options, over the one already there (repair). */
async function installationFrom(path: string, values: Values): Promise<InstallationFile> {
  const existing = await access(path).then(
    () => readInstallationFile(path),
    () => undefined,
  );
  const cloud = { ...existing?.cloud };
  if (values['control-plane-url'] !== undefined)
    cloud.controlPlaneUrl = values['control-plane-url'];
  if (values['relay-url'] !== undefined) cloud.relayUrl = values['relay-url'];
  if (values['qr-site-url'] !== undefined) cloud.qrSiteUrl = values['qr-site-url'];
  if (values['error-dsn'] !== undefined) cloud.errorDsn = values['error-dsn'];
  const parsed = InstallationFile.safeParse({
    format: 1,
    installDir: values['install-dir'] ?? existing?.installDir,
    dataDir: values['data-dir'] ?? existing?.dataDir,
    productVersion: values['product-version'] ?? existing?.productVersion,
    secretStore:
      values['secret-store'] ??
      existing?.secretStore ??
      (process.platform === 'win32' ? 'dpapi' : 'file'),
    server: {
      port: port(values.port) ?? existing?.server.port,
      mqttPort: port(values['mqtt-port']) ?? existing?.server.mqttPort,
      logLevel: existing?.server.logLevel,
      tlsHostnames:
        values['tls-hostnames'] === undefined
          ? existing?.server.tlsHostnames
          : values['tls-hostnames']
              .split(',')
              .map((name) => name.trim().toLowerCase())
              .filter((name) => name !== ''),
    },
    postgres: {
      port: port(values['pg-port']) ?? existing?.postgres.port,
      database: existing?.postgres.database,
    },
    cloud,
    updates: {
      publisher: values['update-publisher'] ?? existing?.updates.publisher,
      issuer: values['update-issuer'] ?? existing?.updates.issuer,
      allowUnsigned:
        values['allow-unsigned-updates'] === undefined
          ? existing?.updates.allowUnsigned
          : onOff(values['allow-unsigned-updates'], '--allow-unsigned-updates'),
    },
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
      .join('; ');
    throw new Error(`The installation settings are not valid: ${problems}`);
  }
  return parsed.data;
}

/** The set-up tool (P0-16b). Returns the exit code. */
export async function runSetupCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: CliOutput,
): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (error) {
    out.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, argument] = positionals;
  const file = values.installation ?? defaultInstallationFile(env);
  const log = (message: string) => {
    out.write(`${message}\n`);
  };

  if (command === 'write-installation') {
    const installation = await installationFrom(file, values);
    await writeInstallationFile(file, installation);
    log(`Wrote ${file}`);
    return 0;
  }
  if (command === undefined || command === 'help') {
    out.write(USAGE);
    return command === undefined ? 2 : 0;
  }

  const installation = await readInstallationFile(file);
  const secrets = createSecretStore(installation);
  const paths = installationPaths(installation);

  switch (command) {
    case 'secrets': {
      const created = await secrets.ensure();
      log(created.length === 0 ? 'Every secret is there.' : `Made ${created.join(', ')}.`);
      return 0;
    }
    case 'postgres-init': {
      const passwords = await readDatabasePasswords(secrets);
      const created = await initPostgres(installation, passwords.admin);
      log(
        created
          ? `Created PostgreSQL's data folder ${paths.pgData}.`
          : `PostgreSQL's data folder ${paths.pgData} is there; its settings were written again.`,
      );
      return 0;
    }
    case 'postgres-register': {
      if (process.platform !== 'win32') {
        log('Registering the database service needs Windows.');
        return 1;
      }
      if ((await new WindowsServiceControl().state(SERVICE_NAMES.database)) !== 'MISSING') {
        // An installation from before PC-I6 ran it as Network Service: the installer has already
        // given the new account its folders and stopped the service, so only the account changes.
        const moved = await runProgram('sc.exe', pgServiceAccountArgs());
        log(
          moved.code === 0
            ? `The ${SERVICE_NAMES.database} service is registered and runs under its own account.`
            : `The ${SERVICE_NAMES.database} service is registered; its account was not changed: ${moved.output.trim()}`,
        );
        return moved.code === 0 ? 0 : 1;
      }
      const result = await runProgram(
        join(paths.pgBin, 'pg_ctl.exe'),
        pgCtlRegisterArgs(installation),
      );
      log(result.output.trim());
      return result.code === 0 ? 0 : 1;
    }
    case 'database': {
      const passwords = await readDatabasePasswords(secrets);
      const result = await setupDatabase({
        adminUrl: databaseUrl(installation, 'admin', passwords, 'postgres'),
        database: installation.postgres.database,
        passwords,
      });
      log(
        result.databaseCreated
          ? `Created the database ${installation.postgres.database} and its logins.`
          : 'The database is there; its logins were brought up to date.',
      );
      return 0;
    }
    case 'migrate': {
      const passwords = await readDatabasePasswords(secrets);
      const result = await migrate({ url: databaseUrl(installation, 'migrator', passwords), log });
      log(
        result.applied.length === 0
          ? 'The database is up to date.'
          : `Applied ${String(result.applied.length)} migrations.`,
      );
      if (result.changed.length > 0) log(`Changed since applied: ${result.changed.join(', ')}`);
      if (result.unknown.length > 0) {
        log(`In the database but not in this version: ${result.unknown.join(', ')}`);
      }
      return 0;
    }
    case 'service-files': {
      for (const path of await writeServiceDefinitions(installation, file)) log(`Wrote ${path}`);
      return 0;
    }
    case 'maintenance': {
      const flag = maintenancePath(installation.dataDir);
      if (argument === 'on') {
        const set = await startMaintenance(flag, {
          minutes: Number(values.minutes ?? '30'),
          reason: values.reason ?? 'maintenance',
        });
        log(`The watchdog leaves the services alone until ${set.until}.`);
        return 0;
      }
      if (argument === 'off') {
        await endMaintenance(flag);
        log('The watchdog looks after the services again.');
        return 0;
      }
      out.write(USAGE);
      return 2;
    }
    case 'paths': {
      out.write(
        `${JSON.stringify(
          {
            installationFile: file,
            programDataDir: dirname(file),
            installDir: installation.installDir,
            dataDir: installation.dataDir,
            setupCli: join(paths.serverDir, 'dist', 'installation', 'setup-cli.js'),
            ...paths,
            ports: {
              server: installation.server.port,
              mqtt: installation.server.mqttPort,
              postgres: installation.postgres.port,
            },
            services: SERVICE_NAMES,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    case 'data-deletion': {
      const permission = await readDataDeletionPermission(installation.dataDir);
      const until = dataDeletionAllowedUntil(permission, new Date());
      out.write(
        `${JSON.stringify({
          allowed: until !== null,
          until: until?.toISOString() ?? null,
          allowedBy: until === null ? null : (permission?.allowedBy.staffId ?? null),
        })}\n`,
      );
      return until === null ? 3 : 0;
    }
    case 'health': {
      const [health, host] = await Promise.all([
        probeHealth({ port: installation.server.port, caFile: join(paths.tlsDir, 'ca.crt') }),
        readHostState(hostStatePath(installation.dataDir)),
      ]);
      out.write(
        `${JSON.stringify({
          productVersion: installation.productVersion,
          health,
          phase: host?.phase ?? null,
          serverPid: host?.serverPid ?? null,
          restarts: host?.restarts ?? null,
          lastError: host?.lastError ?? null,
        })}\n`,
      );
      return health === 'ok' && host?.phase === 'RUNNING' ? 0 : 1;
    }
    case 'update-snapshot': {
      const passwords = await readDatabasePasswords(secrets);
      const adminUrl = databaseUrl(installation, 'admin', passwords, 'postgres');
      const database = installation.postgres.database;
      if (argument === 'create') {
        const space = await statfs(installation.dataDir).then(
          (stats) => stats.bavail * stats.bsize,
          () => null,
        );
        const result = await createUpdateSnapshot({ adminUrl, database, freeBytes: space, log });
        log(`Copied the database to ${result.snapshot}.`);
        return 0;
      }
      if (argument === 'drop') {
        log(
          (await dropUpdateSnapshot({ adminUrl, database }))
            ? 'Dropped the copy from before the update.'
            : 'There was no copy from before the update.',
        );
        return 0;
      }
      out.write(USAGE);
      return 2;
    }
    case 'status': {
      const [host, maintenance] = await Promise.all([
        readHostState(hostStatePath(installation.dataDir)),
        readMaintenance(maintenancePath(installation.dataDir), new Date()),
      ]);
      out.write(
        `${JSON.stringify(
          {
            productVersion: installation.productVersion,
            dataDir: installation.dataDir,
            host,
            maintenance,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    default:
      out.write(USAGE);
      return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetupCli(process.argv.slice(2), process.env, process.stdout).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
