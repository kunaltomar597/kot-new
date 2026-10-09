import { z } from 'zod';

/**
 * Deployment configuration of the local server, read from environment variables.
 *
 * This is installation-level configuration (ports, database, data directory, logging). Restaurant
 * settings (every ⚙ value in the BRD) live in the database settings registry from P1-01.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `https://host/` → `https://host` (a loop: a regular expression here can backtrack badly). */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charAt(end - 1) === '/') end -= 1;
  return url.slice(0, end);
}

/** `true`/`false`, `1`/`0` or `on`/`off` (the form the docs use, e.g. `RP_TLS=on`). */
const booleanFlag = z
  .enum(['true', 'false', '1', '0', 'on', 'off'])
  .optional()
  .transform((value) => value === 'true' || value === '1' || value === 'on');

export const AppConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  /** Interface the HTTP server binds to. Devices on the staff network connect here. */
  host: z.string().min(1).default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(8080),
  /** PostgreSQL connection string. Must point at this PC in production (DATA-001). */
  databaseUrl: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgresql:// connection string'),
  /** Root folder for photos, backups and other files (ONB-002 data drive). */
  dataDir: z.string().min(1).default('./.data'),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /** Human-readable logs for development; production always logs JSON (NFR-O01). */
  logPretty: booleanFlag,
  /** Git commit or build identifier, reported by GET /api/v1/version. */
  buildId: z.string().max(64).optional(),
  /** Folder of the built web console (`apps/console/dist`), served at `/` when set (P0-14b). */
  consoleDir: z.string().min(1).optional(),
  /**
   * The release's phone and tablet APKs with their `apps.json` (`<install>\\apps`, P7-04e2), set
   * by the installer; unset, the PC offers no APK (development, tests, a release without them).
   */
  appsDir: z.string().min(1).optional(),
  /**
   * The Vendor Control Plane (ADR-0012), e.g. `https://control-plane.example.com`. Unset: no
   * cloud calls (development, tests, a site that is not activated yet).
   */
  controlPlaneUrl: z
    .url({ protocol: /^https?$/ })
    .refine((url) => {
      // Requests are signed over their path, so the service must be at the root of its host.
      const parsed = new URL(url);
      return parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
    }, 'RP_CONTROL_PLANE_URL must be the service origin, e.g. https://control-plane.example.com')
    .transform(withoutTrailingSlashes)
    .optional(),
  /**
   * The QR relay's functions (ADR-0015), e.g. `https://<project>.supabase.co/functions/v1`. Unset:
   * no QR menu sync (development, tests, a restaurant without QR ordering). Its credential is kept
   * apart, sealed in the database (`relay:credential`).
   */
  relayUrl: z
    .url({ protocol: /^https?$/ })
    .refine((url) => {
      const parsed = new URL(url);
      return parsed.search === '' && parsed.hash === '';
    }, 'RP_RELAY_URL must be the functions address, e.g. https://abc.supabase.co/functions/v1')
    .transform(withoutTrailingSlashes)
    .optional(),
  /**
   * The public QR menu site (P5-05), e.g. `https://menu.example.in`. Table QR codes open
   * `<site>/t/<token>`; unset, codes can be made but not printed.
   */
  qrSiteUrl: z
    .url({ protocol: /^https?$/ })
    .refine((url) => {
      const parsed = new URL(url);
      return parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
    }, 'RP_QR_SITE_URL must be the site origin, e.g. https://menu.example.in')
    .transform(withoutTrailingSlashes)
    .optional(),
  /**
   * Version of the installed product (the Windows installer, `RESTAURANT_PC`), set by the installer
   * (P0-16); the server's own version when unset.
   */
  productVersion: z.string().min(1).max(64).optional(),
  /**
   * The vendor's error service (NFR-O02, P7-08d), a Sentry DSN, set by the installer. Unset: no
   * reports leave the PC.
   */
  errorDsn: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * The folder of the PostgreSQL client programs (`pg_dump`, `pg_restore`) for backups (P7-05),
   * set by the installer; unset, they are found on the PATH.
   */
  pgBin: z.string().min(1).optional(),
  /**
   * The nightly backup (DATA-002): always on in production; development and the end-to-end tests
   * may turn it off (`RP_BACKUPS=off`) where `pg_dump` is not installed. "Back up now" still works.
   */
  backups: z.enum(['on', 'off']).default('on'),
  /**
   * A database role that may create, rename and drop databases, for a restore (P7-05b). Set, the
   * server runs a restore requested from the System page itself when it starts; unset, the
   * Windows service runs the restore tool first (P0-16). Never the server's everyday role.
   */
  adminDatabaseUrl: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'RP_ADMIN_DATABASE_URL must be a postgresql:// connection string')
    .optional(),
  /**
   * The continuous backup's database role (P7-05c): a role with REPLICATION that may run
   * `pg_switch_wal()`, for the nightly base backup and to close off the log. The installer creates
   * it and turns on PostgreSQL's WAL archiving (P0-16). Unset, there is no continuous backup; the
   * nightly full backups still run.
   */
  backupDatabaseUrl: z
    .string()
    .regex(
      /^postgres(ql)?:\/\//,
      'RP_BACKUP_DATABASE_URL must be a postgresql:// connection string',
    )
    .optional(),
  /**
   * The purge login (DATA-008, AUD-004, P7-06b): a role in `rp_purge`, the only one that may
   * delete orders, bills, payments and the audit log, used only by archive-then-purge after the
   * archive is read back. The installer creates it (P0-16). Unset: no year can be purged.
   */
  purgeDatabaseUrl: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'RP_PURGE_DATABASE_URL must be a postgresql:// connection string')
    .optional(),
  /**
   * Where the local secrets are kept (SEC-006): `file` under `<dataDir>/secrets` for development
   * and tests, `dpapi` on the restaurant PC (P0-16b), which production on Windows requires.
   */
  secretStore: z.enum(['file', 'dpapi']).default('file'),
  /** The pagers' MQTT broker (P2-04, PGR-005): on by default; over TLS when `tls` is on. */
  mqtt: z.enum(['on', 'off']).default('on'),
  /** MQTT port; 8883 is MQTTS. 0 picks a free port (tests). */
  mqttPort: z.coerce.number().int().min(0).max(65_535).default(8883),
  /** Serve HTTPS/WSS with the installation's private CA (ADR-0011, SEC-001). */
  tls: booleanFlag,
  /**
   * Whether the licence restricts ordering (LIC-003, LIC-005). Always in production; elsewhere only
   * when asked (`RP_LICENCE_ENFORCE`), though the licence is still read and shown.
   */
  licenceEnforce: booleanFlag,
  /**
   * Vendor licence keys besides those built in (SPKI DER, base64, comma-separated): development
   * and tests only, never production (LIC-003).
   */
  licenceKeys: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key !== ''),
    )
    .pipe(z.array(z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'RP_LICENCE_KEYS must be base64'))),
  /**
   * Pager firmware signing keys besides those built in (P2-04b, PGR-011): the SHA-256 digests of
   * ESP-IDF secure boot v2 public keys (`espsecure digest-sbv2-public-key`), hex, comma-separated.
   * Development and tests only, never production (like `licenceKeys`).
   */
  pagerFirmwareKeys: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((key) => key.trim().toLowerCase())
        .filter((key) => key !== ''),
    )
    .pipe(
      z.array(
        z.string().regex(/^[0-9a-f]{64}$/, 'RP_PAGER_FIRMWARE_KEYS must be SHA-256 digests in hex'),
      ),
    ),
  /**
   * The Authenticode signer every update installer must carry (UPD-007, P7-04c): the vendor's
   * code-signing certificate's subject, from the installer's build. Unset: updates are refused
   * unless `updateAllowUnsigned` (test builds only).
   */
  updatePublisher: z.string().min(3).max(500).optional(),
  /** Accept unsigned update installers (`RP_UPDATE_ALLOW_UNSIGNED=on`): test builds only. */
  updateAllowUnsigned: booleanFlag,
  /** Extra host names for the server certificate, e.g. `pos.local` (comma-separated). */
  tlsHostnames: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== ''),
    )
    .pipe(z.array(z.string().regex(HOSTNAME, 'RP_TLS_HOSTNAMES must be host names'))),
});

