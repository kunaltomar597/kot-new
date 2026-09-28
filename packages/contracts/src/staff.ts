import { ASSIGNABLE_ROLES } from '@rp/domain';
import { z } from 'zod';
import { Pin } from './auth.js';
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
  role: Role,
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
