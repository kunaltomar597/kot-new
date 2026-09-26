import { z } from 'zod';
import { Id, Timestamp } from '../common.js';

/**
 * Contracts of the Vendor Control Plane API (ADR-0012): installation enrolment, heartbeats
 * (VCP-005) and release channels (UPD-002). A separate entry point, `@rp/contracts/control-plane`,
 * with its own generated document, `docs/api/control-plane.openapi.json`.
 */

/** Release channels an installation follows (UPD-002). */
export const RELEASE_CHANNELS = ['STABLE', 'PILOT'] as const;
export const ReleaseChannel = z.enum(RELEASE_CHANNELS);
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;

/** What a release installs: `RESTAURANT_PC` is the Windows installer (server, console, shell). */
export const RELEASE_COMPONENTS = ['RESTAURANT_PC'] as const;
export const ReleaseComponent = z.enum(RELEASE_COMPONENTS);
export type ReleaseComponent = z.infer<typeof ReleaseComponent>;

/** Semantic version (MAJOR.MINOR.PATCH with an optional pre-release), e.g. `1.4.0-beta.2`. */
export const SemVer = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);

/** SHA-256 digest as lower-case hex. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

/**
 * One-time enrolment code from the vendor: 16 characters from an alphabet without look-alikes
 * (80 bits), shown as XXXX-XXXX-XXXX-XXXX. Valid 7 days, used once (ADR-0012).
 */
export const EnrolmentCode = z.string().regex(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);

/** What an installation signs to prove it holds its key when enrolling: `rp-cp-enrol:v1:<code>`. */
export function enrolmentProofMessage(code: string): string {
  return `rp-cp-enrol:v1:${code}`;
}

/** A restaurant PC registers its public key with a one-time code (ADR-0012; ONB-003 in P7-01). */
export const EnrolRequest = z.strictObject({
  code: EnrolmentCode,
  /** Ed25519 public key, SPKI DER, base64. */
  publicKey: Base64.max(200),
  /** Ed25519 signature of `enrolmentProofMessage(code)`, base64. */
  proof: Base64.max(200),
});
export type EnrolRequest = z.infer<typeof EnrolRequest>;

export const EnrolResponse = z.object({
  installationId: Id,
  tenantId: Id,
  name: z.string(),
  channel: ReleaseChannel,
  enrolledAt: Timestamp,
});
export type EnrolResponse = z.infer<typeof EnrolResponse>;

/** A component's installed version as a heartbeat reports it. */
export const ComponentVersion = z.object({
  /** `RESTAURANT_PC` (what releases are compared with), or informational: `server`, `node`, ... */
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
  version: z.string().min(1).max(64),
});
export type ComponentVersion = z.infer<typeof ComponentVersion>;

/**
 * An installation's periodic report (VCP-005, NFR-O03). Fields later work packages add (backup
 * status, error counts, licence state) are kept even when this Control Plane does not know them
 * yet, so a newer installation is never refused.
 */
export const HeartbeatRequest = z.looseObject({
  /** Chosen by the installation; sending the same heartbeat again is harmless. */
  heartbeatId: Id,
  sentAt: Timestamp,
  components: z.array(ComponentVersion).min(1).max(30),
  /** The data drive (ONB-002). */
  disk: z
    .object({ totalBytes: z.int().nonnegative(), freeBytes: z.int().nonnegative() })
    .nullable(),
  /** The latest local audit entry (AUD-003), so tampering can be detected later. */
  auditChainHead: z.object({ sequence: z.int().positive(), hash: Sha256Hex }).nullable(),
  /** Active paired devices by type, e.g. `{ "POS": 1, "KDS": 2 }`. */
  devices: z.record(z.string().regex(/^[A-Z_]{1,40}$/), z.int().nonnegative()),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

/** A published release (UPD-002, UPD-007): the artefact is Authenticode-signed; check its SHA-256. */
export const ReleaseInfo = z.object({
  component: ReleaseComponent,
  channel: ReleaseChannel,
  version: SemVer,
  url: z.url({ protocol: /^https$/ }),
  sha256: Sha256Hex,
  sizeBytes: z.int().positive(),
  notes: z.string().max(2_000).nullable(),
  publishedAt: Timestamp,
});
export type ReleaseInfo = z.infer<typeof ReleaseInfo>;

export const HeartbeatResponse = z.object({
  receivedAt: Timestamp,
  /** The Control Plane's clock, for clock checks on the PC (LIC-007). */
  serverTime: Timestamp,
  /** When to send the next heartbeat: a fleet setting, 300 s by default (VCP-005, UPD-010). */
  nextHeartbeatSeconds: z.int().min(60).max(3_600),
  /** The release this installation should move to, or null when it is up to date (UPD-002). */
  update: ReleaseInfo.nullable(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** `GET /v1/updates`: what the installation should move to from `version`. */
export const UpdatesQuery = z.strictObject({
  component: ReleaseComponent.default('RESTAURANT_PC'),
  version: SemVer,
});
export type UpdatesQuery = z.infer<typeof UpdatesQuery>;

export const UpdatesResponse = z.object({
  channel: ReleaseChannel,
  update: ReleaseInfo.nullable(),
});
export type UpdatesResponse = z.infer<typeof UpdatesResponse>;

/** Error codes of the Control Plane API (in `ApiError.code`). */
export const CONTROL_PLANE_ERRORS = {
  /** Missing or malformed signature headers, unknown installation or a signature that fails. */
  signatureInvalid: 'SIGNATURE_INVALID',
  /** The timestamp is outside the window; `details.serverTime` says the Control Plane's time. */
  clockSkew: 'CLOCK_SKEW',
  /** The nonce was already used by this installation. */
  nonceReused: 'NONCE_REUSED',
  /** The vendor revoked this installation (after a valid signature). */
  installationRevoked: 'INSTALLATION_REVOKED',
  /** Unknown, used or expired enrolment code, or a proof that does not match the key. */
  enrolmentInvalid: 'ENROLMENT_INVALID',
  tooManyAttempts: 'TOO_MANY_ATTEMPTS',
} as const;
