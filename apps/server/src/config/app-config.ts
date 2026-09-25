import { z } from 'zod';

/**
 * Deployment configuration of the local server, read from environment variables.
 *
 * This is installation-level configuration (ports, database, data directory, logging). Restaurant
 * settings (every ⚙ value in the BRD) live in the database settings registry from P1-01.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

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
  return Object.freeze(config);
}
