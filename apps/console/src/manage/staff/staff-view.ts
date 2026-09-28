import { CreateStaffRequest, type StaffView, type UpdateStaffRequest } from '@rp/contracts';
import {
  decideStaffChange,
  isAssignableRole,
  isValidPin,
  type Role,
  type StaffChange,
} from '@rp/domain';

/** The signed-in person looking after staff. */
export interface StaffActorView {
  readonly staffId: string;
  readonly role: Role;
}

/** A button on a person's row. */
export type StaffAction = 'EDIT' | 'SET_PIN' | 'UNLOCK' | 'DEACTIVATE' | 'REACTIVATE';

/**
 * Whether `actor` may make `change` to `person` (`@rp/domain` staff rules). The Owner is assumed
 * to confirm the second factor when the server asks, so the Owner is offered what that allows.
 */
function may(actor: StaffActorView, person: StaffView, change: StaffChange): boolean {
  return decideStaffChange(
    { ...actor, secondFactorFresh: true },
    { staffId: person.id, role: person.role, active: person.active },
    change,
  ).allowed;
}

/** The login is locked after wrong attempts and has not opened again yet (AUTH-003). */
export function isLocked(person: StaffView, now: number): boolean {
  return person.lockedUntil !== null && Date.parse(person.lockedUntil) > now;
}

/**
 * What the signed-in person can do for someone, in the order the buttons show: only what the
 * server will allow, so nobody is offered a button that can only fail. A deactivated person can
 * only be reactivated.
 */
export function staffActions(actor: StaffActorView, person: StaffView, now: number): StaffAction[] {
  if (!person.active) return may(actor, person, { kind: 'REACTIVATE' }) ? ['REACTIVATE'] : [];
  const actions: StaffAction[] = [];
  if (may(actor, person, { kind: 'EDIT' })) actions.push('EDIT');
  if (may(actor, person, { kind: 'SET_PIN' })) actions.push('SET_PIN');
  if (isLocked(person, now) && may(actor, person, { kind: 'UNLOCK' })) actions.push('UNLOCK');
  if (may(actor, person, { kind: 'DEACTIVATE' })) actions.push('DEACTIVATE');
  return actions;
}

/** What is typed in the add or edit dialog. */
export interface PersonForm {
  readonly displayName: string;
  readonly role: Role;
  readonly phone: string;
  readonly email: string;
  /** Only when adding someone. */
  readonly pin: string;
  readonly pinAgain: string;
}

export type PersonField = keyof PersonForm;

/** Why a field cannot be saved, as a key under `staff.form`. */
export type PersonProblem =
  'nameRequired' | 'phoneInvalid' | 'emailInvalid' | 'pinInvalid' | 'pinMismatch';

export function emptyPersonForm(role: Role): PersonForm {
  return { displayName: '', role, phone: '', email: '', pin: '', pinAgain: '' };
}

export function personFormOf(person: StaffView): PersonForm {
  return {
    displayName: person.displayName,
    role: person.role,
    phone: person.phone ?? '',
    email: person.email ?? '',
    pin: '',
    pinAgain: '',
  };
}

/** The PIN twice, the same, with exactly `pinLength` digits (AUTH-001). */
export function checkPin(
  pin: string,
  pinAgain: string,
  pinLength: number,
): Partial<Record<'pin' | 'pinAgain', PersonProblem>> {
  if (!isValidPin(pin, pinLength)) return { pin: 'pinInvalid' };
  if (pin !== pinAgain) return { pinAgain: 'pinMismatch' };
  return {};
}

/**
 * The problems that keep a form from being saved, checked with the same rules as the server
 * (`@rp/contracts`), so the person sees them beside the field instead of after a round trip.
 */
export function checkPerson(
  form: PersonForm,
  options: { readonly withPin: boolean; readonly pinLength: number },
): Partial<Record<PersonField, PersonProblem>> {
  const problems: Partial<Record<PersonField, PersonProblem>> = {};
  const shape = CreateStaffRequest.shape;
  if (!shape.displayName.safeParse(form.displayName).success) problems.displayName = 'nameRequired';
  if (form.phone.trim() !== '' && !shape.phone.safeParse(form.phone.trim()).success) {
    problems.phone = 'phoneInvalid';
  }
  if (form.email.trim() !== '' && !shape.email.safeParse(form.email.trim()).success) {
    problems.email = 'emailInvalid';
  }
  return options.withPin
    ? { ...problems, ...checkPin(form.pin, form.pinAgain, options.pinLength) }
    : problems;
}

/** Empty contact fields are sent as "none". */
function contact(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The request that adds the person on a checked form. */
export function createRequestOf(form: PersonForm): CreateStaffRequest {
  if (!isAssignableRole(form.role)) throw new Error(`${form.role} cannot be given`);
  return {
    displayName: form.displayName.trim(),
    role: form.role,
    pin: form.pin,
    phone: contact(form.phone),
    email: contact(form.email),
  };
}

/**
 * Only what changed, so a manager editing their own name never sends their role; undefined when
 * nothing changed (the dialog then just closes).
 */
export function updateRequestOf(
  person: StaffView,
  form: PersonForm,
): UpdateStaffRequest | undefined {
  const changes: UpdateStaffRequest = {};
  if (form.displayName.trim() !== person.displayName) changes.displayName = form.displayName.trim();
  if (form.role !== person.role && isAssignableRole(form.role)) changes.role = form.role;
  if (contact(form.phone) !== person.phone) changes.phone = contact(form.phone);
  if (contact(form.email) !== person.email) changes.email = contact(form.email);
  return Object.keys(changes).length === 0 ? undefined : changes;
}
