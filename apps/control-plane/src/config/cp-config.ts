import { z } from 'zod';

/**
 * Configuration of the Vendor Control Plane, from environment variables only (SEC-002, ADR-0012).
 * Each environment (VCP-009) has its own database and values; secrets come from the hosting
 * provider's secret manager, never from files in the repository.
 */
export const CP_CONFIG = Symbol('CP_CONFIG');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const TLS_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => value === 'true' || value === '1');

/** True when the connection string makes PostgreSQL use TLS (`sslmode=require` or stricter). */
export function databaseUsesTls(databaseUrl: string): boolean {
  try {
    return TLS_SSL_MODES.has(new URL(databaseUrl).searchParams.get('sslmode') ?? '');
  } catch {
    return false;
  }
}

export const CpConfigSchema = z
  .object({
    env: z.enum(['development', 'staging', 'production']).default('development'),
    host: z.string().min(1).default('0.0.0.0'),
    port: z.coerce.number().int().min(1).max(65_535).default(8090),
    databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
    logLevel: z.enum(LOG_LEVELS).default('info'),
    logPretty: booleanFlag,
    /** Seconds between heartbeats asked of every installation (VCP-005, UPD-010). */
    heartbeatSeconds: z.coerce.number().int().min(60).max(3_600).default(300),
    /** Reverse proxies in front of the service, so rate limits see the real client address. */
    trustProxy: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((config, context) => {
    if (config.env !== 'development' && !databaseUsesTls(config.databaseUrl)) {
      context.addIssue({
        code: 'custom',
        path: ['databaseUrl'],
        message: 'staging and production need sslmode=require (or stricter) in DATABASE_URL',
      });
    }
  });

export type CpConfig = Readonly<z.infer<typeof CpConfigSchema>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Reads the configuration; the error names the settings that are wrong, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CpConfig {
  const result = CpConfigSchema.safeParse({
    env: env.CP_ENV,
    host: env.HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    heartbeatSeconds: env.CP_HEARTBEAT_SECONDS,
    trustProxy: env.CP_TRUST_PROXY,
  });
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid Control Plane configuration: ${problems}`);
  }
  return Object.freeze(result.data);
}
