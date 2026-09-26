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

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => value === 'true' || value === '1');

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
   * Version of the installed product (the Windows installer, `RESTAURANT_PC`), set by the installer
   * (P0-16); the server's own version when unset.
   */
  productVersion: z.string().min(1).max(64).optional(),
  /** Serve HTTPS/WSS with the installation's private CA (ADR-0011, SEC-001). */
  tls: booleanFlag,
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
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
    controlPlaneUrl: env.RP_CONTROL_PLANE_URL,
    productVersion: env.RP_PRODUCT_VERSION,
    tls: env.RP_TLS,
    tlsHostnames: env.RP_TLS_HOSTNAMES,
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
  return Object.freeze(config);
}
