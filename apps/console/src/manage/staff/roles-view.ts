import type { RoleRequest, RoleView } from '@rp/contracts';
import {
  type Capability,
  checkCustomRole,
  CUSTOM_ROLE_GRANTABLE,
  type CustomRoleBase,
  type CustomRoleProblem,
  grantFor,
} from '@rp/domain';

/** Custom roles (P4-02e, AUTH-012): what a base role already allows and what may be added. */

export interface RoleForm {
  readonly name: string;
  readonly baseRole: CustomRoleBase;
  readonly capabilities: readonly Capability[];
}

export function roleFormOf(role?: RoleView): RoleForm {
  return {
    name: role?.name ?? '',
    baseRole: (role?.baseRole as CustomRoleBase | undefined) ?? 'WAITER',
    capabilities: role?.capabilities ?? [],
  };
}

/** Capabilities that can be added to `base`: grantable ones the base role does not already have. */
export function addable(base: CustomRoleBase): Capability[] {
  return CUSTOM_ROLE_GRANTABLE.filter((capability) => grantFor(base, capability) !== 'ALLOW');
}

/** Grantable capabilities `base` already has, to say they come with it. */
export function included(base: CustomRoleBase): Capability[] {
  return CUSTOM_ROLE_GRANTABLE.filter((capability) => grantFor(base, capability) === 'ALLOW');
}

/** The first problem with the form, as the server would answer. */
export function roleProblem(
  form: RoleForm,
  roles: readonly RoleView[],
  selfId?: string,
): CustomRoleProblem | undefined {
  const others = roles
    .filter((role) => role.id !== selfId && role.archivedAt === null)
    .map((role) => role.name);
  return checkCustomRole(
    { ...form, capabilities: form.capabilities.filter((c) => addable(form.baseRole).includes(c)) },
    others,
  )[0];
}

/** Only what the base role adds, so switching base never sends a capability it already has. */
export function roleRequestOf(form: RoleForm): RoleRequest {
  const extra = addable(form.baseRole);
  return {
    name: form.name.trim(),
    baseRole: form.baseRole,
    capabilities: form.capabilities.filter((capability) => extra.includes(capability)),
  };
}

/** Built-in roles first in BRD order, then custom roles by name, archived last. */
export function sortRoles(roles: readonly RoleView[]): {
  readonly builtIn: readonly RoleView[];
  readonly custom: readonly RoleView[];
} {
  const order = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'];
  return {
    builtIn: roles
      .filter((role) => role.builtIn)
      .sort((a, b) => order.indexOf(a.baseRole) - order.indexOf(b.baseRole)),
    custom: roles
      .filter((role) => !role.builtIn)
      .sort(
        (a, b) =>
          Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
          a.name.localeCompare(b.name),
      ),
  };
}
