import { ASSIGNABLE_ROLES } from '@rp/domain';
import { z } from 'zod';
import { Capability, PersonCustomRole, Pin } from './auth.js';
import { Id, Role, Timestamp } from './common.js';
import { PhoneNumber } from './restaurant.js';

/**
 * Staff administration (P4-02a, MGR-004): the people who work here, their roles and PINs. Nobody
 * is deleted, only deactivated, so their history stays theirs (AUD-004). Who may change whom is
 * `decideStaffChange` in `@rp/domain`: managers look after cashiers, waiters and kitchen staff;
 * creating or removing a manager needs the Owner with a fresh second factor (AUTH-006).
 */

/** Roles a person can be given; the one Owner is set up at installation. */
export const AssignableRole = z.enum(ASSIGNABLE_ROLES);
export type AssignableRole = z.infer<typeof AssignableRole>;

const DisplayName = z.string().trim().min(1).max(60);
const Email = z.email().max(254);
const Reason = z.string().trim().min(3).max(200);

export const StaffParams = z.strictObject({ staffId: Id });
export type StaffParams = z.infer<typeof StaffParams>;

/** A person as the Staff page shows them. A PIN is never shown, only whether one is set. */
export const StaffView = z.object({
  id: Id,
  displayName: z.string(),
  /** The base role; a custom role (P4-02e, AUTH-012) changes it, null for a built-in role. */
  role: Role,
  customRole: PersonCustomRole.nullable(),
  active: z.boolean(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  photoId: Id.nullable(),
  hasPin: z.boolean(),
  /** Until when their sign-in is locked after failed attempts (AUTH-003); null when it is not. */
  lockedUntil: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type StaffView = z.infer<typeof StaffView>;

/** Everyone, active first, by name; with the PIN length a new PIN must have. */
export const StaffListResponse = z.object({
  staff: z.array(StaffView),
  /** AUTH-001 ⚙ `auth.pinLength`: 4 digits by default, 6 when the Owner requires it. */
  pinLength: z.union([z.literal(4), z.literal(6)]),
});
export type StaffListResponse = z.infer<typeof StaffListResponse>;

export const CreateStaffRequest = z.strictObject({
  displayName: DisplayName,
  role: AssignableRole,
  /** A custom role on top of `role` (its base role must be `role`); none for the built-in role. */
  customRoleId: Id.nullable().optional(),
  /** Exactly `pinLength` digits; PINs need not be unique, as people pick their name first. */
  pin: Pin,
  phone: PhoneNumber.nullable().optional(),
  email: Email.nullable().optional(),
});
export type CreateStaffRequest = z.infer<typeof CreateStaffRequest>;

/** Only what is given changes; null clears a phone or e-mail. */
export const UpdateStaffRequest = z
  .strictObject({
    displayName: DisplayName.optional(),
    role: AssignableRole.optional(),
    /**
     * A custom role (P4-02e), whose base role is `role` when both are given; null gives the
     * built-in role. With `role` alone the person gets the built-in role.
     */
    customRoleId: Id.nullable().optional(),
    phone: PhoneNumber.nullable().optional(),
    email: Email.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Change at least one thing' });
export type UpdateStaffRequest = z.infer<typeof UpdateStaffRequest>;

/** Deactivation says why; it signs the person out everywhere (AUTH-008). */
export const DeactivateStaffRequest = z.strictObject({ reason: Reason });
export type DeactivateStaffRequest = z.infer<typeof DeactivateStaffRequest>;

export const SetStaffPinRequest = z.strictObject({ pin: Pin });
export type SetStaffPinRequest = z.infer<typeof SetStaffPinRequest>;

// ---------------------------------------------------------------- custom roles (P4-02e)

/**
 * Custom roles (AUTH-012): the Owner combines permissions into a named role on top of a base role,
 * adding what a manager may do (used outright, without "own tables only" or a manager's PIN) or
 * taking away what the base role may do. What only the Owner may do is never added
 * (`checkCustomRole` in `@rp/domain`). People get a custom role like its base role.
 */
export const RoleParams = z.strictObject({ roleId: Id });
export type RoleParams = z.infer<typeof RoleParams>;

export const CustomRoleView = z.object({
  id: Id,
  name: z.string(),
  baseRole: AssignableRole,
  /** What it may do on top of the base role. */
  added: z.array(Capability),
  /** What the base role may do that it may not. */
  removed: z.array(Capability),
  /** Active people who have it. */
  staffCount: z.int().nonnegative(),
  archivedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type CustomRoleView = z.infer<typeof CustomRoleView>;

/** Every custom role, archived ones included, by name. */
export const RoleListResponse = z.object({ roles: z.array(CustomRoleView) });
export type RoleListResponse = z.infer<typeof RoleListResponse>;

export const CustomRoleRequest = z.strictObject({
  name: z.string().trim().min(1).max(40),
  baseRole: AssignableRole,
  added: z.array(Capability).max(40),
  removed: z.array(Capability).max(40),
});
export type CustomRoleRequest = z.infer<typeof CustomRoleRequest>;

/** Only a role nobody active has can be archived; it says why. */
export const ArchiveRoleRequest = z.strictObject({ reason: Reason });
export type ArchiveRoleRequest = z.infer<typeof ArchiveRoleRequest>;
