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

/** The India regions cloud backups may be stored in (DATA-003): Mumbai and Hyderabad. */
export const INDIA_REGIONS: readonly string[] = ['ap-south-1', 'ap-south-2'];

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
    /**
     * The AI provider's key for menu import (ONB-006), from the secret manager only (SEC-002).
     * Without it, AI import is off and restaurants use the Excel template.
     */
    aiApiKey: z.string().min(1).optional(),
    aiModel: z.string().min(1).default('claude-sonnet-5-5'),
    aiBaseUrl: z.url({ protocol: /^https?$/ }).default('https://api.anthropic.com'),
    aiTimeoutSeconds: z.coerce.number().int().min(30).max(900).default(300),
    /** Menus each restaurant may have read in 24 hours (the vendor pays per menu). */
    aiDailyLimit: z.coerce.number().int().min(1).max(500).default(20),
    /**
     * The vendor's Ed25519 licence-signing key, PKCS#8 DER in base64, from the secret manager only
     * (LIC-001, SEC-002). Without it no licence is issued. Production keeps it in the cloud KMS
     * (manual task 23).
     */
    licenceSigningKey: z.string().min(40).optional(),
    /** The master secret installations' reactivation secrets derive from, base64 (LIC-006). */
    licenceReactivationKey: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length >= 32, 'at least 32 bytes')
      .optional(),
    /** A new installation's licence terms (LIC-002 ⚙ 30 days; LIC-005 ⚙ 7 days of grace). */
    licenceValidityDays: z.coerce.number().int().min(1).max(365).default(30),
    licenceGraceDays: z.coerce.number().int().min(0).max(90).default(7),
    /** Heartbeats asked of an installation whose licence is not active (LIC-006: within 1 min). */
    licenceHeartbeatSeconds: z.coerce.number().int().min(60).max(600).default(60),
    /**
     * The QR relay's database, as a login allowed the `relay_provisioner` role only (VCP-002), from
     * the secret manager. Unset: restaurants cannot be provisioned for QR ordering from here.
     */
    relayDatabaseUrl: z
      .string()
      .regex(/^postgres(ql)?:\/\//)
      .optional(),
    /** Minutes of silence during business hours before a PC is reported offline (VCP-005 ⚙). */
    offlineAlertMinutes: z.coerce.number().int().min(5).max(1_440).default(30),
    /** Disk use above which a PC's data drive is reported full (VCP-005 ⚙ 90 %). */
    diskAlertPercent: z.coerce.number().int().min(50).max(99).default(90),
    /** How often silent PCs are looked for and alerts sent; 0 is off (tests). */
    fleetSweepSeconds: z.coerce.number().int().min(0).max(3_600).default(60),
    /**
     * Where fleet alerts are posted as they open and close (`{ text, alert }`, which Slack and
     * Teams incoming webhooks take), from the secret manager. Unset: alerts only show in the app.
     */
    alertWebhookUrl: z.url({ protocol: /^https?$/ }).optional(),
    /** The vendor's error service (NFR-O02, P7-08d), a Sentry DSN; unset: errors are only logged. */
    errorDsn: z.url({ protocol: /^https?$/ }).optional(),
    /** Folder of the built vendor web app (`apps/control-plane-web/dist`), served at `/` when set. */
    webDir: z.string().min(1).optional(),
    /** Days a restaurant has to pay an invoice (LIC-009: as the subscription agreement says). */
    billingPaymentTermsDays: z.coerce.number().int().min(0).max(90).default(7),
    /** Days past due before grace starts (LIC-005 ⚙ "overdue beyond N days"). */
    billingGraceAfterDays: z.coerce.number().int().min(0).max(180).default(15),
    /** How often the billing run issues invoices and follows up overdue ones; 0 is off (tests). */
    billingIntervalMinutes: z.coerce.number().int().min(0).max(1_440).default(60),
    /**
     * The Control Plane's own secret (32+ bytes, base64) from the secret manager: it seals vendor
     * staff's authenticator secrets and peppers their passwords (VCP-001). Required outside
     * development.
     */
    secretKey: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length >= 32, 'at least 32 bytes')
      .optional(),
    /**
     * Where cloud backups go (DATA-003, P7-05d): S3 in India in staging and production, a local
     * folder in development, or off (PCs are told the cloud backup is not set up).
     */
    backupStore: z.enum(['off', 'local', 's3']).default('off'),
    backupLocalDir: z.string().min(1).optional(),
    backupS3Endpoint: z
      .url({ protocol: /^https?$/ })
      .default('https://s3.ap-south-1.amazonaws.com'),
    backupS3Region: z.string().min(1).default('ap-south-1'),
    backupS3Bucket: z.string().min(3).max(63).optional(),
    backupS3AccessKeyId: z.string().min(1).optional(),
    backupS3SecretAccessKey: z.string().min(1).optional(),
    /** For S3-compatible services that address buckets by path. */
    backupS3PathStyle: booleanFlag,
    /** Cloud backups kept per PC: the newest of each of the last N days and weeks (DATA-002). */
    backupKeepDaily: z.coerce.number().int().min(1).max(90).default(14),
    backupKeepWeekly: z.coerce.number().int().min(0).max(104).default(8),
  })
  .superRefine((config, context) => {
    if (config.env !== 'development' && config.secretKey === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['secretKey'],
        message: 'staging and production need CP_SECRET_KEY from the secret manager',
      });
    }
    if (
      config.env !== 'development' &&
      config.relayDatabaseUrl !== undefined &&
      !databaseUsesTls(config.relayDatabaseUrl)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['relayDatabaseUrl'],
        message:
          'staging and production need sslmode=require (or stricter) in CP_RELAY_DATABASE_URL',
      });
    }
    if (
      config.env !== 'development' &&
      config.alertWebhookUrl !== undefined &&
      !config.alertWebhookUrl.startsWith('https://')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['alertWebhookUrl'],
        message: 'staging and production need an https:// CP_ALERT_WEBHOOK_URL',
      });
    }
    if (config.backupStore === 'local' && config.backupLocalDir === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['backupLocalDir'],
        message: 'CP_BACKUP_STORE=local needs CP_BACKUP_LOCAL_DIR',
      });
    }
    if (config.env !== 'development' && config.backupStore === 'local') {
      context.addIssue({
        code: 'custom',
        path: ['backupStore'],
        message: 'staging and production keep cloud backups in S3 (CP_BACKUP_STORE=s3)',
      });
    }
    if (
      config.backupStore === 's3' &&
      (config.backupS3Bucket === undefined ||
        config.backupS3AccessKeyId === undefined ||
        config.backupS3SecretAccessKey === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['backupS3Bucket'],
        message:
          'CP_BACKUP_STORE=s3 needs CP_BACKUP_S3_BUCKET, CP_BACKUP_S3_ACCESS_KEY_ID and CP_BACKUP_S3_SECRET_ACCESS_KEY',
      });
    }
    // DATA-003: the restaurant's backups are stored in India.
    if (
      config.env !== 'development' &&
      config.backupStore === 's3' &&
      !INDIA_REGIONS.includes(config.backupS3Region)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['backupS3Region'],
        message: `cloud backups must stay in India: CP_BACKUP_S3_REGION is one of ${INDIA_REGIONS.join(', ')}`,
      });
    }
    if (
      config.env !== 'development' &&
      config.backupStore === 's3' &&
      !config.backupS3Endpoint.startsWith('https://')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['backupS3Endpoint'],
        message: 'staging and production need an https:// CP_BACKUP_S3_ENDPOINT',
      });
    }
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
    aiApiKey: env.CP_AI_API_KEY === '' ? undefined : env.CP_AI_API_KEY,
    aiModel: env.CP_AI_MODEL,
    aiBaseUrl: env.CP_AI_BASE_URL,
    aiTimeoutSeconds: env.CP_AI_TIMEOUT_SECONDS,
    aiDailyLimit: env.CP_AI_DAILY_LIMIT,
    licenceSigningKey: env.CP_LICENCE_SIGNING_KEY === '' ? undefined : env.CP_LICENCE_SIGNING_KEY,
    licenceReactivationKey:
      env.CP_LICENCE_REACTIVATION_KEY === '' ? undefined : env.CP_LICENCE_REACTIVATION_KEY,
    licenceValidityDays: env.CP_LICENCE_VALIDITY_DAYS,
    licenceGraceDays: env.CP_LICENCE_GRACE_DAYS,
    licenceHeartbeatSeconds: env.CP_LICENCE_HEARTBEAT_SECONDS,
    secretKey: env.CP_SECRET_KEY === '' ? undefined : env.CP_SECRET_KEY,
    relayDatabaseUrl: env.CP_RELAY_DATABASE_URL === '' ? undefined : env.CP_RELAY_DATABASE_URL,
    billingPaymentTermsDays: env.CP_BILLING_PAYMENT_TERMS_DAYS,
    billingGraceAfterDays: env.CP_BILLING_GRACE_AFTER_DAYS,
    billingIntervalMinutes: env.CP_BILLING_INTERVAL_MINUTES,
    webDir: env.CP_WEB_DIR === '' ? undefined : env.CP_WEB_DIR,
    offlineAlertMinutes: env.CP_OFFLINE_ALERT_MINUTES,
    diskAlertPercent: env.CP_DISK_ALERT_PERCENT,
    fleetSweepSeconds: env.CP_FLEET_SWEEP_SECONDS,
    alertWebhookUrl: env.CP_ALERT_WEBHOOK_URL === '' ? undefined : env.CP_ALERT_WEBHOOK_URL,
    errorDsn: env.CP_ERROR_DSN === '' ? undefined : env.CP_ERROR_DSN,
    backupStore: env.CP_BACKUP_STORE === '' ? undefined : env.CP_BACKUP_STORE,
    backupLocalDir: env.CP_BACKUP_LOCAL_DIR === '' ? undefined : env.CP_BACKUP_LOCAL_DIR,
    backupS3Endpoint: env.CP_BACKUP_S3_ENDPOINT === '' ? undefined : env.CP_BACKUP_S3_ENDPOINT,
    backupS3Region: env.CP_BACKUP_S3_REGION === '' ? undefined : env.CP_BACKUP_S3_REGION,
    backupS3Bucket: env.CP_BACKUP_S3_BUCKET === '' ? undefined : env.CP_BACKUP_S3_BUCKET,
    backupS3AccessKeyId:
      env.CP_BACKUP_S3_ACCESS_KEY_ID === '' ? undefined : env.CP_BACKUP_S3_ACCESS_KEY_ID,
    backupS3SecretAccessKey:
      env.CP_BACKUP_S3_SECRET_ACCESS_KEY === '' ? undefined : env.CP_BACKUP_S3_SECRET_ACCESS_KEY,
    backupS3PathStyle: env.CP_BACKUP_S3_PATH_STYLE,
    backupKeepDaily: env.CP_BACKUP_KEEP_DAILY,
    backupKeepWeekly: env.CP_BACKUP_KEEP_WEEKLY,
  });
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid Control Plane configuration: ${problems}`);
  }
  return Object.freeze(result.data);
}
