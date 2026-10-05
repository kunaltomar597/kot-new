import { CustomRoleRequest, type CustomRoleView } from '@rp/contracts';
import {
  type AssignableRole,
  CAPABILITIES,
  type Capability,
  type Grant,
  grantFor,
  isManagerRole,
} from '@rp/domain';

/**
 * The permissions the role editor offers, in groups people recognise and in the matrix's order
 * within each (BRD §4.2). What only the Owner may do (tax and invoice settings, data
 * administration, the licence) is left out: no custom role is given it (AUTH-012).
 */
export const CAPABILITY_GROUPS = {
  orders: [
    'ORDER_CREATE',
    'ORDER_APPROVE_CUSTOMER',
    'ITEM_CANCEL_BEFORE_PREP',
    'ITEM_VOID_AFTER_PREP',
    'TABLE_MOVE_MERGE',
  ],
  kitchen: ['ITEM_MARK_PREPARING_READY', 'ITEM_MARK_PICKED_UP', 'ITEM_MARK_SERVED', 'STOCK_MANAGE'],
  billing: [
    'BILL_REQUEST',
    'BILL_PRINT_AND_PAYMENT',
    'DISCOUNT_WITHIN_LIMIT',
    'DISCOUNT_ABOVE_LIMIT',
    'SERVICE_CHARGE_REMOVE',
    'BILL_REPRINT',
    'BILL_EDIT_AFTER_PRINT',
    'INVOICE_VOID',
    'CASH_MOVEMENT_AND_SHIFT_CLOSE',
    'DAY_END_CLOSE',
  ],
  management: [
    'MENU_MANAGE',
    'STAFF_MANAGE',
    'DEVICE_PAIR',
    'OPERATIONS_CONFIGURE',
    'REPORTS_VIEW_EXPORT',
    'AUDIT_VIEW',
    'LICENSE_VIEW',
    'UPDATE_INSTALL_NOW',
  ],
} as const satisfies Readonly<Record<string, readonly Capability[]>>;
export type CapabilityGroup = keyof typeof CAPABILITY_GROUPS;
export const CAPABILITY_GROUP_NAMES = Object.keys(CAPABILITY_GROUPS) as CapabilityGroup[];

/** A permission in a role: as its base role has it, given outright, or taken away. */
export type CapabilityChange = 'BASE' | 'ADD' | 'REMOVE';

/** What is typed and chosen in the role editor. */
export interface RoleForm {
  readonly name: string;
  readonly baseRole: AssignableRole;
  /** Only the permissions that differ from the base role. */
  readonly changes: Readonly<Partial<Record<Capability, 'ADD' | 'REMOVE'>>>;
}

export function emptyRoleForm(baseRole: AssignableRole = 'WAITER'): RoleForm {
  return { name: '', baseRole, changes: {} };
}

export function roleFormOf(role: CustomRoleView): RoleForm {
  const changes: Partial<Record<Capability, 'ADD' | 'REMOVE'>> = {};
  for (const capability of role.added) changes[capability] = 'ADD';
  for (const capability of role.removed) changes[capability] = 'REMOVE';
  return { name: role.name, baseRole: role.baseRole, changes };
}

/**
 * The settings `capability` can have on top of `baseRole`, the base role's own first: what it
 * allows can only be taken away, what it never allows can only be added, and what it allows on
 * own tables or with a manager's PIN can be given outright or taken away (`checkCustomRole`).
 */
export function changesFor(baseRole: AssignableRole, capability: Capability): CapabilityChange[] {
  const grant = grantFor(baseRole, capability);
  if (grant === 'ALLOW') return ['BASE', 'REMOVE'];
  if (grant === 'DENY') return ['BASE', 'ADD'];
  return ['BASE', 'ADD', 'REMOVE'];
}

/** What a person with the role may then do. */
export function grantWith(
  baseRole: AssignableRole,
  capability: Capability,
  change: CapabilityChange,
): Grant {
  if (change === 'ADD') return 'ALLOW';
  if (change === 'REMOVE') return 'DENY';
  return grantFor(baseRole, capability);
}

