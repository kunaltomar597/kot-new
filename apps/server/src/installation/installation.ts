import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { LocalSecretStore, SecretStoreKind } from '../auth/secret-store.js';

/**
 * The installation file (P0-16b): what the installer chose for this PC, read by the service host
 * and the watchdog. It holds no secret; the database passwords are in the secret store. On the
 * restaurant PC it is `%ProgramData%\RestaurantPlatform\installation.json`, writable only by
 * administrators.
 */

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const Port = z.int().min(1).max(65_535);
const HttpsUrl = z.url({ protocol: /^https$/ });

export const InstallationFile = z.strictObject({
  format: z.literal(1),
  /**
   * The product's programs (Program Files): `node`, `server`, `console`, `apps`, `postgres`,
   * `services`.
   */
  installDir: z.string().min(1),
  /** The folder on the data drive (ONB-002): database, photos, backups, logs, secrets. */
  dataDir: z.string().min(1),
  /** The installed product's version (`RESTAURANT_PC`), reported to the Control Plane. */
  productVersion: z.string().min(1).max(64),
  /** `dpapi` on the restaurant PC; `file` only for tests off Windows. */
  secretStore: z.enum(['file', 'dpapi']).default('dpapi'),
  server: z
    .strictObject({
      port: Port.default(8080),
      mqttPort: Port.default(8883),
      logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
      /** Extra names for the LAN certificate, e.g. `pos.local`. */
      tlsHostnames: z.array(z.string().regex(HOSTNAME)).default([]),
    })
    .prefault({}),
  postgres: z
    .strictObject({
      port: Port.default(5432),
      database: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,62}$/)
        .default('restaurant'),
    })
    .prefault({}),
  /** The vendor's services, from the build that made the installer; unset ones stay off. */
  cloud: z
    .strictObject({
      controlPlaneUrl: HttpsUrl.optional(),
      relayUrl: HttpsUrl.optional(),
      qrSiteUrl: HttpsUrl.optional(),
      errorDsn: HttpsUrl.optional(),
    })
    .prefault({}),
  /**
   * How updates are checked before they install (UPD-007, P7-04c), from the build that made the
   * installer: the Authenticode signer every installer must carry (the code-signing certificate's
   * subject). A build without a certificate has none; its updates are refused unless
   * `allowUnsigned` (test builds only, never a signed release).
   */
  updates: z
    .strictObject({
      publisher: z.string().min(3).max(500).nullable().default(null),
      allowUnsigned: z.boolean().default(false),
    })
    .prefault({}),
});
export type InstallationFile = z.infer<typeof InstallationFile>;

/** The Windows services' names (P0-16b). */
export const SERVICE_NAMES = {
  database: 'RPDatabase',
  server: 'RPServer',
  watchdog: 'RPWatchdog',
} as const;

/**
 * The updater's scheduled task (P7-04c): runs `Update-RestaurantPlatform.ps1` as SYSTEM. The
 * installer registers it; the watchdog starts it when the server leaves an update request.
 */
export const UPDATER_TASK = '\\RestaurantPlatform\\Update';

/** Where everything is, from the installation file (the layout P0-16d packages). */
export interface InstallationPaths {
  readonly node: string;
  readonly serverDir: string;
  readonly consoleDir: string;
  /** The release's phone and tablet APKs and their `apps.json` (P7-04e2). */
  readonly appsDir: string;
  readonly pgBin: string;
  readonly pgData: string;
  readonly servicesDir: string;
  readonly logsDir: string;
  /** The service host's state file and the maintenance flag. */
  readonly runDir: string;
  readonly secretsDir: string;
  /** The LAN CA and certificates; `ca.crt` there is what the POS window pins (P0-16a). */
  readonly tlsDir: string;
  readonly backupsDir: string;
  readonly walStaging: string;
  /** Downloaded updates, written by the server and checked again by the updater (P7-04c). */
  readonly updatesDir: string;
}

export function installationPaths(installation: InstallationFile): InstallationPaths {
  const { installDir, dataDir } = installation;
  const exe = process.platform === 'win32' ? '.exe' : '';
  return {
    node: join(installDir, 'node', `node${exe}`),
    serverDir: join(installDir, 'server'),
    consoleDir: join(installDir, 'console'),
    appsDir: join(installDir, 'apps'),
    pgBin: join(installDir, 'postgres', 'bin'),
    pgData: join(dataDir, 'postgres'),
    servicesDir: join(installDir, 'services'),
    logsDir: join(dataDir, 'logs'),
    runDir: join(dataDir, 'run'),
    secretsDir: join(dataDir, 'secrets'),
    tlsDir: join(dataDir, 'tls'),
    backupsDir: join(dataDir, 'backups'),
    walStaging: join(dataDir, 'backups', 'wal-staging'),
    updatesDir: join(dataDir, 'updates'),
  };
}

/** The installation file's usual place. */
export function defaultInstallationFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.ProgramData ?? 'C:\\ProgramData', 'RestaurantPlatform', 'installation.json');
}

/**
 * `%ProgramData%\RestaurantPlatform`, beside the installation file: administrators write it,
 * everyone reads it. The updater's outcome and rollback request are there (P7-04c).
 */
export function programDataDir(installationFile: string = defaultInstallationFile()): string {
  return dirname(installationFile);
}

