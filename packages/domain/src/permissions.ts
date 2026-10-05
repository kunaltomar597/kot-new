/**
 * Role-based permissions from BRD §4.2. The server enforces these on every REST call,
 * socket event and MQTT topic (AUTH-010, SEC-003); clients use them only to decide what to show.
 */

export const ROLES = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const;
export type Role = (typeof ROLES)[number];

/**
 * - ALLOW: the role may do this.
 * - OWN: only for the person's own tables / own shift.
 * - OVERRIDE: only with a manager's PIN on the same device; both people are audited (AUTH-011).
 * - DENY: never.
 */
export type Grant = 'ALLOW' | 'OWN' | 'OVERRIDE' | 'DENY';

export const CAPABILITIES = [
  'ORDER_CREATE', // Open table, take order, send KOT
  'ORDER_APPROVE_CUSTOMER', // Approve / reject tablet and QR orders
  'ITEM_CANCEL_BEFORE_PREP', // Cancel an item before preparation starts
  'ITEM_VOID_AFTER_PREP', // Void an item after preparation started
  'ITEM_MARK_PREPARING_READY',
  'ITEM_MARK_PICKED_UP',
  'ITEM_MARK_SERVED',
  'STOCK_MANAGE', // Toggle out of stock / set stock count (OI-11: kitchen allowed by default)
  'TABLE_MOVE_MERGE',
  'BILL_REQUEST',
  'BILL_PRINT_AND_PAYMENT',
  'DISCOUNT_WITHIN_LIMIT',
  'DISCOUNT_ABOVE_LIMIT', // Discount above the role limit, or a complimentary item
  'SERVICE_CHARGE_REMOVE',
  'BILL_REPRINT',
  'BILL_EDIT_AFTER_PRINT',
  'INVOICE_VOID',
  'CASH_MOVEMENT_AND_SHIFT_CLOSE',
  'DAY_END_CLOSE',
  'MENU_MANAGE',
  'STAFF_MANAGE',
  'DEVICE_PAIR',
  'OPERATIONS_CONFIGURE', // Notifications, recommendations, printers, stations
  'TAX_AND_INVOICE_SETTINGS',
  'REPORTS_VIEW_EXPORT',
  'AUDIT_VIEW',
  'DATA_ADMIN', // Backup restore, archive and purge, full data export
  'LICENSE_VIEW',
  'LICENSE_MANAGE',
  'UPDATE_INSTALL_NOW',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

type Row = Readonly<Record<Role, Grant>>;

function row(owner: Grant, manager: Grant, cashier: Grant, waiter: Grant, kitchen: Grant): Row {
  return { OWNER: owner, MANAGER: manager, CASHIER: cashier, WAITER: waiter, KITCHEN: kitchen };
}

const A = 'ALLOW';
const O = 'OWN';
const P = 'OVERRIDE';
const D = 'DENY';

/** The default permission matrix, transcribed from BRD §4.2. */
export const DEFAULT_PERMISSION_MATRIX: Readonly<Record<Capability, Row>> = {
  ORDER_CREATE: row(A, A, A, A, D),
  ORDER_APPROVE_CUSTOMER: row(A, A, A, O, D),
  ITEM_CANCEL_BEFORE_PREP: row(A, A, A, O, D),
  ITEM_VOID_AFTER_PREP: row(A, A, P, P, D),
  ITEM_MARK_PREPARING_READY: row(A, A, D, D, A),
  ITEM_MARK_PICKED_UP: row(A, A, A, A, A),
  ITEM_MARK_SERVED: row(A, A, A, A, D),
  STOCK_MANAGE: row(A, A, A, D, A),
  TABLE_MOVE_MERGE: row(A, A, A, O, D),
  BILL_REQUEST: row(A, A, A, A, D),
  BILL_PRINT_AND_PAYMENT: row(A, A, A, D, D),
  DISCOUNT_WITHIN_LIMIT: row(A, A, A, D, D),
  DISCOUNT_ABOVE_LIMIT: row(A, A, P, D, D),
  SERVICE_CHARGE_REMOVE: row(A, A, A, D, D),
  BILL_REPRINT: row(A, A, A, D, D),
  BILL_EDIT_AFTER_PRINT: row(A, A, P, D, D),
  INVOICE_VOID: row(A, A, P, D, D),
  CASH_MOVEMENT_AND_SHIFT_CLOSE: row(A, A, O, D, D),
  DAY_END_CLOSE: row(A, A, D, D, D),
  MENU_MANAGE: row(A, A, D, D, D),
  STAFF_MANAGE: row(A, A, D, D, D),
  DEVICE_PAIR: row(A, A, D, D, D),
  OPERATIONS_CONFIGURE: row(A, A, D, D, D),
  TAX_AND_INVOICE_SETTINGS: row(A, D, D, D, D),
  REPORTS_VIEW_EXPORT: row(A, A, O, D, D),
  AUDIT_VIEW: row(A, A, D, D, D),
  DATA_ADMIN: row(A, D, D, D, D),
  LICENSE_VIEW: row(A, A, D, D, D),
  LICENSE_MANAGE: row(A, D, D, D, D),
  UPDATE_INSTALL_NOW: row(A, A, D, D, D),
};

/**
 * Capabilities that additionally need the Owner's password + TOTP second factor (AUTH-006).
 * "Creating or removing managers" is enforced inside STAFF_MANAGE by the server.
 */
export const OWNER_SECOND_FACTOR_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'DATA_ADMIN',
  'LICENSE_MANAGE',
  'TAX_AND_INVOICE_SETTINGS',
]);

