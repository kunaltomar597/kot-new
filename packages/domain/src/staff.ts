import {
  grantOf,
  type PermissionHolder,
  type Role,
  type RoleCustomisation,
} from './permissions.js';

/**
 * Staff management rules (P4-02a, MGR-004, AUTH-001, AUTH-006): who may add, change, deactivate
 * and reactivate whom, and what a PIN must look like. Pure: the server applies them to every staff
 * route, and the console uses them to offer only what will be allowed.
 */

/**
 * Roles a person can be given (MGR-004). The restaurant has one Owner, set up at installation
 * (ONB-004), who is never created, demoted or deactivated here.
 */
export const ASSIGNABLE_ROLES = ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(role: string): role is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

/** A role a person is given: a base role and, for a custom role, what it changes (AUTH-012). */
export interface RoleChoice {
  readonly role: AssignableRole;
  readonly customRole?: RoleCustomisation | null;
}

/** What is being done to a person's record. */
export type StaffChange =
  | ({ readonly kind: 'CREATE' } & RoleChoice)
  /** Name, phone or e-mail. */
  | { readonly kind: 'EDIT' }
  /** Another base role, or another custom role on the same one. */
  | ({ readonly kind: 'CHANGE_ROLE' } & RoleChoice)
  | { readonly kind: 'SET_PIN' }
  /** Opens a login locked after wrong attempts (AUTH-003). */
  | { readonly kind: 'UNLOCK' }
  | { readonly kind: 'DEACTIVATE' }
  | { readonly kind: 'REACTIVATE' };

export interface StaffActor {
  readonly staffId: string;
  readonly role: Role;
  /** A custom role may take staff management away from a manager, or give it (AUTH-012). */
  readonly customRole?: RoleCustomisation | null;
  /** The Owner confirmed password + second factor within `auth.stepUpMinutes` (AUTH-006). */
  readonly secondFactorFresh: boolean;
}

export interface StaffTarget {
  readonly staffId: string;
  readonly role: Role;
  /** Their custom role, if they have one (AUTH-012). */
  readonly customRole?: RoleCustomisation | null;
  readonly active: boolean;
}

/**
 * Why a change is refused:
 * - DENIED: the person does not manage staff at all (SEC-003);
 * - OWNER_RECORD: the Owner is never given another role or deactivated;
 * - OWN_RECORD: nobody deactivates themselves or changes their own role;
 * - OWNER_ONLY: only the Owner may do it (anything about a manager, or the Owner's own record);
 * - SECOND_FACTOR_REQUIRED: the Owner must first confirm password + second factor (AUTH-006);
 * - ALREADY_ACTIVE / ALREADY_INACTIVE: nothing to reactivate or deactivate.
 */
export type StaffRefusal =
  | 'DENIED'
  | 'OWNER_RECORD'
  | 'OWN_RECORD'
  | 'OWNER_ONLY'
  | 'SECOND_FACTOR_REQUIRED'
  | 'ALREADY_ACTIVE'
  | 'ALREADY_INACTIVE';

export type StaffDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: StaffRefusal };

const ALLOWED: StaffDecision = { allowed: true };
const refuse = (reason: StaffRefusal): StaffDecision => ({ allowed: false, reason });

const managesStaff = (holder: PermissionHolder): boolean =>
  grantOf(holder, 'STAFF_MANAGE') === 'ALLOW';

/**
 * Whether these rules treat a role as a manager's (AUTH-006, AUTH-012): the manager role, with or
 * without a custom role on top, and any custom role that lets someone manage staff. Only the Owner
 * looks after people with one.
 */
export function isManagerRole(holder: PermissionHolder): boolean {
  return holder.role === 'MANAGER' || (holder.role !== 'OWNER' && managesStaff(holder));
}

/**
 * Creating or removing a manager (AUTH-006): adding one, making someone one or no longer one, and
 * deactivating or reactivating one. A custom role counts when it makes someone a manager or no
 * longer one, or gives or takes away staff management.
 */
