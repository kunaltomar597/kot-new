import { LICENSE_STATES } from '@rp/domain';
import { z } from 'zod';
import { Id, Paise, Timestamp } from '../common.js';

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

// ---------------------------------------------------------------- licences (P7-01)

/** The licence states of LIC-005 (`@rp/domain` `licenseMachine`). */
export const LicenceState = z.enum(LICENSE_STATES);
export type LicenceState = z.infer<typeof LicenceState>;

/** Modules a licence entitles (LIC-001; every module in v1, LIC-010 sells them apart later). */
export const LICENCE_MODULES = [
  'POS',
  'KDS',
  'WAITER_APP',
  'TABLE_TABLET',
  'QR_MENU',
  'PAGERS',
  'RECOMMENDATIONS',
  'REPORTS',
] as const;
export const LicenceModule = z.enum(LICENCE_MODULES);
export type LicenceModule = z.infer<typeof LicenceModule>;

/** How many of each device the restaurant may pair (LIC-001). */
export const DeviceLimits = z.strictObject({
  TABLE_TABLET: z.int().min(0).max(500),
  PAGER: z.int().min(0).max(500),
  WAITER_PHONE: z.int().min(0).max(500),
  KDS: z.int().min(0).max(100),
});
export type DeviceLimits = z.infer<typeof DeviceLimits>;

/** How many identifiers make a PC fingerprint, and how many must match (LIC-004). */
export const FINGERPRINT_SIZE = 5;
export const FINGERPRINT_MATCHES_NEEDED = 3;

/**
 * What a licence file says (LIC-001): whose it is and for which PC, what it entitles, until when,
 * and the state the vendor set. Each fingerprint entry is the SHA-256 of one hardware identifier
 * (never the identifier itself), in a fixed order; null when the PC could not read it.
 */
export const LicencePayload = z.strictObject({
  format: z.literal(1),
  licenceId: Id,
  tenantId: Id,
  installationId: Id,
  fingerprint: z.array(Sha256Hex.nullable()).length(FINGERPRINT_SIZE),
  plan: z.string().min(1).max(40),
  modules: z.array(LicenceModule).max(LICENCE_MODULES.length),
  deviceLimits: DeviceLimits,
  issuedAt: Timestamp,
  /** Rolling validity: 30 days from issue by default, renewed while online (LIC-002). */
  validUntil: Timestamp,
  graceDays: z.int().min(0).max(90),
  state: LicenceState,
  /** When the vendor moved the licence into grace; its days count from here. */
  graceStartedAt: Timestamp.nullable(),
  /** Why the vendor set this state, for the Owner (LIC-008). */
  reason: z.string().max(200).nullable(),
});
export type LicencePayload = z.infer<typeof LicencePayload>;

/**
 * A licence file (LIC-001): the payload as the exact JSON text signed, the vendor's Ed25519
 * signature of that text, and which vendor key signed it.
 */
export const SignedLicence = z.strictObject({
  payload: z.string().min(2).max(8_000),
  signature: Base64.max(100),
  /** The first 16 hex digits of the SHA-256 of the signing key (SPKI DER). */
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
});
export type SignedLicence = z.infer<typeof SignedLicence>;

/**
 * An offline reactivation code (LIC-006), read out over the phone: 16 characters without
 * look-alikes, XXXX-XXXX-XXXX-XXXX.
 */
export const ReactivationCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-HJKMNP-TV-Z]{4}(-?[0-9A-HJKMNP-TV-Z]{4}){3}$/);

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

// ---------------------------------------------------------------- AI menu import (P6-04a)

/** At most this many photos or PDFs per menu (ONB-006). */
export const MENU_EXTRACTION_MAX_FILES = 10;
/** All files together, before base64. */
export const MENU_EXTRACTION_MAX_BYTES = 20 * 1024 * 1024;
/** One photo: the AI provider takes no larger image. */
export const MENU_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const MENU_EXTRACTION_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

const FileBase64 = z
  .string()
  .min(4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Base64 without line breaks');
const base64Bytes = (text: string) =>
  Math.floor((text.length * 3) / 4) - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);

