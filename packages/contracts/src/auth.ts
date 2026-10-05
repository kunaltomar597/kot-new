import { CAPABILITIES } from '@rp/domain';
import { z } from 'zod';
import { Id, Role, Timestamp } from './common.js';

/** A capability from the BRD §4.2 matrix (`@rp/domain` permissions). */
export const Capability = z.enum(CAPABILITIES);

/**
 * Header carrying a single-use manager override token (AUTH-011) on the request that performs the
 * overridden action.
 */
export const OVERRIDE_TOKEN_HEADER = 'x-override-token';

/** Numeric PIN, 4 digits by default, 6 when the owner requires it (AUTH-001). */
export const Pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits');

/** Owner password (AUTH-006): at least 12 characters. */
export const OwnerPassword = z.string().min(12).max(256);

/** Second factor for the Owner: a TOTP code or a one-time recovery code (AUTH-006). */
export const SecondFactor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('TOTP'), code: z.string().regex(/^\d{6}$/) }),
  z.strictObject({
    kind: z.literal('RECOVERY_CODE'),
    code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  }),
]);
export type SecondFactor = z.infer<typeof SecondFactor>;

/** A name/photo tile on the shared-device login screen (AUTH-001). No PIN hints. */
export const StaffTile = z.object({
  staffId: Id,
  displayName: z.string().min(1),
  role: Role,
  /** The name of the person's custom role, shown instead of the base role's (P4-02e). */
  customRoleName: z.string().nullable(),
  photoId: Id.nullable(),
});
export type StaffTile = z.infer<typeof StaffTile>;

export const StaffTilesResponse = z.object({ staff: z.array(StaffTile) });
export type StaffTilesResponse = z.infer<typeof StaffTilesResponse>;

export const PinLoginRequest = z.strictObject({ staffId: Id, pin: Pin });
export type PinLoginRequest = z.infer<typeof PinLoginRequest>;

export const OwnerLoginRequest = z.strictObject({
  staffId: Id,
  password: OwnerPassword,
  secondFactor: SecondFactor,
});
export type OwnerLoginRequest = z.infer<typeof OwnerLoginRequest>;

export const RefreshRequest = z.strictObject({ refreshToken: z.string().min(20).max(200) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/**
 * A person's custom role (P4-02e, AUTH-012): its name and what it changes on top of their base
 * role, so screens offer what they may do (the server decides with the same grants).
 */
export const PersonCustomRole = z.object({
  id: Id,
  name: z.string(),
  /** Used outright, on top of the base role. */
  added: z.array(Capability),
  /** What the base role may do that this role may not. */
  removed: z.array(Capability),
});
export type PersonCustomRole = z.infer<typeof PersonCustomRole>;

/**
 * Tokens for a signed-in person on this device (AUTH-005). The access token is short-lived and
 * sent as `Authorization: Bearer`; the refresh token is kept by the app and rotated on every use.
 */
export const LoginResponse = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: Timestamp,
  refreshToken: z.string().min(1),
  session: z.object({
    id: Id,
    /** Latest possible end of the session, whatever the activity. */
    expiresAt: Timestamp,
    /** The session ends after this many seconds without activity. */
    inactivityTimeoutSeconds: z.int().positive(),
  }),
  staff: z.object({
    id: Id,
    displayName: z.string(),
    role: Role,
    customRole: PersonCustomRole.nullable(),
  }),
  /** Until when the Owner's password + TOTP step-up is valid, if it was done. */
  secondFactorValidUntil: Timestamp.nullable(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

/**
 * The signed-in person and their session on this device, without tokens. Apps check it after a
 * restart, and calling it counts as activity (AUTH-005).
 */
export const CurrentSessionResponse = LoginResponse.pick({
  session: true,
  staff: true,
  secondFactorValidUntil: true,
});
export type CurrentSessionResponse = z.infer<typeof CurrentSessionResponse>;

export const StepUpRequest = z.strictObject({
  password: OwnerPassword,
  secondFactor: SecondFactor,
});
export type StepUpRequest = z.infer<typeof StepUpRequest>;

export const StepUpResponse = z.object({ secondFactorValidUntil: Timestamp });
export type StepUpResponse = z.infer<typeof StepUpResponse>;

/** A manager approves one action on the requester's device with their PIN (AUTH-011). */
export const OverrideRequest = z.strictObject({
  approverStaffId: Id,
  pin: Pin,
  capability: Capability,
  /** The record the action is about, when there is one (e.g. the order item to void). */
  entityType: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,63}$/)
    .optional(),
  entityId: Id.optional(),
});
export type OverrideRequest = z.infer<typeof OverrideRequest>;

export const OverrideResponse = z.object({
  /** Send in the `x-override-token` header of the action; valid once, for a short time. */
  overrideToken: z.string().min(1),
  expiresAt: Timestamp,
  approver: z.object({ id: Id, displayName: z.string(), role: Role }),
});
export type OverrideResponse = z.infer<typeof OverrideResponse>;

export const UnlockStaffRequest = z.strictObject({ staffId: Id });
export type UnlockStaffRequest = z.infer<typeof UnlockStaffRequest>;

export const TotpEnrollmentResponse = z.object({
  /** Base32 secret for manual entry. */
  secret: z.string().regex(/^[A-Z2-7]+$/),
  /** `otpauth://` URI to show as a QR code in the authenticator app. */
  otpauthUri: z.string().startsWith('otpauth://totp/'),
});
export type TotpEnrollmentResponse = z.infer<typeof TotpEnrollmentResponse>;

export const TotpConfirmRequest = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequest>;

export const TotpConfirmResponse = z.object({
  /** Shown once; each works one time instead of a TOTP code. */
  recoveryCodes: z.array(z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)).length(10),
});
export type TotpConfirmResponse = z.infer<typeof TotpConfirmResponse>;

export const OwnerPasswordRequest = z.strictObject({
  /** Required when a password is already set. */
  currentPassword: OwnerPassword.optional(),
  newPassword: OwnerPassword,
});
export type OwnerPasswordRequest = z.infer<typeof OwnerPasswordRequest>;

/**
 * What of the Owner's sign-in security is set up (AUTH-006), never the secrets: the console shows
 * "Set password" or "Change password", and whether the authenticator still has to be added.
 */
export const OwnerSecurityResponse = z.object({
  hasPassword: z.boolean(),
  /** An authenticator app is set up and was confirmed with a code. */
  hasAuthenticator: z.boolean(),
  /** One-time recovery codes not yet used. */
  recoveryCodesLeft: z.int().nonnegative(),
  /** Until when the last password + second factor confirmation holds, if it still does. */
  secondFactorValidUntil: Timestamp.nullable(),
});
export type OwnerSecurityResponse = z.infer<typeof OwnerSecurityResponse>;
