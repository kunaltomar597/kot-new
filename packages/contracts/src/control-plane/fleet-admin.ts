import { isValidGstin } from '@rp/domain';
import { z } from 'zod';
import { Id, IsoDate, Timestamp } from '../common.js';
import {
  DeviceLimits,
  LicenceModule,
  LicenceState,
  ReleaseChannel,
  ReleaseComponent,
  ReleaseInfo,
  SemVer,
  Sha256Hex,
} from './schemas.js';

/**
 * What vendor staff see and do about the fleet (VCP-002, VCP-003, VCP-006, P7-02b): tenants with
 * their contacts and GSTIN, installations and activation codes, licences, releases and the audit
 * trail. The web app (P7-02e) and the CLI drive the same services.
 */

const Reason = z.string().trim().min(3).max(200);
const Text = (max: number) => z.string().trim().min(1).max(max);

export const TenantRequest = z.strictObject({
  name: Text(120),
  legalName: Text(200).nullable(),
  /** The restaurant's GSTIN, upper case (BILL-002). */
  gstin: z.string().trim().toUpperCase().refine(isValidGstin, 'Not a valid GSTIN').nullable(),
  /** The GST state code, two digits, where it trades. */
  stateCode: z
    .string()
    .regex(/^\d{2}$/)
    .nullable(),
  contactName: Text(120),
  contactEmail: z.string().trim().toLowerCase().pipe(z.email().max(200)).nullable(),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/)
    .nullable(),
});
export type TenantRequest = z.infer<typeof TenantRequest>;

export const VendorLicenceView = z.object({
  installationId: Id,
  state: LicenceState,
  reason: z.string().nullable(),
  plan: z.string(),
  modules: z.array(LicenceModule),
  deviceLimits: DeviceLimits,
  validityDays: z.int().positive(),
  graceDays: z.int().nonnegative(),
  graceStartedAt: Timestamp.nullable(),
  /** When the PC fingerprint was bound (LIC-004); null until the first licence. */
  boundAt: Timestamp.nullable(),
  latest: z
    .object({ id: Id, issuedAt: Timestamp, validUntil: Timestamp, state: LicenceState })
    .nullable(),
});
export type VendorLicenceView = z.infer<typeof VendorLicenceView>;

export const VendorInstallationView = z.object({
  id: Id,
  tenantId: Id,
  name: z.string(),
  status: z.enum(['PENDING', 'ACTIVE', 'REVOKED']),
  channel: ReleaseChannel,
  enrolledAt: Timestamp.nullable(),
  lastSeenAt: Timestamp.nullable(),
  /** The installed `RESTAURANT_PC` version, from the last heartbeat. */
  version: z.string().nullable(),
  licenceState: LicenceState.nullable(),
  /** Held at this version by the vendor (UPD-002); null when it follows its channel. */
  pinnedVersion: SemVer.nullable().default(null),
});
export type VendorInstallationView = z.infer<typeof VendorInstallationView>;

/** Hold a PC at a version, or let it follow its channel again (UPD-002). */
export const PinInstallationRequest = z.strictObject({
  version: SemVer.nullable(),
  reason: Reason,
});
export type PinInstallationRequest = z.infer<typeof PinInstallationRequest>;

export const VendorTenantView = TenantRequest.extend({
  id: Id,
  installations: z.int().nonnegative(),
  /** The most severe licence state among its installations, for the list. */
  licenceState: LicenceState.nullable(),
  createdAt: Timestamp,
});
export type VendorTenantView = z.infer<typeof VendorTenantView>;

export const VendorTenantDetail = VendorTenantView.extend({
  installationList: z.array(VendorInstallationView),
});
export type VendorTenantDetail = z.infer<typeof VendorTenantDetail>;

export const VendorTenantListResponse = z.object({ tenants: z.array(VendorTenantView) });
export type VendorTenantListResponse = z.infer<typeof VendorTenantListResponse>;

export const VendorTenantParams = z.strictObject({ id: Id });
export type VendorTenantParams = z.infer<typeof VendorTenantParams>;

export const VendorInstallationParams = z.strictObject({ id: Id });
export type VendorInstallationParams = z.infer<typeof VendorInstallationParams>;

export const CreateInstallationRequest = z.strictObject({
  name: Text(120),
  channel: ReleaseChannel.default('STABLE'),
});
export type CreateInstallationRequest = z.input<typeof CreateInstallationRequest>;

/** An activation code (ONB-003): shown once, given to the installer, valid 7 days. */
export const ActivationCodeView = z.object({
  installationId: Id,
  code: z.string(),
  expiresAt: Timestamp,
});
export type ActivationCodeView = z.infer<typeof ActivationCodeView>;

export const ReasonRequest = z.strictObject({ reason: Reason });
export type ReasonRequest = z.infer<typeof ReasonRequest>;

/** A licence change (VCP-003): its state along LIC-005, plan, limits or days, with a reason. */
export const LicenceChangeRequest = z.strictObject({
  state: LicenceState.optional(),
  plan: Text(40).optional(),
  deviceLimits: DeviceLimits.optional(),
  validityDays: z.int().min(1).max(365).optional(),
  graceDays: z.int().min(0).max(90).optional(),
  reason: Reason,
});
export type LicenceChangeRequest = z.infer<typeof LicenceChangeRequest>;

