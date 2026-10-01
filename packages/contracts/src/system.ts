import { z } from 'zod';
import { DeviceType, IsoDate, Timestamp } from './common.js';

/** GET /api/v1/health: liveness and database status, used by the watchdog and support screen. */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  time: Timestamp,
  uptimeSeconds: z.int().nonnegative(),
  checks: z.object({
    database: z.object({
      status: z.enum(['up', 'down']),
      latencyMs: z.int().nonnegative(),
    }),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** GET /api/v1/version: component version for the support screen and N-1 checks (UPD-006). */
export const VersionResponse = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.literal('v1'),
  node: z.string().min(1),
  buildId: z.string().optional(),
});
export type VersionResponse = z.infer<typeof VersionResponse>;

/** A certificate's SHA-256 fingerprint: 32 bytes in upper-case hex, `AB:CD:…:EF`. */
export const CaFingerprint = z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

/**
 * The installation's LAN certificate authority (ADR-0011, SEC-001): apps pin it, browsers install
 * it once. Compare `sha256` with the fingerprint shown on the POS before trusting it.
 */
export const TlsCaResponse = z.object({
  /** PEM, to save as a `.crt` file. */
  certificate: z.string().startsWith('-----BEGIN CERTIFICATE-----'),
  /** SHA-256 fingerprint, `AB:CD:…` (32 bytes). */
  sha256: CaFingerprint,
  /** When the CA expires (10 years after the installation created it). */
  expiresAt: Timestamp,
});
export type TlsCaResponse = z.infer<typeof TlsCaResponse>;

// ---------------------------------------------------------------- the System page (P4-04)

/**
 * Where the data drive's space goes (DATA-006): the database without the audit trail (orders,
 * bills, menu and the rest), the audit trail, menu photos, log files and backups.
 */
export const STORAGE_CATEGORIES = ['TRANSACTIONS', 'AUDIT', 'PHOTOS', 'LOGS', 'BACKUPS'] as const;
export const StorageCategory = z.enum(STORAGE_CATEGORIES);
export type StorageCategory = z.infer<typeof StorageCategory>;

/** The drive against `storage.warnPercent` and `storage.criticalPercent`; UNKNOWN if unreadable. */
export const StorageLevel = z.enum(['OK', 'WARNING', 'CRITICAL', 'UNKNOWN']);
export type StorageLevel = z.infer<typeof StorageLevel>;

const Bytes = z.int().nonnegative();

/**
 * Everything the System page shows (MGR-010, NFR-I03): versions, the services, the data drive by
 * category, the devices, the update on offer with its approval, and the backup and licence state.
 * The backup (P7-05) and licence (P7-01) parts are null until those exist.
 */
export const SystemStatusResponse = z.object({
  checkedAt: Timestamp,
  /** The installed product, the server, Node.js and PostgreSQL. */
  versions: z.array(
    z.object({ name: z.string().min(1).max(40), version: z.string().min(1).max(64) }),
  ),
  uptimeSeconds: Bytes,
  database: z.object({ status: z.enum(['up', 'down']), latencyMs: Bytes }),
  controlPlane: z.object({
    /** A Control Plane address is set (a site that is not activated yet has none). */
    configured: z.boolean(),
    enrolled: z.boolean(),
    lastContactAt: Timestamp.nullable(),
    /** `UNREACHABLE`, `NOT_ENROLLED` or the Control Plane's error code; null when fine. */
    lastError: z.string().nullable(),
  }),
  storage: z.object({
    totalBytes: Bytes.nullable(),
    freeBytes: Bytes.nullable(),
    usedPercent: z.int().min(0).max(100).nullable(),
    level: StorageLevel,
    warnPercent: z.int(),
    criticalPercent: z.int(),
    /** Null for a category not measured (no backups set up yet, say). */
    categories: z.array(z.object({ category: StorageCategory, bytes: Bytes.nullable() })),
  }),
  /** Paired (active) and connected devices of each type. */
  devices: z.array(z.object({ type: DeviceType, paired: Bytes, connected: Bytes })),
  update: z.object({
    /** The release the Control Plane offers (UPD-002), or null when up to date. */
    offered: z
      .object({
        version: z.string(),
        channel: z.string(),
        notes: z.string().nullable(),
        publishedAt: Timestamp,
        sizeBytes: z.int().positive(),
      })
      .nullable(),
    /** A manager pressed "Install now" for this version (UPD-004); the updater (P7-04) acts on it. */
    installApproval: z
      .object({ version: z.string(), approvedAt: Timestamp, approvedBy: z.string().nullable() })
      .nullable(),
    maintenanceWindow: z.object({ start: z.string(), end: z.string() }),
    /** Updates wait while tables are open, unless security-critical and approved (UPD-004). */
    openTables: Bytes,
  }),
  backup: z
    .object({ lastSuccessAt: Timestamp.nullable(), lastError: z.string().nullable() })
    .nullable(),
  licence: z
    .object({ state: z.string(), validUntil: IsoDate.nullable(), daysLeft: z.int().nullable() })
    .nullable(),
});
export type SystemStatusResponse = z.infer<typeof SystemStatusResponse>;

/** "Install now" for the version on offer (UPD-004). Audited with the optional reason. */
export const ApproveUpdateRequest = z.strictObject({
  version: z.string().min(1).max(64),
  reason: z.string().trim().min(3).max(200).optional(),
});
export type ApproveUpdateRequest = z.infer<typeof ApproveUpdateRequest>;