export function changeOf(form: RoleForm, capability: Capability): CapabilityChange {
  return form.changes[capability] ?? 'BASE';
}

export function withChange(
  form: RoleForm,
  capability: Capability,
  change: CapabilityChange,
): RoleForm {
  const changes: Partial<Record<Capability, 'ADD' | 'REMOVE'>> = {};
  for (const each of CAPABILITIES) {
    const value = each === capability ? change : (form.changes[each] ?? 'BASE');
    if (value !== 'BASE') changes[each] = value;
  }
  return { ...form, changes };
}

/**
 * Another base role, keeping the changes that still change something: adding what the new base
 * role already allows, or taking away what it never allows, would mean nothing.
 */
export function withBaseRole(form: RoleForm, baseRole: AssignableRole): RoleForm {
  const changes: Partial<Record<Capability, 'ADD' | 'REMOVE'>> = {};
  for (const capability of CAPABILITIES) {
    const change = form.changes[capability];
    if (change !== undefined && changesFor(baseRole, capability).includes(change)) {
      changes[capability] = change;
    }
  }
  return { ...form, baseRole, changes };
}

/** What the role adds and takes away, in the matrix's order. */
export function customisationOfForm(form: RoleForm): {
  added: Capability[];
  removed: Capability[];
} {
  return {
    added: CAPABILITIES.filter((capability) => form.changes[capability] === 'ADD'),
    removed: CAPABILITIES.filter((capability) => form.changes[capability] === 'REMOVE'),
  };
}

export function roleRequestOf(form: RoleForm): CustomRoleRequest {
  return { name: form.name.trim(), baseRole: form.baseRole, ...customisationOfForm(form) };
}

/** Whether saving would change `role`; nothing is sent when it would not. */
export function roleChanged(role: CustomRoleView, form: RoleForm): boolean {
  const request = roleRequestOf(form);
  return (
    request.name !== role.name ||
    request.baseRole !== role.baseRole ||
    request.added.join() !== CAPABILITIES.filter((c) => role.added.includes(c)).join() ||
    request.removed.join() !== CAPABILITIES.filter((c) => role.removed.includes(c)).join()
  );
}

/**
 * Whether people with the role count as managers (`isManagerRole`): only the Owner then gives it
 * to people or changes theirs (AUTH-006).
 */
export function countsAsManager(role: {
  readonly baseRole: AssignableRole;
  readonly added: readonly Capability[];
  readonly removed: readonly Capability[];
}): boolean {
  return isManagerRole({ role: role.baseRole, customRole: role });
}

/** Why a role cannot be saved, as a key under `customRoles.editor`. */
export type RoleProblem = 'nameRequired' | 'nameTaken';

/**
 * The problems that keep the form from being saved, with the server's rules (`@rp/contracts`): a
 * name of up to 40 characters that no built-in role and no other active custom role has, ignoring
 * case. `takenNames` are those names; the server checks again.
 */
export function checkRole(
  form: RoleForm,
  takenNames: readonly string[],
): Partial<Record<'name', RoleProblem>> {
  if (!CustomRoleRequest.shape.name.safeParse(form.name).success) return { name: 'nameRequired' };
  const name = form.name.trim().toLowerCase();
  if (takenNames.some((taken) => taken.trim().toLowerCase() === name)) {
    return { name: 'nameTaken' };
  }
  return {};
}

/** The names of active custom roles other than `exceptId`, which a role cannot take. */
export function activeRoleNames(
  roles: readonly CustomRoleView[],
  exceptId: string | undefined,
): string[] {
  return roles
    .filter((role) => role.archivedAt === null && role.id !== exceptId)
    .map((role) => role.name);
}

/** Active roles first, then archived ones, each by name as the server lists them. */
export function rolesInOrder(roles: readonly CustomRoleView[]): CustomRoleView[] {
  return [
    ...roles.filter((role) => role.archivedAt === null),
    ...roles.filter((role) => role.archivedAt !== null),
  ];
}