export const ReactivationCodeRequest = z.strictObject({ until: IsoDate });
export type ReactivationCodeRequest = z.infer<typeof ReactivationCodeRequest>;

/** An offline reactivation code (LIC-006): shown once, read to the Owner over the phone. */
export const ReactivationCodeView = z.object({
  code: z.string(),
  validUntil: IsoDate,
  counter: z.int().positive(),
});
export type ReactivationCodeView = z.infer<typeof ReactivationCodeView>;

export const RolloutState = z.enum(['ACTIVE', 'PAUSED', 'HALTED']);
export type RolloutState = z.infer<typeof RolloutState>;

/** A release with its rollout (UPD-003) and how installing it is going. */
export const VendorReleaseView = ReleaseInfo.extend({
  id: Id,
  rollout: z.object({
    percent: z.int().min(0).max(100),
    state: RolloutState,
    /** PCs offered it whatever their bucket. */
    cohort: z.array(z.object({ id: Id, name: z.string() })),
    haltReason: z.string().nullable(),
    changedAt: Timestamp,
  }),
  /** A hotfix: the one PC it is for. */
  target: z.object({ id: Id, name: z.string() }).nullable(),
  installs: z.object({
    /** PCs that started installing it or run it. */
    attempts: z.int().nonnegative(),
    installed: z.int().nonnegative(),
    failures: z.int().nonnegative(),
    errorSpikes: z.int().nonnegative(),
  }),
});
export type VendorReleaseView = z.infer<typeof VendorReleaseView>;

export const VendorReleaseListResponse = z.object({ releases: z.array(VendorReleaseView) });
export type VendorReleaseListResponse = z.infer<typeof VendorReleaseListResponse>;

export const VendorReleaseParams = z.object({ id: Id });
export type VendorReleaseParams = z.infer<typeof VendorReleaseParams>;

/** Widen, narrow, pause, resume or halt a rollout (UPD-003). */
export const UpdateRolloutRequest = z.strictObject({
  percent: z.int().min(0).max(100),
  state: RolloutState,
  cohort: z.array(Id).max(100).default([]),
  reason: Reason,
});
export type UpdateRolloutRequest = z.input<typeof UpdateRolloutRequest>;

/** A release CI built and signed (VCP-006). */
export const PublishReleaseRequest = z.strictObject({
  component: ReleaseComponent.default('RESTAURANT_PC'),
  channel: ReleaseChannel,
  version: SemVer,
  url: z.url({ protocol: /^https$/ }),
  sha256: Sha256Hex,
  sizeBytes: z.int().positive(),
  notes: z.string().max(2_000).nullable().default(null),
  /** UPD-004: may install while tables are open, with a manager's approval. */
  securityCritical: z.boolean().default(false),
  /** The share of the channel's PCs offered it at once (UPD-003); 100 for all. */
  rolloutPercent: z.int().min(0).max(100).default(100),
  /** A hotfix for this PC only (UPD-002). */
  targetInstallationId: Id.nullable().default(null),
});
export type PublishReleaseRequest = z.input<typeof PublishReleaseRequest>;

export const AuditQuery = z.strictObject({
  targetId: Id.optional(),
  action: z
    .string()
    .regex(/^[a-z_.]{1,60}$/)
    .optional(),
  /** Entries before this id, for the next page. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.input<typeof AuditQuery>;

export const AuditEntryView = z.object({
  id: z.string(),
  at: Timestamp,
  actor: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  details: z.unknown().nullable(),
});
export type AuditEntryView = z.infer<typeof AuditEntryView>;

export const AuditListResponse = z.object({ entries: z.array(AuditEntryView) });
export type AuditListResponse = z.infer<typeof AuditListResponse>;

/** A note about a restaurant for the support team (VCP-007): kept, never edited or deleted. */
export const SupportNoteRequest = z.strictObject({ body: z.string().trim().min(1).max(2_000) });
export type SupportNoteRequest = z.infer<typeof SupportNoteRequest>;

export const SupportNoteView = z.object({
  id: Id,
  tenantId: Id,
  /** `vendor:<id>` of who wrote it, and their name. */
  author: z.string(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: Timestamp,
});
export type SupportNoteView = z.infer<typeof SupportNoteView>;

export const SupportNoteListResponse = z.object({ notes: z.array(SupportNoteView) });
export type SupportNoteListResponse = z.infer<typeof SupportNoteListResponse>;

/**
 * The restaurant in the QR relay (VCP-002, VCP-008): provisioned with its own scoped credential,
 * which reaches its PC in a heartbeat answer; `delivered` once the PC reports holding it.
 */
export const RelayProvisioningView = z.object({
  tenantId: Id,
  provisionedAt: Timestamp,
  credentialIssuedAt: Timestamp,
  delivered: z.boolean(),
  deliveredAt: Timestamp.nullable(),
});
export type RelayProvisioningView = z.infer<typeof RelayProvisioningView>;
