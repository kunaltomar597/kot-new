import { grantFor, type Role } from './permissions.js';

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

/** What is being done to a person's record. */
export type StaffChange =
  | { readonly kind: 'CREATE'; readonly role: AssignableRole }
  /** Name, phone or e-mail. */
  | { readonly kind: 'EDIT' }
  | { readonly kind: 'CHANGE_ROLE'; readonly role: AssignableRole }
  | { readonly kind: 'SET_PIN' }
  | { readonly kind: 'DEACTIVATE' }
  | { readonly kind: 'REACTIVATE' };

export interface StaffActor {
  readonly staffId: string;
  readonly role: Role;
  /** The Owner confirmed password + second factor within `auth.stepUpMinutes` (AUTH-006). */
  readonly secondFactorFresh: boolean;
}

export interface StaffTarget {
  readonly staffId: string;
  readonly role: Role;
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

/**
 * Creating or removing a manager (AUTH-006): adding one, making someone one or no longer one, and
 * deactivating or reactivating one.
 */
function changesManagers(change: StaffChange, target: StaffTarget | null): boolean {
  switch (change.kind) {
    case 'CREATE':
      return change.role === 'MANAGER';
    case 'CHANGE_ROLE':
      return (
        target !== null &&
        target.role !== change.role &&
        (target.role === 'MANAGER' || change.role === 'MANAGER')
      );
    case 'DEACTIVATE':
    case 'REACTIVATE':
      return target?.role === 'MANAGER';
    case 'EDIT':
    case 'SET_PIN':
      return false;
  }
}

/**
 * May `actor` make `change` to `target` (null when creating)? Managers look after cashiers,
 * waiters and kitchen staff. Anything that creates or removes a manager needs the Owner with a
 * fresh second factor (AUTH-006); a manager's other details and PIN are changed by the Owner or by
 * that manager, and the Owner's own record only by the Owner. Permission comes before state, so a
 * refused person learns nothing about the record.
 */
export function decideStaffChange(
  actor: StaffActor,
  target: StaffTarget | null,
  change: StaffChange,
): StaffDecision {
  if (grantFor(actor.role, 'STAFF_MANAGE') !== 'ALLOW') return refuse('DENIED');
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
  } else if (target?.role === 'MANAGER' && actor.role !== 'OWNER' && !self) {
    return refuse('OWNER_ONLY');
  }
  if (change.kind === 'DEACTIVATE' && target?.active === false) return refuse('ALREADY_INACTIVE');
  if (change.kind === 'REACTIVATE' && target?.active === true) return refuse('ALREADY_ACTIVE');
  return ALLOWED;
}

/**
 * The roles `actor` can give a new person or `target` (the Owner offers Manager too; a manager
 * does not). With `secondFactorFresh` assumed, so the Owner is offered what the second-factor
 * dialog then allows.
 */
export function rolesOffered(
  actor: Pick<StaffActor, 'staffId' | 'role'>,
  target: StaffTarget | null = null,
): readonly AssignableRole[] {
  const confirmed = { ...actor, secondFactorFresh: true };
  return ASSIGNABLE_ROLES.filter((role) => {
    if (target === null)
      return decideStaffChange(confirmed, null, { kind: 'CREATE', role }).allowed;
    if (role === target.role) return true;
    return decideStaffChange(confirmed, target, { kind: 'CHANGE_ROLE', role }).allowed;
  });
}

/** AUTH-001: a PIN has exactly `length` digits (4 by default, 6 when the Owner asks). */
export function isValidPin(pin: string, length: number): boolean {
  return pin.length === length && /^\d+$/.test(pin);
}
