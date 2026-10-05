import type { LoginResponse } from '@rp/contracts';
import {
  CAPABILITIES,
  type Capability,
  type PermissionHolder,
  type Role,
  type RoleCustomisation,
} from '@rp/domain';

/**
 * Custom roles (P4-02e, AUTH-012) as the `roles` table holds them: a row with `builtIn` false, its
 * base role, the capabilities it adds (`capabilities`) and those it takes away.
 */
export interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly baseRole: Role;
  readonly builtIn: boolean;
  readonly capabilities: readonly string[];
  readonly removedCapabilities: readonly string[];
}

/** The role columns every permission check reads. */
export const ROLE_GRANTS_SELECT = {
  id: true,
  name: true,
  baseRole: true,
  builtIn: true,
  capabilities: true,
  removedCapabilities: true,
} as const;

const KNOWN: ReadonlySet<string> = new Set(CAPABILITIES);

function capabilitiesOf(values: readonly string[]): Capability[] {
  return values.filter((value): value is Capability => KNOWN.has(value));
}

/** What a custom role changes on top of its base role; null for a built-in role. */
export function customisationOf(
  role: Pick<RoleRow, 'builtIn' | 'capabilities' | 'removedCapabilities'>,
): RoleCustomisation | null {
  return role.builtIn
    ? null
    : {
        added: capabilitiesOf(role.capabilities),
        removed: capabilitiesOf(role.removedCapabilities),
      };
}

/** Whoever has `role`, for `grantOf`. */
export function holderOf(role: Omit<RoleRow, 'id' | 'name'>): PermissionHolder {
  return { role: role.baseRole, customRole: customisationOf(role) };
}

export type SignedInCustomRole = LoginResponse['staff']['customRole'];

/** The custom role as screens receive it: at sign-in and on staff records (`PersonCustomRole`). */
export function signedInCustomRole(role: RoleRow): SignedInCustomRole {
  const customisation = customisationOf(role);
  return customisation === null
    ? null
    : {
        id: role.id,
        name: role.name,
        added: [...customisation.added],
        removed: [...customisation.removed],
      };
}

/**
 * Changes whenever what someone may do changes. A live connection keeps the rooms it joined, so
 * one opened with other permissions is closed and the app signs in again (P0-12).
 */
export function permissionKey(holder: PermissionHolder): string {
  const custom = holder.customRole;
  if (custom === undefined || custom === null) return holder.role;
  const sorted = (list: readonly Capability[]) => [...list].sort().join(',');
  return `${holder.role}+${sorted(custom.added)}-${sorted(custom.removed)}`;
}
