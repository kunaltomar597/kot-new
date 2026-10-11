import { STORAGE_LEVELS } from '@rp/domain';
import { z } from 'zod';
import { DeviceType, Id, LicenseState, Timestamp } from './common.js';
import { ReleaseChannel, SemVer } from './control-plane/schemas.js';
import { TimeWindow } from './settings.js';

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

/** What uses the data drive (DATA-006). */
export const STORAGE_CATEGORIES = ['TRANSACTIONS', 'AUDIT', 'PHOTOS', 'LOGS', 'BACKUPS'] as const;
export const StorageCategory = z.enum(STORAGE_CATEGORIES);
export type StorageCategory = z.infer<typeof StorageCategory>;

/** How full the data drive is against `storage.warnPercent` and `storage.criticalPercent`. */
export const StorageLevel = z.enum(STORAGE_LEVELS);
export type StorageLevel = z.infer<typeof StorageLevel>;

const Bytes = z.int().nonnegative();
const Count = z.int().nonnegative();

/** A release the Control Plane offers this PC (UPD-002), as the System page shows it. */
export const OfferedUpdate = z.object({
  version: SemVer,
  channel: ReleaseChannel,
  notes: z.string().nullable(),
  sizeBytes: z.int().positive(),
  publishedAt: Timestamp,
  /** May install while tables are open, once a manager approves with a reason (UPD-004). */
  securityCritical: z.boolean(),
});
export type OfferedUpdate = z.infer<typeof OfferedUpdate>;

/** A manager's "Install now" for the offered release, kept for the update agent (P7-04). */
export const InstallApproval = z.object({
  version: SemVer,
  approvedAt: Timestamp,
  approvedBy: z.object({ id: Id, name: z.string() }),
  /** The manager's reason: required for a security update while tables are open. */
  reason: z.string().nullable(),
});
export type InstallApproval = z.infer<typeof InstallApproval>;

/** Updates on the System page (UPD-004): what is installed, what is offered and when it installs. */
export const SystemUpdates = z.object({
  /** This PC's product version, the one releases are compared with. */
  current: z.string().min(1),
  /** The release channel this PC follows; null until it is enrolled with the Control Plane. */
  channel: ReleaseChannel.nullable(),
  offered: OfferedUpdate.nullable(),
  /** Updates install only in this window, unless a manager presses "Install now". */
  maintenanceWindow: TimeWindow,
  /** The approval for the offered release, if one was given. */
  approval: InstallApproval.nullable(),
  /** Tables open now: an update installs only when none are (UPD-004). */
  openTables: Count,
});
export type SystemUpdates = z.infer<typeof SystemUpdates>;

/**
 * GET /api/v1/system: the single support screen (MGR-010, NFR-I03). Versions and service status,
 * connected devices by type, storage, how backups are set up, the licence and updates.
 */
export const SystemView = z.object({
  checkedAt: Timestamp,
  uptimeSeconds: Count,
  versions: z.object({
    /** The installed product (the Windows installer's version). */
    product: z.string().min(1),
    server: z.string().min(1),
    node: z.string().min(1),
    postgres: z.string().nullable(),
    buildId: z.string().nullable(),
  }),
  services: z.object({
    database: z.object({ up: z.boolean(), latencyMs: Count }),
    /** The pagers' broker (PGR-005): not running when switched off or not listening. */
    pagerBroker: z.object({
      running: z.boolean(),
      port: z.int().positive().nullable(),
      secure: z.boolean(),
      connectedPagers: Count,
    }),
    printers: z.object({
      total: Count,
      offline: Count,
      /** Tickets and notes waiting to print (KDS-008). */
      waiting: Count,
    }),
    /** The link to the Vendor Control Plane (VCP-005) that "Send diagnostics" and updates use. */
    controlPlane: z.object({
      configured: z.boolean(),
      enrolled: z.boolean(),
      lastReportAt: Timestamp.nullable(),
      /** `NOT_ENROLLED`, `UNREACHABLE`, the Control Plane's error code, or null. */
      lastError: z.string().nullable(),
    }),
  }),
  /** Paired devices by type and how many are connected now (MGR-006). */
  devices: z.array(z.object({ type: DeviceType, paired: Count, connected: Count })),
  /** The data drive (DATA-006); sizes are null when it cannot be read. */
  storage: z.object({
    totalBytes: Bytes.nullable(),
    freeBytes: Bytes.nullable(),
    usedPercent: z.int().min(0).max(100).nullable(),
    warnPercent: z.int().min(0).max(100),
    criticalPercent: z.int().min(0).max(100),
    level: StorageLevel.nullable(),
    /** Every category in a fixed order; bytes are null when the category could not be measured. */
    categories: z.array(z.object({ category: StorageCategory, bytes: Bytes.nullable() })),
  }),
  /** How backups are set up (DATA-002, DATA-003); the runs themselves arrive with P7-05. */
  backups: z.object({
    walMode: z.enum(['CONTINUOUS', 'HOURLY']),
    secondLocation: z.string().nullable(),
    keepDaily: Count,
    keepWeekly: Count,
    cloudEnabled: z.boolean(),
    lastBackupAt: Timestamp.nullable(),
  }),
  /** The licence and its days left (LIC-005, LIC-008); null until this PC is activated (P7-01). */
  licence: z
    .object({
      state: LicenseState,
      daysLeft: Count.nullable(),
      validUntil: Timestamp.nullable(),
    })
    .nullable(),
  updates: SystemUpdates,
});
export type SystemView = z.infer<typeof SystemView>;

/**
 * POST /api/v1/system/updates/install-now (UPD-004): approves installing the offered release now.
 * Refused while tables are open, unless the release is security-critical and a reason is given.
 */
export const InstallNowRequest = z.strictObject({
  version: SemVer,
  reason: z.string().trim().min(3).max(200).optional(),
});
export type InstallNowRequest = z.infer<typeof InstallNowRequest>;

/** POST /api/v1/system/diagnostics (UPD-008): the report reached the Control Plane at this time. */
export const DiagnosticsResponse = z.object({ sentAt: Timestamp });
export type DiagnosticsResponse = z.infer<typeof DiagnosticsResponse>;