export async function readInstallationFile(path: string): Promise<InstallationFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No installation file at ${path}. Run the installer's repair.`, {
        cause: error,
      });
    }
    throw error;
  }
  const parsed = InstallationFile.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
      .join('; ');
    throw new Error(`The installation file ${path} is not valid: ${problems}`);
  }
  return parsed.data;
}

/** Written beside it, then renamed over it, so a reader never sees half a file. */
export async function writeInstallationFile(
  path: string,
  installation: z.input<typeof InstallationFile>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const checked = InstallationFile.parse(installation);
  await writeFile(`${path}.new`, `${JSON.stringify(checked, null, 2)}\n`);
  await rename(`${path}.new`, path);
}

/** The database logins the installer makes (P0-16b), each with its password in the secret store. */
export const DATABASE_LOGINS = {
  /** The cluster's superuser, from `initdb`: set-up, restore. Never given to the server. */
  admin: { role: 'rp_admin', secret: 'db-admin-password' },
  /** Runs the migrations; its sessions act as `rp_owner`, which owns the schema. */
  migrator: { role: 'rp_migrator', secret: 'db-migrator-password' },
  /** The server at run time, a member of `rp_app` (AUD-004). */
  server: { role: 'rp_server', secret: 'db-server-password' },
  /** Archive-then-purge only, a member of `rp_purge` (DATA-008, P7-06b). */
  purger: { role: 'rp_purger', secret: 'db-purger-password' },
  /** The continuous backup: replication and `pg_switch_wal()` (P7-05c). */
  backup: { role: 'rp_backup', secret: 'db-backup-password' },
} as const;
export type DatabaseLogin = keyof typeof DATABASE_LOGINS;

/** A login's password: its secret in base64url, nothing a connection string must escape. */
export function databasePassword(secret: Buffer): string {
  return secret.toString('base64url');
}

export type DatabasePasswords = Readonly<Record<DatabaseLogin, string>>;

export async function readDatabasePasswords(secrets: LocalSecretStore): Promise<DatabasePasswords> {
  const entries = await Promise.all(
    (Object.keys(DATABASE_LOGINS) as DatabaseLogin[]).map(
      async (login) =>
        [login, databasePassword(await secrets.get(DATABASE_LOGINS[login].secret))] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<DatabaseLogin, string>;
}

/** A connection string to PostgreSQL on this PC (DATA-001: localhost only). */
export function databaseUrl(
  installation: InstallationFile,
  login: DatabaseLogin,
  passwords: DatabasePasswords,
  database: string = installation.postgres.database,
): string {
  const url = new URL('postgresql://127.0.0.1');
  url.port = String(installation.postgres.port);
  url.username = DATABASE_LOGINS[login].role;
  url.password = passwords[login];
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * The server's environment (see `loadConfig`), from the installation file and the passwords. The
 * administrator's login is never in it; only the restore tool gets that (`restoreEnvironment`).
 */
export function serverEnvironment(
  installation: InstallationFile,
  passwords: DatabasePasswords,
): Record<string, string> {
  const paths = installationPaths(installation);
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: String(installation.server.port),
    DATABASE_URL: databaseUrl(installation, 'server', passwords),
    RP_DATA_DIR: installation.dataDir,
    RP_CONSOLE_DIR: paths.consoleDir,
    RP_APPS_DIR: paths.appsDir,
    RP_PG_BIN: paths.pgBin,
    RP_TLS: 'on',
    RP_MQTT_PORT: String(installation.server.mqttPort),
    RP_SECRET_STORE: installation.secretStore satisfies SecretStoreKind,
    RP_PRODUCT_VERSION: installation.productVersion,
    RP_PURGE_DATABASE_URL: databaseUrl(installation, 'purger', passwords),
    RP_BACKUP_DATABASE_URL: databaseUrl(installation, 'backup', passwords, 'postgres'),
    LOG_LEVEL: installation.server.logLevel,
  };
  if (installation.server.tlsHostnames.length > 0) {
    env.RP_TLS_HOSTNAMES = installation.server.tlsHostnames.join(',');
  }
  if (installation.updates.publisher !== null) {
    env.RP_UPDATE_PUBLISHER = installation.updates.publisher;
  }
  if (installation.updates.allowUnsigned) env.RP_UPDATE_ALLOW_UNSIGNED = 'on';
  const { controlPlaneUrl, relayUrl, qrSiteUrl, errorDsn } = installation.cloud;
  if (controlPlaneUrl !== undefined) env.RP_CONTROL_PLANE_URL = controlPlaneUrl;
  if (relayUrl !== undefined) env.RP_RELAY_URL = relayUrl;
  if (qrSiteUrl !== undefined) env.RP_QR_SITE_URL = qrSiteUrl;
  if (errorDsn !== undefined) env.RP_ERROR_DSN = errorDsn;
  return env;
}

/** The restore tool's environment: the server's, with the administrator's login (P7-05b). */
export function restoreEnvironment(
  installation: InstallationFile,
  passwords: DatabasePasswords,
): Record<string, string> {
  return {
    ...serverEnvironment(installation, passwords),
    RP_ADMIN_DATABASE_URL: databaseUrl(installation, 'admin', passwords, 'postgres'),
  };
}

/**
 * What a child process inherits from the host: the system's own variables, without any of ours a
 * person may have set by hand (an administrator's login must never reach the server).
 */
export function inheritedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const ours = /^(RP_|DATABASE_URL$|NODE_ENV$|HOST$|PORT$|LOG_)/;
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !ours.test(entry[0]),
    ),
  );
}
