import { z } from 'zod';
import { ClientApiRange, ClientCompatibility } from './client-api.js';
import { DeviceType, Id, IsoDate, Timestamp } from './common.js';
import { PendingDiagnosticsRequest as PendingDiagnosticsRequestSchema } from './control-plane/diagnostics.js';

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
  /**
   * The client API it speaks and the oldest it still serves (N-1, UPD-006). Absent from servers
   * before P7-04d, which a newer app must still read.
   */
  clientApi: ClientApiRange.optional(),
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
 * What the update agent on the restaurant PC is doing (UPD-004, UPD-005, P7-04c):
 * - `IDLE`: nothing on offer that is newer than this PC's version;
 * - `DOWNLOADING`, then `WAITING` once the download passed its checks (see `waitingFor`);
 * - `DOWNLOAD_FAILED`: the download failed or did not pass its checks; tried again at `retryAt`;
 * - `PREPARING`: the backup and integrity check before the update;
 * - `PREPARE_FAILED`: they failed; nothing was changed and they are tried again at `retryAt`;
 * - `INSTALLING`: handed to the installer; the server restarts;
 * - `UNAVAILABLE`: this PC cannot install updates (see `error`).
 */
export const UpdateAgentState = z.enum([
  'IDLE',
  'DOWNLOADING',
  'DOWNLOAD_FAILED',
  'WAITING',
  'PREPARING',
  'PREPARE_FAILED',
  'INSTALLING',
  'UNAVAILABLE',
]);
export type UpdateAgentState = z.infer<typeof UpdateAgentState>;

/** `updateTiming`'s reasons in `@rp/domain`: the window, open tables, a retry after a failure. */
export const UpdateWait = z.enum(['WINDOW', 'OPEN_TABLES', 'RETRY_APPROVAL']);
export type UpdateWait = z.infer<typeof UpdateWait>;

/** How an update ended (UPD-005): the new version runs, the old one is back, or neither ran it. */
export const SoftwareUpdateOutcome = z.enum(['INSTALLED', 'ROLLED_BACK', 'FAILED']);
export type SoftwareUpdateOutcome = z.infer<typeof SoftwareUpdateOutcome>;

export const UpdateAgentStatus = z.object({
  state: UpdateAgentState,
  /** The version it is working on, or null. */
  version: z.string().nullable(),
  waitingFor: UpdateWait.nullable(),
  /** Why the download or the preparation failed, or why updates are unavailable here. */
  error: z.string().nullable(),
  /** When a failed download or preparation is tried again. */
  retryAt: Timestamp.nullable(),
  /** The last update this PC tried, or null. */
  lastOutcome: z
    .object({
      version: z.string(),
      previousVersion: z.string().nullable(),
      outcome: SoftwareUpdateOutcome,
      at: Timestamp,
      /** Why it failed, in plain words. */
      error: z.string().nullable(),
      /** The backup made before it, in the backups list. */
      backupFileName: z.string().nullable(),
    })
    .nullable(),
});
export type UpdateAgentStatus = z.infer<typeof UpdateAgentStatus>;

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
  /** The QR relay (P5-03, ADR-0015): whether the QR menu online is in step with this PC. */
  qrRelay: z.object({
    /** A relay address is set (no QR ordering without it). */
    configured: z.boolean(),
    /** The vendor's credential for the relay is stored. */
    credential: z.boolean(),
    lastContactAt: Timestamp.nullable(),
    /** `UNREACHABLE`, `NO_CREDENTIAL` or the relay's error code; null when fine. */
    lastError: z.string().nullable(),
    /** The menu version the QR page shows, null before the first. */
    menuVersion: z.int().positive().nullable(),
    /** New QR orders ring by Realtime (P5-03d); false while they are polled. */
    realtime: z.boolean(),
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
    /**
     * The automatic retention (DATA-007, P7-06a): operational data kept this many days, and the
     * last daily run with what it removed or anonymised.
     */
    retention: z.object({
      operationalDays: z.int().positive(),
      dinerContactMonths: z.int().positive(),
      lastRunAt: Timestamp.nullable(),
      lastRunTotal: z.int().nonnegative().nullable(),
    }),
  }),
  /** Paired (active) and connected devices of each type. */
  devices: z.array(z.object({ type: DeviceType, paired: Bytes, connected: Bytes })),
  /**
   * The apps against the client API this server serves (UPD-006): paired apps (not pagers) by how
   * they stand, so the ones to update are seen (P7-04d).
   */
  clients: z.object({
    api: ClientApiRange,
    counts: z.array(z.object({ compatibility: ClientCompatibility, devices: Bytes })),
  }),
  update: z.object({
    /** The release the Control Plane offers (UPD-002), or null when up to date. */
    offered: z
      .object({
        version: z.string(),
        channel: z.string(),
        notes: z.string().nullable(),
        publishedAt: Timestamp,
        sizeBytes: z.int().positive(),
        /** The client API its server will serve, from its version matrix; null if it has none. */
        clientApi: ClientApiRange.nullable(),
        /** Paired apps it would no longer serve: update them first (UPD-006); null if unknown. */
        leavesBehind: Bytes.nullable(),
      })
      .nullable(),
    /** A manager pressed "Install now" for this version (UPD-004); the updater (P7-04) acts on it. */
    installApproval: z
      .object({ version: z.string(), approvedAt: Timestamp, approvedBy: z.string().nullable() })
      .nullable(),
    maintenanceWindow: z.object({ start: z.string(), end: z.string() }),
    /** Updates wait while tables are open, unless security-critical and approved (UPD-004). */
    openTables: Bytes,
    /** What the update agent is doing, and how the last update went (P7-04c). */
    agent: UpdateAgentStatus,
  }),
  backup: z
    .object({ lastSuccessAt: Timestamp.nullable(), lastError: z.string().nullable() })
    .nullable(),
  licence: z
    .object({ state: z.string(), validUntil: IsoDate.nullable(), daysLeft: z.int().nullable() })
    .nullable(),
  /**
   * Uninstalling keeps the data unless the Owner allowed deleting it (NFR-I02): until when the
   * uninstaller may delete it, or null.
   */
  dataDeletionAllowedUntil: Timestamp.nullable(),
});
export type SystemStatusResponse = z.infer<typeof SystemStatusResponse>;