/** A photo or PDF of the printed menu. */
export const MenuExtractionFile = z
  .strictObject({
    name: z.string().min(1).max(200),
    contentType: z.enum(MENU_EXTRACTION_TYPES),
    contentBase64: FileBase64,
  })
  .refine(
    (file) =>
      file.contentType === 'application/pdf' ||
      base64Bytes(file.contentBase64) <= MENU_IMAGE_MAX_BYTES,
    { message: 'A photo may be at most 5 MB', path: ['contentBase64'] },
  );
export type MenuExtractionFile = z.infer<typeof MenuExtractionFile>;

/** ONB-006: read a printed menu into the import template's structure. */
export const MenuExtractionRequest = z
  .strictObject({ files: z.array(MenuExtractionFile).min(1).max(MENU_EXTRACTION_MAX_FILES) })
  .refine(
    (request) =>
      request.files.reduce((total, file) => total + base64Bytes(file.contentBase64), 0) <=
      MENU_EXTRACTION_MAX_BYTES,
    { message: 'The files may be at most 20 MB together', path: ['files'] },
  );
export type MenuExtractionRequest = z.infer<typeof MenuExtractionRequest>;

/** A dish as read from the printed menu; everything the restaurant must still set is left out. */
export const MenuDraftItem = z.strictObject({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500).nullable(),
  /** Null when only its sizes carry prices. */
  price: Paise.nullable(),
  /** Sizes or portions, e.g. Half and Full, each with its price. */
  variants: z.array(z.strictObject({ name: z.string().min(1).max(40), price: Paise })).max(10),
  /** As marked on the menu (the green and red symbols, or words); null when not marked. */
  foodType: z.enum(['VEG', 'NON_VEG', 'EGG']).nullable(),
  spiceLevel: z.int().min(0).max(3).nullable(),
  tags: z.array(z.string().min(1).max(30)).max(10),
  /** What the reader was unsure of, for the person who checks it (ONB-006). */
  note: z.string().min(1).max(200).nullable(),
});
export type MenuDraftItem = z.infer<typeof MenuDraftItem>;

/** A printed menu as read: its sections and dishes, and add-ons offered with them. */
export const MenuDraft = z.strictObject({
  categories: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(60),
        items: z.array(MenuDraftItem).min(1).max(500),
      }),
    )
    .max(60),
  /** "Add extra cheese ₹40": priced extras that become modifier groups. */
  addOns: z
    .array(
      z.strictObject({
        group: z.string().min(1).max(60),
        options: z
          .array(z.strictObject({ name: z.string().min(1).max(60), price: Paise }))
          .min(1)
          .max(30),
      }),
    )
    .max(30),
  /** Remarks for the whole menu, e.g. "Prices on page 2 were cut off". */
  notes: z.array(z.string().min(1).max(300)).max(20),
});
export type MenuDraft = z.infer<typeof MenuDraft>;

export const MenuExtractionStatus = z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED']);
export type MenuExtractionStatus = z.infer<typeof MenuExtractionStatus>;

export const MenuExtractionView = z.object({
  id: Id,
  status: MenuExtractionStatus,
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  /** Why it failed, in words a manager can act on. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** The menu as read, once DONE: a draft for a person to check (ONB-006). */
  draft: MenuDraft.nullable(),
});
export type MenuExtractionView = z.infer<typeof MenuExtractionView>;

export const MenuExtractionParams = z.strictObject({ extractionId: Id });
export type MenuExtractionParams = z.infer<typeof MenuExtractionParams>;

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
  /** The vendor has not set up the AI provider (ONB-006). */
  aiImportUnavailable: 'AI_IMPORT_UNAVAILABLE',
  /** This restaurant read its daily number of menus already. */
  aiImportLimit: 'AI_IMPORT_LIMIT',
  menuExtractionNotFound: 'MENU_EXTRACTION_NOT_FOUND',
  /** Why an extraction failed (in `MenuExtractionView.error.code`). */
  aiProviderFailed: 'AI_PROVIDER_FAILED',
  aiNoMenuFound: 'AI_NO_MENU_FOUND',
} as const;
