import { CUSTOM_ROLE_BASES } from '@rp/domain';
import { z } from 'zod';
import { Capability } from './auth.js';
import { Id, Role, Timestamp } from './common.js';

/**
 * Roles (P4-02e, AUTH-012): the built-in roles of BRD §4.2 and the Owner's custom roles, each a
 * cashier, waiter or kitchen role with extra capabilities on top. Only the Owner creates, changes
 * or archives a custom role, with a fresh second factor (AUTH-006). Nothing is deleted.
 */

export const CustomRoleBase = z.enum(CUSTOM_ROLE_BASES);
export type CustomRoleBase = z.infer<typeof CustomRoleBase>;

export const RoleView = z.object({
  id: Id,
  name: z.string(),
  baseRole: Role,
  /** True for the built-in roles, which cannot be changed. */
  builtIn: z.boolean(),
  /** What a custom role adds to its base role; empty for a built-in role. */
  capabilities: z.array(Capability),
  /** Active people with the role. */
  staffCount: z.int().nonnegative(),
  archivedAt: Timestamp.nullable(),
});
export type RoleView = z.infer<typeof RoleView>;

export const RoleListResponse = z.object({ roles: z.array(RoleView) });
export type RoleListResponse = z.infer<typeof RoleListResponse>;

export const RoleRequest = z.strictObject({
  name: z.string().trim().min(1).max(40),
  baseRole: CustomRoleBase,
  /** At least one the base role does not already have; never staff or Owner-only actions. */
  capabilities: z.array(Capability).min(1).max(40),
});
export type RoleRequest = z.infer<typeof RoleRequest>;

export const RoleParams = z.strictObject({ roleId: Id });
export type RoleParams = z.infer<typeof RoleParams>;

export const ArchiveRoleRequest = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export type ArchiveRoleRequest = z.infer<typeof ArchiveRoleRequest>;
