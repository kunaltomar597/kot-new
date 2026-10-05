import {
  CreateStaffRequest,
  type CustomRoleView,
  type StaffView,
  type UpdateStaffRequest,
} from '@rp/contracts';
import {
  type AssignableRole,
  decideStaffChange,
  isAssignableRole,
  isValidPin,
  mayGiveRole,
  type Role,
  type RoleCustomisation,
  rolesOffered,
  type StaffChange,
  type StaffTarget,
} from '@rp/domain';
import type { Translator } from '@rp/i18n';

/** The signed-in person looking after staff. */
export interface StaffActorView {
  readonly staffId: string;
  readonly role: Role;
  /** A custom role can give staff management or take it away (AUTH-012). */
  readonly customRole?: RoleCustomisation | null;
}

/** A person as the staff rules see them: someone with a custom role that manages staff counts as a manager. */
function targetOf(person: StaffView): StaffTarget {
  return {
    staffId: person.id,
    role: person.role,
    customRole: person.customRole,
    active: person.active,
  };
}

/**
 * A role as people read it: the built-in role's name, or a custom role's name with the role it is
 * built on, "Captain (Waiter)" (P4-02e).
 */
export function roleLabel(
  t: Translator,
  role: Role,
  customRole: { readonly name: string } | null,
  archived = false,
): string {
  if (customRole === null) return t(`roles.${role}`);
  return t(archived ? 'customRoles.optionArchived' : 'customRoles.option', {
    name: customRole.name,
    role: t(`roles.${role}`),
  });
}

/** A button on a person's row. */
export type StaffAction = 'EDIT' | 'SET_PIN' | 'UNLOCK' | 'DEACTIVATE' | 'REACTIVATE';

/**
 * Whether `actor` may make `change` to `person` (`@rp/domain` staff rules). The Owner is assumed
 * to confirm the second factor when the server asks, so the Owner is offered what that allows.
 */
function may(actor: StaffActorView, person: StaffView, change: StaffChange): boolean {
  return decideStaffChange({ ...actor, secondFactorFresh: true }, targetOf(person), change).allowed;
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
  /** A custom role on top of `role` (P4-02e), or null for the built-in role. */
  readonly customRoleId: string | null;
  readonly phone: string;
  readonly email: string;
  /** Only when adding someone. */
  readonly pin: string;
  readonly pinAgain: string;
}

export type PersonField = Exclude<keyof PersonForm, 'customRoleId'>;

/** Why a field cannot be saved, as a key under `staff.form`. */
export type PersonProblem =
  'nameRequired' | 'phoneInvalid' | 'emailInvalid' | 'pinInvalid' | 'pinMismatch';

export function emptyPersonForm(role: Role, customRoleId: string | null = null): PersonForm {
  return { displayName: '', role, customRoleId, phone: '', email: '', pin: '', pinAgain: '' };
}

export function personFormOf(person: StaffView): PersonForm {
  return {
    displayName: person.displayName,
    role: person.role,
    customRoleId: person.customRole?.id ?? null,
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
    ...(form.customRoleId !== null && { customRoleId: form.customRoleId }),
    pin: form.pin,
    phone: contact(form.phone),
    email: contact(form.email),
  };
}

/**
 * Only what changed, so a manager editing their own name never sends their role; undefined when
 * nothing changed (the dialog then just closes). Another role is sent with its custom role, if it
 * is one.
 */
export function updateRequestOf(
  person: StaffView,
  form: PersonForm,
): UpdateStaffRequest | undefined {
  const changes: UpdateStaffRequest = {};
  if (form.displayName.trim() !== person.displayName) changes.displayName = form.displayName.trim();
  const customRoleId = person.customRole?.id ?? null;
  if (
    (form.role !== person.role || form.customRoleId !== customRoleId) &&
    isAssignableRole(form.role)
  ) {
    // With the role alone the person gets the built-in role.
    changes.role = form.role;
    if (form.customRoleId !== null) changes.customRoleId = form.customRoleId;
  }
  if (contact(form.phone) !== person.phone) changes.phone = contact(form.phone);
  if (contact(form.email) !== person.email) changes.email = contact(form.email);
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/** A role someone can be given in the add or edit dialog: a built-in role or a custom role. */
export interface RoleOption {
  /** The select's value: the built-in role, or `custom:` and the custom role's id. */
  readonly value: string;
  readonly role: AssignableRole;
  readonly customRoleId: string | null;
  /** A custom role's name; null for a built-in role. */
  readonly customName: string | null;
  /** The person's own custom role, archived since they were given it. */
  readonly archived: boolean;
}

export function roleValueOf(form: Pick<PersonForm, 'role' | 'customRoleId'>): string {
  return form.customRoleId === null ? form.role : `custom:${form.customRoleId}`;
}

/**
 * The roles the signed-in person may give a new person or `person`, in the order the dialog shows
 * them: the built-in ones (`rolesOffered`), then the active custom roles (`mayGiveRole`: a custom
 * role that makes someone a manager is the Owner's to give). The person's current role is always
 * offered, an archived custom role included, so the dialog opens on it.
 */
export function roleOptions(
  actor: StaffActorView,
  person: StaffView | undefined,
  customRoles: readonly CustomRoleView[],
): RoleOption[] {
  const target = person === undefined ? null : targetOf(person);
  const options: RoleOption[] = rolesOffered(actor, target).map((role) => ({
    value: role,
    role,
    customRoleId: null,
    customName: null,
    archived: false,
  }));
  const current = person?.customRole ?? null;
  for (const role of customRoles) {
    const theirs = role.id === current?.id;
    const offered =
      theirs ||
      (role.archivedAt === null &&
        mayGiveRole(actor, target, { role: role.baseRole, customRole: role }));
    if (!offered) continue;
    options.push({
      value: `custom:${role.id}`,
      role: role.baseRole,
      customRoleId: role.id,
      customName: role.name,
      archived: role.archivedAt !== null,
    });
  }
  // Their custom role is offered even before the roles are read.
  if (
    person !== undefined &&
    current !== null &&
    isAssignableRole(person.role) &&
    !options.some((option) => option.customRoleId === current.id)
  ) {
    options.push({
      value: `custom:${current.id}`,
      role: person.role,
      customRoleId: current.id,
      customName: current.name,
      archived: false,
    });
  }
  return options;
}
