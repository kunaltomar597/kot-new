import { FLEET_ALERT_KINDS } from '@rp/domain';
import { z } from 'zod';
import { Id, IsoDate, Timestamp } from '../common.js';
import {
  ComponentVersion,
  HeartbeatBackup,
  LicenceState,
  ReleaseChannel,
  Sha256Hex,
} from './schemas.js';

/**
 * Fleet monitoring for vendor staff (VCP-005, AUD-003, DATA-005, P7-03): every PC's health from
 * its latest heartbeat, the alerts the Control Plane opened, and each PC's audit chain heads.
 */

export const FleetAlertKind = z.enum(FLEET_ALERT_KINDS);
export type FleetAlertKind = z.infer<typeof FleetAlertKind>;

export const FleetAlertView = z.object({
  id: Id,
  installationId: Id,
  installationName: z.string(),
  tenantId: Id,
  tenantName: z.string(),
  kind: FleetAlertKind,
  openedAt: Timestamp,
  /** Null while open. Offline, disk and backup alerts close by themselves when fixed. */
  resolvedAt: Timestamp.nullable(),
  /** What was seen: minutes offline, disk use, the backup error, the chain's sequence. */
  details: z.record(z.string(), z.unknown()).nullable(),
  /** `system:fleet` when it closed by itself, else the person. */
  resolvedBy: z.string().nullable(),
  resolution: z.string().nullable(),
});
export type FleetAlertView = z.infer<typeof FleetAlertView>;

export const FleetAlertListResponse = z.object({ alerts: z.array(FleetAlertView) });
export type FleetAlertListResponse = z.infer<typeof FleetAlertListResponse>;

export const FleetAlertQuery = z.strictObject({
  state: z.enum(['OPEN', 'ALL']).default('OPEN'),
  installationId: Id.optional(),
});
export type FleetAlertQuery = z.input<typeof FleetAlertQuery>;

export const FleetAlertParams = z.strictObject({ id: Id });
export type FleetAlertParams = z.infer<typeof FleetAlertParams>;

/** One PC as the fleet dashboard shows it. */
export const FleetInstallationView = z.object({
  installationId: Id,
  installationName: z.string(),
  tenantId: Id,
  tenantName: z.string(),
  status: z.enum(['PENDING', 'ACTIVE', 'REVOKED']),
  channel: ReleaseChannel,
  /** Heard from within the offline threshold. */
  online: z.boolean(),
  lastSeenAt: Timestamp.nullable(),
  components: z.array(ComponentVersion),
  disk: z
    .object({
      totalBytes: z.int().nonnegative(),
      freeBytes: z.int().nonnegative(),
      usedPercent: z.int().min(0).max(100).nullable(),
    })
    .nullable(),
  backup: HeartbeatBackup.nullable(),
  /** The newest backup this PC stored in the cloud (DATA-003, P7-05d), from the Control Plane's record. */
  cloudBackupAt: Timestamp.nullable(),
  /** When the PC's current backup key was escrowed (P7-05e); null when it is not. */
  backupKeyEscrowedAt: Timestamp.nullable(),
  /** Paired devices by type, and how many are connected (null from PCs older than P7-03). */
  devices: z.array(
    z.object({
      type: z.string(),
      paired: z.int().nonnegative(),
      connected: z.int().nonnegative().nullable(),
    }),
  ),
  /** Server errors reported in the latest heartbeat. */
  errorCount: z.int().nonnegative().nullable(),
  licenceState: LicenceState.nullable(),
  auditHead: z
    .object({
      sequence: z.int().positive(),
      hash: Sha256Hex,
      /** The last time an answered audit check matched (AUD-003). */
      verifiedAt: Timestamp.nullable(),
    })
    .nullable(),
  openAlerts: z.array(FleetAlertKind),
});
export type FleetInstallationView = z.infer<typeof FleetInstallationView>;

export const FleetResponse = z.object({
  installations: z.array(FleetInstallationView),
  generatedAt: Timestamp,
});
export type FleetResponse = z.infer<typeof FleetResponse>;

/** A head of a PC's audit chain as first reported (AUD-003). */
export const AuditHeadView = z.object({
  sequence: z.int().positive(),
  hash: Sha256Hex,
  firstSeenAt: Timestamp,
  /** When a later audit check found the PC still holding this hash. */
  verifiedAt: Timestamp.nullable(),
  /** Set aside when a person closed a chain alert: the chain then counts from its new head. */
  superseded: z.boolean(),
});
export type AuditHeadView = z.infer<typeof AuditHeadView>;

export const AuditHeadListResponse = z.object({ heads: z.array(AuditHeadView) });
export type AuditHeadListResponse = z.infer<typeof AuditHeadListResponse>;

/** BRD §2: local availability in trading hours, in basis points (99.9 %). */
export const AVAILABILITY_TARGET_BP = 9_990;
export const AVAILABILITY_MAX_DAYS = 31;

export const AvailabilityQuery = z.strictObject({
  /** The last this many days, today included. */
  days: z.coerce.number().int().min(1).max(AVAILABILITY_MAX_DAYS).default(30),
});
export type AvailabilityQuery = z.output<typeof AvailabilityQuery>;

const AvailabilityFigures = z.object({
  /** Minutes the restaurant was open (all minutes when the PC reports no opening hours). */
  openMinutes: z.int().min(0),
  /** Open minutes in which the PC had been silent past the offline threshold. */
  downMinutes: z.int().min(0),
  /** Basis points of the open minutes the PC was reachable; null when never open. */
  availabilityBp: z.int().min(0).max(10_000).nullable(),
});

/**
 * Local availability in trading hours from the heartbeat history (BRD §2, VCP-005): the whole
 * period and each day, in the restaurant's time zone. Days before the PC's first heartbeat are
 * left out.
 */
export const AvailabilityResponse = z.object({
  installationId: Id,
  timeZone: z.string(),
  from: IsoDate,
  to: IsoDate,
  targetBp: z.int(),
  /** Null when the period had no open minutes to judge. */
  meetsTarget: z.boolean().nullable(),
  totals: AvailabilityFigures,
  days: z.array(AvailabilityFigures.extend({ date: IsoDate })),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponse>;
