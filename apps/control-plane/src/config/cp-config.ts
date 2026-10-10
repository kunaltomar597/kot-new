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

/**
 * The outside services' addresses, with their environment variables: staging and production
 * reach each over https only (threat CP-I3), since each call carries a key or personal data.
 */
const OUTSIDE_SERVICES = [
  ['aiBaseUrl', 'CP_AI_BASE_URL'],
  ['whatsappApiUrl', 'CP_WHATSAPP_API_URL'],
  ['errorDsn', 'CP_ERROR_DSN'],
  ['alertWebhookUrl', 'CP_ALERT_WEBHOOK_URL'],
  ['publicUrl', 'CP_PUBLIC_URL'],
  ['backupS3Endpoint', 'CP_BACKUP_S3_ENDPOINT'],
  ['escrowKmsEndpoint', 'CP_ESCROW_KMS_ENDPOINT'],
] as const;

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
     * The QR relay's database, as its `relay_control_plane` login, which may take the
     * `relay_provisioner` role only (VCP-002, RELAY-E3; manual task 20), from the secret manager.
     * Unset: restaurants cannot be provisioned for QR ordering from here.
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
     * Staged rollouts (UPD-003): minutes without a heartbeat after a PC starts installing before
     * it counts as a failed install; server errors in the day after an install that count as a
     * spike; and the failures, and share of installs failing, that halt a rollout by itself.
     */
    rolloutSilentMinutes: z.coerce.number().int().min(5).max(1_440).default(45),
    rolloutErrorSpike: z.coerce.number().int().min(1).max(100_000).default(100),
    rolloutMinFailures: z.coerce.number().int().min(1).max(100).default(2),
    rolloutMaxFailurePercent: z.coerce.number().int().min(1).max(100).default(20),
    /**
     * Where fleet alerts are posted as they open and close (`{ text, alert }`, which Slack and
     * Teams incoming webhooks take), from the secret manager. Unset: alerts only show in the app.
     */
    alertWebhookUrl: z.url({ protocol: /^https?$/ }).optional(),
    /** The vendor's error service (NFR-O02, P7-08d), a Sentry DSN; unset: errors are only logged. */
    errorDsn: z.url({ protocol: /^https?$/ }).optional(),
    /** Folder of the built vendor web app (`apps/control-plane-web/dist`), served at `/` when set. */
    webDir: z.string().min(1).optional(),
    /**
     * The Control Plane's public address, as diners open it from a digital bill (BILL-012), e.g.
     * `https://cloud.vendor.in`. Unset: no digital bills.
     */
    publicUrl: z.url({ protocol: /^https?$/ }).optional(),
    /**
     * The secret digital bills' links derive from (32+ bytes, base64), from the secret manager.
     * Only the links' hashes are stored, so a copy of the database opens no bill. Unset: no
     * digital bills.
     */
    digitalBillKey: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length >= 32, 'at least 32 bytes')
      .optional(),
    /** Digital bills each restaurant may send in 24 hours (the vendor pays per message). */
    digitalBillDailyLimit: z.coerce.number().int().min(1).max(20_000).default(3_000),
    /** How often expired bills are deleted; 0 is off (tests). */
    digitalBillSweepSeconds: z.coerce.number().int().min(0).max(86_400).default(3_600),
    /**
     * The WhatsApp Business Platform (Meta's Cloud API) for digital bills, from the secret
     * manager: a system user's access token and the sending number's id. Unset: no WhatsApp.
     */
    whatsappToken: z.string().min(1).optional(),
    whatsappPhoneNumberId: z
      .string()
      .regex(/^\d{5,20}$/)
      .optional(),
    /** The approved message template and its language (manual task 28). */
    whatsappTemplate: z
      .string()
      .regex(/^[a-z0-9_]{1,512}$/)
      .default('digital_bill'),
    whatsappLanguage: z.string().min(2).max(10).default('en'),
    whatsappApiUrl: z.url({ protocol: /^https?$/ }).default('https://graph.facebook.com/v21.0'),
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
    /**
     * The vendor's escrow key for restaurants' backup keys (DATA-003, OI-10, P7-05e): an AWS KMS
     * RSA_4096 ENCRYPT_DECRYPT key in India, or in development an RSA private key (PKCS#8 DER,
     * base64) from configuration. Neither: no escrow, and no restore from the cloud.
     */
    escrowPrivateKey: z.string().min(100).optional(),
    escrowKmsKeyId: z.string().min(1).optional(),
    escrowKmsRegion: z.string().min(1).default('ap-south-1'),
    escrowKmsEndpoint: z.url({ protocol: /^https?$/ }).optional(),
    escrowKmsAccessKeyId: z.string().min(1).optional(),
    escrowKmsSecretAccessKey: z.string().min(1).optional(),
    /** Cloud backups kept per PC (BRD §9.3): the newest of each of the last 30 days and 12 months. */
    backupKeepDaily: z.coerce.number().int().min(1).max(90).default(30),
    backupKeepMonthly: z.coerce.number().int().min(0).max(120).default(12),
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
    for (const [setting, variable] of OUTSIDE_SERVICES) {
      const url = config[setting];
      if (config.env !== 'development' && url !== undefined && !url.startsWith('https://')) {
        context.addIssue({
          code: 'custom',
          path: [setting],
          message: `staging and production need an https:// ${variable}`,
        });
      }
    }
    if ((config.whatsappToken === undefined) !== (config.whatsappPhoneNumberId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['whatsappPhoneNumberId'],
        message: 'CP_WHATSAPP_TOKEN and CP_WHATSAPP_PHONE_NUMBER_ID go together',
      });
    }
    if (
      config.whatsappToken !== undefined &&
      (config.publicUrl === undefined || config.digitalBillKey === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['publicUrl'],
        message: 'digital bills need CP_PUBLIC_URL and CP_DIGITAL_BILL_KEY for their links',
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
    // OI-10: in staging and production the escrow key never leaves the KMS.
    if (config.env !== 'development' && config.escrowPrivateKey !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['escrowPrivateKey'],
        message: 'staging and production keep the escrow key in the KMS (CP_ESCROW_KMS_KEY_ID)',
      });
    }
    if (
      config.escrowKmsKeyId !== undefined &&
      (config.escrowKmsAccessKeyId === undefined || config.escrowKmsSecretAccessKey === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['escrowKmsKeyId'],
        message:
          'CP_ESCROW_KMS_KEY_ID needs CP_ESCROW_KMS_ACCESS_KEY_ID and CP_ESCROW_KMS_SECRET_ACCESS_KEY',
      });
    }
    if (
      config.env !== 'development' &&
      config.escrowKmsKeyId !== undefined &&
      !INDIA_REGIONS.includes(config.escrowKmsRegion)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['escrowKmsRegion'],
        message: `the escrow key stays in India: CP_ESCROW_KMS_REGION is one of ${INDIA_REGIONS.join(', ')}`,
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
    publicUrl: env.CP_PUBLIC_URL === '' ? undefined : env.CP_PUBLIC_URL,
    digitalBillKey: env.CP_DIGITAL_BILL_KEY === '' ? undefined : env.CP_DIGITAL_BILL_KEY,
    digitalBillDailyLimit: env.CP_DIGITAL_BILL_DAILY_LIMIT,
    digitalBillSweepSeconds: env.CP_DIGITAL_BILL_SWEEP_SECONDS,
    whatsappToken: env.CP_WHATSAPP_TOKEN === '' ? undefined : env.CP_WHATSAPP_TOKEN,
    whatsappPhoneNumberId:
      env.CP_WHATSAPP_PHONE_NUMBER_ID === '' ? undefined : env.CP_WHATSAPP_PHONE_NUMBER_ID,
    whatsappTemplate: env.CP_WHATSAPP_TEMPLATE === '' ? undefined : env.CP_WHATSAPP_TEMPLATE,
    whatsappLanguage: env.CP_WHATSAPP_LANGUAGE === '' ? undefined : env.CP_WHATSAPP_LANGUAGE,
    whatsappApiUrl: env.CP_WHATSAPP_API_URL === '' ? undefined : env.CP_WHATSAPP_API_URL,
    offlineAlertMinutes: env.CP_OFFLINE_ALERT_MINUTES,
    diskAlertPercent: env.CP_DISK_ALERT_PERCENT,
    fleetSweepSeconds: env.CP_FLEET_SWEEP_SECONDS,
    rolloutSilentMinutes: env.CP_ROLLOUT_SILENT_MINUTES,
    rolloutErrorSpike: env.CP_ROLLOUT_ERROR_SPIKE,
    rolloutMinFailures: env.CP_ROLLOUT_MIN_FAILURES,
    rolloutMaxFailurePercent: env.CP_ROLLOUT_MAX_FAILURE_PERCENT,
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
    escrowPrivateKey: env.CP_ESCROW_PRIVATE_KEY === '' ? undefined : env.CP_ESCROW_PRIVATE_KEY,
    escrowKmsKeyId: env.CP_ESCROW_KMS_KEY_ID === '' ? undefined : env.CP_ESCROW_KMS_KEY_ID,
    escrowKmsRegion: env.CP_ESCROW_KMS_REGION === '' ? undefined : env.CP_ESCROW_KMS_REGION,
    escrowKmsEndpoint: env.CP_ESCROW_KMS_ENDPOINT === '' ? undefined : env.CP_ESCROW_KMS_ENDPOINT,
    escrowKmsAccessKeyId:
      env.CP_ESCROW_KMS_ACCESS_KEY_ID === '' ? undefined : env.CP_ESCROW_KMS_ACCESS_KEY_ID,
    escrowKmsSecretAccessKey:
      env.CP_ESCROW_KMS_SECRET_ACCESS_KEY === '' ? undefined : env.CP_ESCROW_KMS_SECRET_ACCESS_KEY,
    backupKeepDaily: env.CP_BACKUP_KEEP_DAILY,
    backupKeepMonthly: env.CP_BACKUP_KEEP_MONTHLY,
  });
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid Control Plane configuration: ${problems}`);
  }
  return Object.freeze(result.data);
}