/** Roles whose PIN can approve an OVERRIDE action (AUTH-011). */
export const OVERRIDE_APPROVER_ROLES: ReadonlySet<Role> = new Set<Role>(['OWNER', 'MANAGER']);

export interface PermissionContext {
  /** True when the target table / shift belongs to the acting person. */
  readonly isOwn?: boolean;
  /** Role of the manager who entered their PIN for this action, if any. */
  readonly overrideApproverRole?: Role;
}

export type PermissionDecision =
  | { readonly allowed: true; readonly viaOverride: boolean }
  | { readonly allowed: false; readonly reason: 'DENIED' | 'NOT_OWN' | 'NEEDS_OVERRIDE' };

export type PermissionMatrix = Readonly<Record<Capability, Readonly<Record<Role, Grant>>>>;

export function grantFor(
  role: Role,
  capability: Capability,
  matrix: PermissionMatrix = DEFAULT_PERMISSION_MATRIX,
): Grant {
  return matrix[capability][role];
}

export function canApproveOverride(role: Role): boolean {
  return OVERRIDE_APPROVER_ROLES.has(role);
}

/**
 * What only the Owner may ever do (BRD §4.2): tax and invoice settings, data administration and
 * the licence. No custom role can be given these (AUTH-012).
 */
export const OWNER_ONLY_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(
  CAPABILITIES.filter((capability) => DEFAULT_PERMISSION_MATRIX[capability].MANAGER === 'DENY'),
);

/**
 * What a custom role changes on top of its base role (AUTH-012, P4-02e): capabilities it adds,
 * which it may then use outright (no "own tables only", no manager's PIN), and capabilities it
 * takes away.
 */
export interface RoleCustomisation {
  readonly added: readonly Capability[];
  readonly removed: readonly Capability[];
}

/** Whoever permissions are checked for: a base role and, with a custom role, what it changes. */
export interface PermissionHolder {
  readonly role: Role;
  readonly customRole?: RoleCustomisation | null;
}

/** The grant `holder` has for `capability`, their custom role applied (AUTH-012). */
export function grantOf(holder: PermissionHolder, capability: Capability): Grant {
  const custom = holder.customRole;
  if (custom !== undefined && custom !== null) {
    if (custom.removed.includes(capability)) return 'DENY';
    if (custom.added.includes(capability)) return 'ALLOW';
  }
  return grantFor(holder.role, capability);
}

/**
 * Why a custom role's permissions are refused:
 * - OWNER_ONLY: only the Owner may ever do it;
 * - ALREADY_ALLOWED: the base role already allows it outright, so there is nothing to add;
 * - NOT_GRANTED: the base role cannot do it, so there is nothing to take away;
 * - BOTH: added and taken away at once;
 * - REPEATED: listed twice.
 */
export type CustomRoleProblem =
  'OWNER_ONLY' | 'ALREADY_ALLOWED' | 'NOT_GRANTED' | 'BOTH' | 'REPEATED';

export interface CustomRoleIssue {
  readonly capability: Capability;
  readonly problem: CustomRoleProblem;
}

/**
 * Checks what a custom role adds to and takes from its base role (AUTH-012). Anything a manager
 * may do can be added, never what only the Owner may do; anything the base role may do can be
 * taken away. Each capability is listed once, where it changes something.
 */
export function checkCustomRole(
  baseRole: Exclude<Role, 'OWNER'>,
  customisation: RoleCustomisation,
): readonly CustomRoleIssue[] {
  const issues: CustomRoleIssue[] = [];
  const seen = new Set<Capability>();
  const note = (capability: Capability, problem: CustomRoleProblem) => {
    issues.push({ capability, problem });
  };
  for (const capability of customisation.added) {
    if (seen.has(capability)) note(capability, 'REPEATED');
    else if (OWNER_ONLY_CAPABILITIES.has(capability)) note(capability, 'OWNER_ONLY');
    else if (grantFor(baseRole, capability) === 'ALLOW') note(capability, 'ALREADY_ALLOWED');
    seen.add(capability);
  }
  const removed = new Set<Capability>();
  for (const capability of customisation.removed) {
    if (removed.has(capability)) note(capability, 'REPEATED');
    else if (customisation.added.includes(capability)) note(capability, 'BOTH');
    else if (grantFor(baseRole, capability) === 'DENY') note(capability, 'NOT_GRANTED');
    removed.add(capability);
  }
  return issues;
}

/** Decides whether `role` may perform `capability` in `context` (deny by default, SEC-003). */
export function evaluatePermission(
  role: Role,
  capability: Capability,
  context: PermissionContext = {},
  matrix: PermissionMatrix = DEFAULT_PERMISSION_MATRIX,
): PermissionDecision {
  const grant = grantFor(role, capability, matrix);
  switch (grant) {
    case 'ALLOW':
      return { allowed: true, viaOverride: false };
    case 'OWN':
      return context.isOwn === true
        ? { allowed: true, viaOverride: false }
        : { allowed: false, reason: 'NOT_OWN' };
    case 'OVERRIDE':
      return context.overrideApproverRole !== undefined &&
        canApproveOverride(context.overrideApproverRole)
        ? { allowed: true, viaOverride: true }
        : { allowed: false, reason: 'NEEDS_OVERRIDE' };
    case 'DENY':
      return { allowed: false, reason: 'DENIED' };
  }
}
