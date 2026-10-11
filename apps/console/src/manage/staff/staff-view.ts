import {
  CreateStaffRequest,
  type RoleView,
  type StaffView,
  type UpdateStaffRequest,
} from '@rp/contracts';
import {
  decideStaffChange,
  isAssignableRole,
  isValidPin,
  type Role,
  ROLES,
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
  /** A custom role on `role` (AUTH-012), or empty for the built-in one. */
  readonly customRoleId: string;
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
  return { displayName: '', role, customRoleId: '', phone: '', email: '', pin: '', pinAgain: '' };
}

export function personFormOf(person: StaffView): PersonForm {
  return {
    displayName: person.displayName,
    role: person.role,
    customRoleId: person.customRoleId ?? '',
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
    ...(form.customRoleId !== '' && { customRoleId: form.customRoleId }),
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
  const customRoleId = form.customRoleId === '' ? null : form.customRoleId;
  if (form.role !== person.role && isAssignableRole(form.role)) {
    // A new built-in role drops any custom role on the server; only a custom one is named.
    changes.role = form.role;
    if (customRoleId !== null) changes.customRoleId = customRoleId;
  } else if (customRoleId !== person.customRoleId) {
    changes.customRoleId = customRoleId;
  }
  if (contact(form.phone) !== person.phone) changes.phone = contact(form.phone);
  if (contact(form.email) !== person.email) changes.email = contact(form.email);
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/**
 * The role choices for a person (AUTH-012): each built-in role they may be given, followed by the
 * active custom roles built on it. The value is the role, or `custom:<id>` for a custom role.
 */
export function roleChoices(
  offered: readonly Role[],
  customRoles: readonly RoleView[],
  label: (role: Role) => string,
): { readonly value: string; readonly label: string }[] {
  return offered.flatMap((role) => [
    { value: role, label: label(role) },
    ...customRoles
      .filter((custom) => custom.baseRole === role && custom.archivedAt === null && !custom.builtIn)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((custom) => ({ value: `custom:${custom.id}`, label: custom.name })),
  ]);
}

/** The value of a form's role in `roleChoices`. */
export function roleChoiceOf(form: Pick<PersonForm, 'role' | 'customRoleId'>): string {
  return form.customRoleId === '' ? form.role : `custom:${form.customRoleId}`;
}

/** The role and custom role a chosen value stands for. */
export function fromRoleChoice(
  value: string,
  customRoles: readonly RoleView[],
): Pick<PersonForm, 'role' | 'customRoleId'> | undefined {
  if (value.startsWith('custom:')) {
    const custom = customRoles.find((role) => role.id === value.slice('custom:'.length));
    return custom === undefined ? undefined : { role: custom.baseRole, customRoleId: custom.id };
  }
  return (ROLES as readonly string[]).includes(value)
    ? { role: value as Role, customRoleId: '' }
    : undefined;
}
