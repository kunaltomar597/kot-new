import { describe, expect, it } from 'vitest';
import {
  checkPerson,
  createRequestOf,
  emptyPersonForm,
  personFormOf,
  roleLabel,
  roleOptions,
  staffActions,
  updateRequestOf,
} from '../src/manage/staff/staff-view.js';
import { STAFF } from './fakes.js';
import { t } from './harness.js';
import { CAPTAIN, HEAD_CASHIER, personRole, RUNNER } from './roles-fixture.js';
import { lockedRavi, PRIYA, staffView } from './staff-fixture.js';

const owner = { staffId: STAFF.OWNER.staffId, role: 'OWNER' } as const;
const manager = { staffId: STAFF.MANAGER.staffId, role: 'MANAGER' } as const;
const now = Date.now();

describe('[MGR-004] the actions each person is offered', () => {
  it('lets a manager look after the team and themselves, not the Owner or other managers', () => {
    expect(staffActions(manager, lockedRavi(), now)).toEqual([
      'EDIT',
      'SET_PIN',
      'UNLOCK',
      'DEACTIVATE',
    ]);
    expect(staffActions(manager, staffView('MANAGER'), now)).toEqual(['EDIT', 'SET_PIN']);
    expect(staffActions(manager, staffView('OWNER'), now)).toEqual([]);
    const otherManager = staffView('MANAGER', {
      id: '0199a0e0-0000-7000-8000-000000000107',
      displayName: 'Vikram',
    });
    expect(staffActions(manager, otherManager, now)).toEqual([]);
    expect(staffActions(owner, otherManager, now)).toEqual(['EDIT', 'SET_PIN', 'DEACTIVATE']);
  });

  it('offers only Reactivate for someone deactivated, and Unlock only while locked', () => {
    expect(staffActions(manager, PRIYA, now)).toEqual(['REACTIVATE']);
    // The lock ran out: nothing to unlock.
    expect(staffActions(manager, lockedRavi(), now + 13 * 60_000)).not.toContain('UNLOCK');
    // The Owner keeps their own record and role.
    expect(staffActions(owner, staffView('OWNER'), now)).toEqual(['EDIT', 'SET_PIN']);
  });
});

describe('[AUTH-001] the add and edit form', () => {
  const filled = {
    ...emptyPersonForm('WAITER'),
    displayName: 'Sunil',
    pin: '1234',
    pinAgain: '1234',
  };

  it('asks for a name and the PIN twice, with exactly the configured digits', () => {
    expect(checkPerson(emptyPersonForm('WAITER'), { withPin: true, pinLength: 4 })).toEqual({
      displayName: 'nameRequired',
      pin: 'pinInvalid',
    });
    expect(checkPerson({ ...filled, pin: '123456' }, { withPin: true, pinLength: 4 })).toEqual({
      pin: 'pinInvalid',
    });
    expect(checkPerson(filled, { withPin: true, pinLength: 6 })).toEqual({ pin: 'pinInvalid' });
    expect(checkPerson({ ...filled, pinAgain: '1235' }, { withPin: true, pinLength: 4 })).toEqual({
      pinAgain: 'pinMismatch',
    });
    expect(checkPerson(filled, { withPin: true, pinLength: 4 })).toEqual({});
    // Editing never asks for a PIN.
    expect(checkPerson({ ...filled, pin: '' }, { withPin: false, pinLength: 4 })).toEqual({});
  });

  it('checks a phone and an e-mail only when given, like the server', () => {
    const check = (phone: string, email: string) =>
      checkPerson({ ...filled, phone, email }, { withPin: true, pinLength: 4 });
    expect(check('+91 98765 43210', 'sunil@example.in')).toEqual({});
    expect(check('call me', 'sunil')).toEqual({ phone: 'phoneInvalid', email: 'emailInvalid' });
    expect(check('  ', '')).toEqual({});
  });

  it('adds the person with empty contact fields as none', () => {
    expect(createRequestOf({ ...filled, displayName: ' Sunil ', phone: ' ' })).toEqual({
      displayName: 'Sunil',
      role: 'WAITER',
      pin: '1234',
      phone: null,
      email: null,
    });
  });

  it('sends only what changed, and nothing when nothing did', () => {
    const ravi = lockedRavi();
    expect(updateRequestOf(ravi, personFormOf(ravi))).toBeUndefined();
    expect(
      updateRequestOf(ravi, { ...personFormOf(ravi), displayName: 'Ravi K', role: 'CASHIER' }),
    ).toEqual({ displayName: 'Ravi K', role: 'CASHIER' });
    expect(updateRequestOf(ravi, { ...personFormOf(ravi), phone: '' })).toEqual({ phone: null });
    expect(updateRequestOf(ravi, { ...personFormOf(ravi), email: 'ravi@example.in' })).toEqual({
      email: 'ravi@example.in',
    });
  });
});

