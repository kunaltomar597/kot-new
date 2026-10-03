import { z } from 'zod';
import { Id, Timestamp } from '../common.js';

/**
 * Vendor staff of the Control Plane (VCP-001, SEC-018, P7-02): five roles, least privilege, MFA
 * mandatory, every action audited. The matrix is shared by the API (which enforces it) and the
 * web app (which only hides what a role cannot do).
 */

export const VENDOR_ROLES = [
  'SUPER_ADMIN',
  'ONBOARDING',
  'SUPPORT',
  'FINANCE',
  'READ_ONLY',
] as const;
export const VendorRole = z.enum(VENDOR_ROLES);
export type VendorRole = z.infer<typeof VendorRole>;

export const VENDOR_CAPABILITIES = [
  /** Tenants, installations, licences, fleet, releases: read. Every role. */
  'FLEET_VIEW',
  /** Create and change tenants; installations and their activation codes; QR provisioning. */
  'TENANTS_MANAGE',
  /** Move a licence to a new PC (LIC-004). */
  'LICENCE_REBIND',
  /** Licence states, plans and limits (LIC-005, VCP-003). */
  'LICENCES_MANAGE',
  /** Offline reactivation codes (LIC-006). */
  'REACTIVATION_CODES',
  /** Plans, subscriptions, vendor invoices and payments (VCP-003). */
  'BILLING_MANAGE',
  /** Notes per restaurant and diagnostics requests (VCP-007). */
  'SUPPORT_NOTES',
  /** Publish and manage releases (VCP-006). */
  'RELEASES_MANAGE',
  /** Vendor staff accounts and access reviews (SEC-018). */
  'USERS_MANAGE',
  /** The Control Plane's audit trail. */
  'AUDIT_VIEW',
  /** Vendor settings and feature flags pushed to restaurant PCs (UPD-010). Super Admin only. */
  'REMOTE_CONFIG',
  /**
   * Issue a restore code that releases a restaurant's escrowed backup key (DATA-003, OI-10),
   * after verifying its Owner. The restaurant's Owner is told.
   */
  'BACKUP_RESTORE',
] as const;
export const VendorCapability = z.enum(VENDOR_CAPABILITIES);
export type VendorCapability = z.infer<typeof VendorCapability>;

const MATRIX: Readonly<Record<VendorRole, readonly VendorCapability[]>> = {
  SUPER_ADMIN: VENDOR_CAPABILITIES,
  ONBOARDING: ['FLEET_VIEW', 'TENANTS_MANAGE', 'LICENCE_REBIND', 'SUPPORT_NOTES'],
  SUPPORT: [
    'FLEET_VIEW',
    'LICENCE_REBIND',
    'REACTIVATION_CODES',
    'SUPPORT_NOTES',
    'BACKUP_RESTORE',
  ],
  FINANCE: ['FLEET_VIEW', 'LICENCES_MANAGE', 'REACTIVATION_CODES', 'BILLING_MANAGE', 'AUDIT_VIEW'],
  READ_ONLY: ['FLEET_VIEW'],
};

/** Whether a vendor role may do something (deny by default, SEC-003). */
export function vendorMay(role: VendorRole, capability: VendorCapability): boolean {
  return MATRIX[role].includes(capability);
}

/** Every capability a role has, for the web app. */
export function vendorCapabilitiesOf(role: VendorRole): readonly VendorCapability[] {
  return MATRIX[role];
}

const Email = z.string().trim().toLowerCase().pipe(z.email().max(200));
/** At least 12 characters (NIST SP 800-63B), at most 200. */
const Password = z.string().min(12).max(200);
const TotpCode = z.string().regex(/^\d{6}$/);
/** One-time setup token for a new account or a reset: 43 base64url characters (256 bits). */
const SetupToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const VendorUserView = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  role: VendorRole,
  /** Set up with a password and an authenticator (MFA is mandatory). */
  active: z.boolean(),
  disabled: z.boolean(),
  /** Locked for a while after too many failed sign-ins. */
  lockedUntil: Timestamp.nullable(),
  lastSignInAt: Timestamp.nullable(),
  /** The last quarterly access review that kept this account (SEC-018). */
  reviewedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type VendorUserView = z.infer<typeof VendorUserView>;

/** Email, password and the authenticator's code together: MFA is never optional (VCP-001). */
export const VendorSignInRequest = z.strictObject({
  email: Email,
  password: z.string().min(1).max(200),
  code: TotpCode,
});
export type VendorSignInRequest = z.infer<typeof VendorSignInRequest>;

export const VendorSessionView = z.object({
  /** Bearer token for `Authorization`; kept only as a hash on the server. */
  token: z.string(),
  expiresAt: Timestamp,
  user: VendorUserView,
  capabilities: z.array(VendorCapability),
});
export type VendorSessionView = z.infer<typeof VendorSessionView>;

/** The person signed in, for the web app. */
export const VendorMeView = z.object({
  user: VendorUserView,
  capabilities: z.array(VendorCapability),
  expiresAt: Timestamp,
});
export type VendorMeView = z.infer<typeof VendorMeView>;

/** Step 1 of setting up an account: the password; the answer is the authenticator to add. */
export const VendorSetupRequest = z.strictObject({ token: SetupToken, password: Password });
export type VendorSetupRequest = z.infer<typeof VendorSetupRequest>;

export const VendorSetupResponse = z.object({
  /** For authenticator apps (shown as a QR code). */
  otpauthUri: z.string(),
  /** The same secret, base 32, to type in by hand. */
  secret: z.string(),
});
export type VendorSetupResponse = z.infer<typeof VendorSetupResponse>;

/** Step 2: a code from the authenticator proves it was added; the account is then active. */
export const VendorSetupConfirmRequest = z.strictObject({ token: SetupToken, code: TotpCode });
export type VendorSetupConfirmRequest = z.infer<typeof VendorSetupConfirmRequest>;

export const CreateVendorUserRequest = z.strictObject({
  email: Email,
  name: z.string().trim().min(1).max(120),
  role: VendorRole,
});
export type CreateVendorUserRequest = z.infer<typeof CreateVendorUserRequest>;

/** A new account, or a reset one: the setup token goes to the person out of band, once. */
export const VendorSetupTokenView = z.object({
  user: VendorUserView,
  setupToken: z.string(),
  setupExpiresAt: Timestamp,
});
export type VendorSetupTokenView = z.infer<typeof VendorSetupTokenView>;

export const UpdateVendorUserRequest = z
  .strictObject({
    role: VendorRole.optional(),
    disabled: z.boolean().optional(),
    reason: z.string().trim().min(3).max(200),
  })
  .refine((change) => change.role !== undefined || change.disabled !== undefined, {
    message: 'Change the role or whether the account is disabled',
  });
export type UpdateVendorUserRequest = z.infer<typeof UpdateVendorUserRequest>;

export const VendorUserParams = z.strictObject({ id: Id });
export type VendorUserParams = z.infer<typeof VendorUserParams>;

export const VendorUserListResponse = z.object({ users: z.array(VendorUserView) });
export type VendorUserListResponse = z.infer<typeof VendorUserListResponse>;

/** The quarterly access review (SEC-018): the accounts kept; the others are disabled. */
export const VendorAccessReviewRequest = z.strictObject({
  keep: z.array(Id).max(500),
  note: z.string().trim().min(3).max(500),
});
export type VendorAccessReviewRequest = z.infer<typeof VendorAccessReviewRequest>;
