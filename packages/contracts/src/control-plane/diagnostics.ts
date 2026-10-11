import { z } from 'zod';
import { Id, Timestamp } from '../common.js';

/**
 * Diagnostics (UPD-008, VCP-007, P7-08): what a restaurant PC sends support when a manager
 * allows it. Versions, configuration without secrets, the device list, system status and the
 * tail of the logs, scrubbed of secrets and personal data before it leaves the PC.
 */

/** The largest bundle the Control Plane takes, as JSON. */
export const DIAGNOSTICS_MAX_BYTES = 4 * 1024 * 1024;

/** Days the Control Plane keeps a bundle before deleting it (the vendor access policy). */
export const DIAGNOSTICS_KEEP_DAYS = 30;

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const DiagnosticsBundle = z.object({
  format: z.literal(1),
  generatedAt: Timestamp,
  installationId: Id.nullable(),
  versions: z.array(z.object({ name: z.string().max(60), version: z.string().max(64) })).max(30),
  platform: z.object({
    os: z.string().max(60),
    release: z.string().max(120),
    arch: z.string().max(30),
    cpus: z.int().nonnegative(),
    memoryMb: z.int().nonnegative(),
    uptimeSeconds: z.int().nonnegative(),
    serverUptimeSeconds: z.int().nonnegative(),
  }),
  /** Chosen configuration values; never secrets, keys or connection strings. */
  configuration: z.record(z.string(), Scalar),
  /** Settings that differ from the default, scrubbed. */
  settings: z.record(z.string(), z.unknown()),
  /** The System page's status as it was when the bundle was made. */
  status: z.record(z.string(), z.unknown()),
  devices: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
        status: z.string(),
        online: z.boolean(),
        lastSeenAt: Timestamp.nullable(),
        appVersion: z.string().nullable(),
      }),
    )
    .max(500),
  logs: z.object({
    files: z.array(z.object({ name: z.string().max(200), lines: z.array(z.string()) })).max(20),
    /** Older lines were left out to keep the bundle small. */
    truncated: z.boolean(),
  }),
});
export type DiagnosticsBundle = z.infer<typeof DiagnosticsBundle>;

/** Who sent it from the restaurant, as the manager's console knows them. */
export const DiagnosticsSender = z.object({
  name: z.string().max(120),
  role: z.string().max(40),
});

export const DiagnosticsUploadRequest = z.object({
  bundle: DiagnosticsBundle,
  note: z.string().trim().max(500).nullable(),
  sentBy: DiagnosticsSender.nullable(),
  /** The support request it answers (P7-08b), if any. */
  requestId: Id.nullable().default(null),
});
export type DiagnosticsUploadRequest = z.input<typeof DiagnosticsUploadRequest>;

export const DiagnosticsUploadResponse = z.object({ id: Id, receivedAt: Timestamp });
export type DiagnosticsUploadResponse = z.infer<typeof DiagnosticsUploadResponse>;

export const VendorDiagnosticsView = z.object({
  id: Id,
  installationId: Id,
  receivedAt: Timestamp,
  note: z.string().nullable(),
  sentBy: DiagnosticsSender.nullable(),
  sizeBytes: z.int().nonnegative(),
  requestId: Id.nullable(),
});
export type VendorDiagnosticsView = z.infer<typeof VendorDiagnosticsView>;

export const VendorDiagnosticsListResponse = z.object({ bundles: z.array(VendorDiagnosticsView) });
export type VendorDiagnosticsListResponse = z.infer<typeof VendorDiagnosticsListResponse>;

export const VendorDiagnosticsDetail = VendorDiagnosticsView.extend({ bundle: DiagnosticsBundle });
export type VendorDiagnosticsDetail = z.infer<typeof VendorDiagnosticsDetail>;

export const DiagnosticsParams = z.strictObject({ id: Id });
export type DiagnosticsParams = z.infer<typeof DiagnosticsParams>;

/** How long a support request waits for the restaurant's answer. */
export const DIAGNOSTICS_REQUEST_DAYS = 7;

export const DIAGNOSTICS_REQUEST_STATES = ['PENDING', 'FULFILLED', 'DECLINED', 'EXPIRED'] as const;
export const DiagnosticsRequestState = z.enum(DIAGNOSTICS_REQUEST_STATES);
export type DiagnosticsRequestState = z.infer<typeof DiagnosticsRequestState>;

/** Support asks for diagnostics (UPD-008, P7-08b): as the restaurant's manager sees it. */
export const PendingDiagnosticsRequest = z.object({
  id: Id,
  /** The support person's name. */
  requestedBy: z.string().max(120),
  reason: z.string().max(300),
  requestedAt: Timestamp,
  expiresAt: Timestamp,
});
export type PendingDiagnosticsRequest = z.infer<typeof PendingDiagnosticsRequest>;

export const DiagnosticsRequestView = PendingDiagnosticsRequest.extend({
  installationId: Id,
  state: DiagnosticsRequestState,
  answeredAt: Timestamp.nullable(),
  /** The manager who allowed or declined it. */
  answeredBy: DiagnosticsSender.nullable(),
  /** The bundle sent when it was allowed. */
  bundleId: Id.nullable(),
});
export type DiagnosticsRequestView = z.infer<typeof DiagnosticsRequestView>;

export const DiagnosticsRequestListResponse = z.object({
  requests: z.array(DiagnosticsRequestView),
});
export type DiagnosticsRequestListResponse = z.infer<typeof DiagnosticsRequestListResponse>;

export const CreateDiagnosticsRequest = z.strictObject({
  reason: z.string().trim().min(3).max(300),
});
export type CreateDiagnosticsRequest = z.infer<typeof CreateDiagnosticsRequest>;

/** The restaurant declines (sent by its PC with the manager's name). */
export const DeclineDiagnosticsRequest = z.object({ by: DiagnosticsSender });
export type DeclineDiagnosticsRequest = z.infer<typeof DeclineDiagnosticsRequest>;

export const DiagnosticsRequestParams = z.strictObject({ id: Id });
export type DiagnosticsRequestParams = z.infer<typeof DiagnosticsRequestParams>;