describe('[AUTH-012] custom roles in the staff editor', () => {
  const roles = [CAPTAIN, HEAD_CASHIER, RUNNER];
  const values = (options: ReturnType<typeof roleOptions>) => options.map((option) => option.value);

  it('offers the custom roles a person may give, a manager’s ones only to the Owner', () => {
    expect(values(roleOptions(manager, undefined, roles))).toEqual([
      'CASHIER',
      'WAITER',
      'KITCHEN',
      `custom:${CAPTAIN.id}`,
    ]);
    expect(values(roleOptions(owner, undefined, roles))).toEqual([
      'MANAGER',
      'CASHIER',
      'WAITER',
      'KITCHEN',
      `custom:${CAPTAIN.id}`,
      `custom:${HEAD_CASHIER.id}`,
    ]);
  });

  it('always offers the person’s own role, archived or not yet read', () => {
    const runner = staffView('WAITER', { customRole: personRole(RUNNER) });
    expect(roleOptions(owner, runner, roles).at(-1)).toMatchObject({
      value: `custom:${RUNNER.id}`,
      customName: 'Runner',
      archived: true,
    });
    const captain = staffView('WAITER', { customRole: personRole(CAPTAIN) });
    expect(roleOptions(manager, captain, [])).toContainEqual({
      value: `custom:${CAPTAIN.id}`,
      role: 'WAITER',
      customRoleId: CAPTAIN.id,
      customName: 'Captain',
      archived: false,
    });
  });

  it('[AUTH-006] leaves someone whose role manages staff to the Owner', () => {
    const asha = staffView('CASHIER', { customRole: personRole(HEAD_CASHIER) });
    expect(staffActions(manager, asha, now)).toEqual([]);
    expect(staffActions(owner, asha, now)).toEqual(['EDIT', 'SET_PIN', 'DEACTIVATE']);
    // A head cashier looks after the team like a manager, but not their own role.
    const headCashier = {
      staffId: asha.id,
      role: 'CASHIER',
      customRole: personRole(HEAD_CASHIER),
    } as const;
    expect(staffActions(headCashier, lockedRavi(), now)).toEqual([
      'EDIT',
      'SET_PIN',
      'UNLOCK',
      'DEACTIVATE',
    ]);
    expect(staffActions(headCashier, asha, now)).toEqual(['EDIT', 'SET_PIN']);
  });

  it('sends a custom role with its base role, and the built-in role alone', () => {
    expect(
      createRequestOf({
        ...emptyPersonForm('WAITER', CAPTAIN.id),
        displayName: 'Sunil',
        pin: '1234',
        pinAgain: '1234',
      }),
    ).toMatchObject({ role: 'WAITER', customRoleId: CAPTAIN.id });
    const ravi = lockedRavi();
    expect(updateRequestOf(ravi, { ...personFormOf(ravi), customRoleId: CAPTAIN.id })).toEqual({
      role: 'WAITER',
      customRoleId: CAPTAIN.id,
    });
    const captain = staffView('WAITER', { customRole: personRole(CAPTAIN) });
    expect(personFormOf(captain).customRoleId).toBe(CAPTAIN.id);
    expect(updateRequestOf(captain, personFormOf(captain))).toBeUndefined();
    expect(updateRequestOf(captain, { ...personFormOf(captain), customRoleId: null })).toEqual({
      role: 'WAITER',
    });
  });

  it('names a custom role with the role it is built on', () => {
    expect(roleLabel(t, 'WAITER', null)).toBe('Waiter');
    expect(roleLabel(t, 'WAITER', { name: 'Captain' })).toBe('Captain (Waiter)');
    expect(roleLabel(t, 'WAITER', { name: 'Runner' }, true)).toBe('Runner (Waiter, archived)');
  });
});
