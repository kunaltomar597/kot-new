import { describe, expect, it } from 'vitest';
import {
  checkPerson,
  createRequestOf,
  emptyPersonForm,
  personFormOf,
  staffActions,
  updateRequestOf,
} from '../src/manage/staff/staff-view.js';
import { STAFF } from './fakes.js';
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