/**
 * The Owner allows the uninstaller to delete the data on the data drive for a short while
 * (NFR-I02, P0-16c); needs a fresh second factor and is audited with the reason.
 */
export const AllowDataDeletionRequest = z.strictObject({
  reason: z.string().trim().min(3).max(200),
});
export type AllowDataDeletionRequest = z.infer<typeof AllowDataDeletionRequest>;

export const AllowDataDeletionResponse = z.object({ allowedUntil: Timestamp });
export type AllowDataDeletionResponse = z.infer<typeof AllowDataDeletionResponse>;

/** "Install now" for the version on offer (UPD-004). Audited with the optional reason. */
export const ApproveUpdateRequest = z.strictObject({
  version: z.string().min(1).max(64),
  reason: z.string().trim().min(3).max(200).optional(),
});
export type ApproveUpdateRequest = z.infer<typeof ApproveUpdateRequest>;

/** The bundle a manager can see and send (UPD-008); the Control Plane keeps the same shape. */
export {
  DiagnosticsBundle,
  DiagnosticsRequestParams,
  PendingDiagnosticsRequest,
} from './control-plane/diagnostics.js';

/** "Send diagnostics to support" (UPD-008): an optional note for support. */
export const SendDiagnosticsRequest = z.strictObject({
  note: z.string().trim().max(500).nullable(),
});
export type SendDiagnosticsRequest = z.infer<typeof SendDiagnosticsRequest>;

export const SendDiagnosticsResponse = z.object({
  /** Support's reference for the bundle. */
  id: Id,
  sentAt: Timestamp,
});
export type SendDiagnosticsResponse = z.infer<typeof SendDiagnosticsResponse>;

/** Support's open requests for diagnostics (UPD-008, P7-08b), for a manager to answer. */
export const LocalDiagnosticsRequestList = z.object({
  requests: z.array(PendingDiagnosticsRequestSchema),
});
export type LocalDiagnosticsRequestList = z.infer<typeof LocalDiagnosticsRequestList>;

/**
 * An error in an app on this restaurant's network (NFR-O02, P7-08d): the server reports it to the
 * vendor's error service, scrubbed, so no app holds the service's key.
 */
export const ClientErrorReport = z.strictObject({
  component: z.enum(['console', 'waiter-app', 'table-tablet']),
  message: z.string().max(1_000),
  stack: z.string().max(8_000).nullable(),
  /** Where in the app it happened (a route, without its query). */
  path: z.string().max(200).nullable(),
  appVersion: z.string().max(64).nullable(),
});
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;