function changesManagers(change: StaffChange, target: StaffTarget | null): boolean {
  switch (change.kind) {
    case 'CREATE':
      return isManagerRole(change);
    case 'CHANGE_ROLE':
      return (
        target !== null &&
        ((target.role === 'MANAGER') !== (change.role === 'MANAGER') ||
          managesStaff(target) !== managesStaff(change))
      );
    case 'DEACTIVATE':
    case 'REACTIVATE':
      return target !== null && isManagerRole(target);
    case 'EDIT':
    case 'SET_PIN':
    case 'UNLOCK':
      return false;
  }
}

/**
 * May `actor` make `change` to `target` (null when creating)? Managers look after cashiers,
 * waiters and kitchen staff, with or without a custom role. Anything that creates or removes a
 * manager needs the Owner with a fresh second factor (AUTH-006); a manager's other details, PIN
 * and lock are changed by the Owner or by that manager, and the Owner's own record only by the
 * Owner. A custom role is given like its base role unless it makes someone a manager
 * (`isManagerRole`). Permission comes before state, so a refused person learns nothing about the
 * record.
 */
export function decideStaffChange(
  actor: StaffActor,
  target: StaffTarget | null,
  change: StaffChange,
): StaffDecision {
  if (grantOf(actor, 'STAFF_MANAGE') !== 'ALLOW') return refuse('DENIED');
  const self = target !== null && target.staffId === actor.staffId;
  const structural = change.kind === 'CHANGE_ROLE' || change.kind === 'DEACTIVATE';

  if (target?.role === 'OWNER') {
    if (structural || change.kind === 'REACTIVATE') return refuse('OWNER_RECORD');
    if (actor.role !== 'OWNER') return refuse('OWNER_ONLY');
    return ALLOWED;
  }
  if (self && structural) return refuse('OWN_RECORD');
  if (changesManagers(change, target)) {
    if (actor.role !== 'OWNER') return refuse('OWNER_ONLY');
    if (!actor.secondFactorFresh) return refuse('SECOND_FACTOR_REQUIRED');
  } else if (target !== null && isManagerRole(target) && actor.role !== 'OWNER' && !self) {
    return refuse('OWNER_ONLY');
  }
  if (change.kind === 'DEACTIVATE' && target?.active === false) return refuse('ALREADY_INACTIVE');
  if (change.kind === 'REACTIVATE' && target?.active === true) return refuse('ALREADY_ACTIVE');
  return ALLOWED;
}

/**
 * Whether `actor` can give `choice` to a new person or to `target`, with `secondFactorFresh`
 * assumed, so the Owner is offered what the second-factor dialog then allows. Someone's current
 * role is not a change: offer it whatever this says.
 */
export function mayGiveRole(
  actor: Pick<StaffActor, 'staffId' | 'role' | 'customRole'>,
  target: StaffTarget | null,
  choice: RoleChoice,
): boolean {
  const confirmed = { ...actor, secondFactorFresh: true };
  const change = { ...choice, kind: target === null ? 'CREATE' : 'CHANGE_ROLE' } as const;
  return decideStaffChange(confirmed, target, change).allowed;
}

/**
 * The built-in roles `actor` can give a new person or `target` (the Owner offers Manager too; a
 * manager does not), the target's current one included.
 */
export function rolesOffered(
  actor: Pick<StaffActor, 'staffId' | 'role' | 'customRole'>,
  target: StaffTarget | null = null,
): readonly AssignableRole[] {
  return ASSIGNABLE_ROLES.filter(
    (role) =>
      (target !== null && role === target.role && (target.customRole ?? null) === null) ||
      mayGiveRole(actor, target, { role }),
  );
}

/** AUTH-001: a PIN has exactly `length` digits (4 by default, 6 when the Owner asks). */
export function isValidPin(pin: string, length: number): boolean {
  return pin.length === length && /^\d+$/.test(pin);
}