export type AppConfig = Readonly<z.infer<typeof AppConfigSchema>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when a connection string points at the local machine. */
export function isLoopbackDatabaseUrl(databaseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(databaseUrl).hostname);
  } catch {
    return false;
  }
}

/** Parses and validates configuration from environment variables. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AppConfig {
  const result = AppConfigSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    dataDir: env.RP_DATA_DIR,
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    buildId: env.RP_BUILD_ID,
    consoleDir: env.RP_CONSOLE_DIR,
    appsDir: env.RP_APPS_DIR === '' ? undefined : env.RP_APPS_DIR,
    controlPlaneUrl: env.RP_CONTROL_PLANE_URL,
    relayUrl: env.RP_RELAY_URL,
    qrSiteUrl: env.RP_QR_SITE_URL,
    productVersion: env.RP_PRODUCT_VERSION,
    errorDsn: env.RP_ERROR_DSN === '' ? undefined : env.RP_ERROR_DSN,
    pgBin: env.RP_PG_BIN === '' ? undefined : env.RP_PG_BIN,
    backups: env.RP_BACKUPS,
    adminDatabaseUrl: env.RP_ADMIN_DATABASE_URL === '' ? undefined : env.RP_ADMIN_DATABASE_URL,
    backupDatabaseUrl: env.RP_BACKUP_DATABASE_URL === '' ? undefined : env.RP_BACKUP_DATABASE_URL,
    purgeDatabaseUrl: env.RP_PURGE_DATABASE_URL === '' ? undefined : env.RP_PURGE_DATABASE_URL,
    secretStore: env.RP_SECRET_STORE === '' ? undefined : env.RP_SECRET_STORE,
    mqtt: env.RP_MQTT,
    mqttPort: env.RP_MQTT_PORT,
    tls: env.RP_TLS,
    tlsHostnames: env.RP_TLS_HOSTNAMES,
    updatePublisher: env.RP_UPDATE_PUBLISHER === '' ? undefined : env.RP_UPDATE_PUBLISHER,
    updateAllowUnsigned: env.RP_UPDATE_ALLOW_UNSIGNED,
    licenceEnforce: env.RP_LICENCE_ENFORCE,
    licenceKeys: env.RP_LICENCE_KEYS,
    pagerFirmwareKeys: env.RP_PAGER_FIRMWARE_KEYS,
  });
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid server configuration: ${problems}`);
  }
  const config = result.data;
  // DATA-001: the database runs on the restaurant PC and listens on localhost only.
  if (config.nodeEnv === 'production' && !isLoopbackDatabaseUrl(config.databaseUrl)) {
    throw new ConfigError('In production DATABASE_URL must point at this PC (localhost)');
  }
  // SEC-001: the cloud is reached over TLS only.
  if (config.nodeEnv === 'production' && config.controlPlaneUrl?.startsWith('https://') === false) {
    throw new ConfigError('In production RP_CONTROL_PLANE_URL must use https://');
  }
  if (config.nodeEnv === 'production' && config.relayUrl?.startsWith('https://') === false) {
    throw new ConfigError('In production RP_RELAY_URL must use https://');
  }
  if (config.nodeEnv === 'production' && config.qrSiteUrl?.startsWith('https://') === false) {
    throw new ConfigError('In production RP_QR_SITE_URL must use https://');
  }
  // SEC-006: on the restaurant PC the local secrets are protected by DPAPI, never plain files.
  if (config.nodeEnv === 'production' && platform === 'win32' && config.secretStore !== 'dpapi') {
    throw new ConfigError('In production on Windows RP_SECRET_STORE must be dpapi');
  }
  if (config.secretStore === 'dpapi' && platform !== 'win32') {
    throw new ConfigError('RP_SECRET_STORE=dpapi needs Windows');
  }
  // DATA-002: backups are automatic in production.
  if (config.nodeEnv === 'production' && config.backups === 'off') {
    throw new ConfigError('In production the nightly backup cannot be switched off');
  }
  // LIC-003: in production the licence always applies, checked only against the keys built in.
  if (config.nodeEnv === 'production') {
    if (env.RP_LICENCE_ENFORCE !== undefined && !config.licenceEnforce) {
      throw new ConfigError('In production the licence cannot be switched off');
    }
    if (config.licenceKeys.length > 0) {
      throw new ConfigError('In production only the licence keys built into the software count');
    }
    // PGR-011: pagers get firmware signed only with the keys built into the software.
    if (config.pagerFirmwareKeys.length > 0) {
      throw new ConfigError('In production only the firmware keys built into the software count');
    }
    // SEC-001: staff devices and pagers reach this PC over TLS only (HTTPS, WSS and MQTTS). The
    // installer always turns it on; a server configured by hand must too (P8-03b).
    if (!config.tls) {
      throw new ConfigError('In production RP_TLS must be on: devices connect over TLS only');
    }
    return Object.freeze({ ...config, licenceEnforce: true });
  }
  return Object.freeze(config);
}
