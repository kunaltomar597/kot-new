import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  decideStaffChange,
  isAssignableRole,
  isManagerRole,
  isValidPin,
  mayGiveRole,
  type RoleChoice,
  ROLES,
  rolesOffered,
  type StaffActor,
  type StaffChange,
  type StaffTarget,
} from '../src/index.js';

const owner: StaffActor = { staffId: 'asha', role: 'OWNER', secondFactorFresh: false };
const confirmedOwner: StaffActor = { ...owner, secondFactorFresh: true };
const manager: StaffActor = { staffId: 'vikram', role: 'MANAGER', secondFactorFresh: false };

const person = (staffId: string, role: StaffTarget['role'], active = true): StaffTarget => ({
  staffId,
  role,
  active,
});
const waiter = person('ravi', 'WAITER');
const otherManager = person('meera', 'MANAGER');
const ownerRecord = person('asha', 'OWNER');
const managerSelf = person('vikram', 'MANAGER');

const decide = (actor: StaffActor, target: StaffTarget | null, change: StaffChange) => {
  const decision = decideStaffChange(actor, target, change);
  return decision.allowed ? 'ALLOWED' : decision.reason;
};

describe('[MGR-004] staff management rules', () => {
  it('lets managers and the Owner add and look after cashiers, waiters and kitchen staff', () => {
    for (const role of ['CASHIER', 'WAITER', 'KITCHEN'] as const) {
      expect(decide(manager, null, { kind: 'CREATE', role })).toBe('ALLOWED');
      expect(decide(owner, null, { kind: 'CREATE', role })).toBe('ALLOWED');
    }
    for (const change of [
      { kind: 'EDIT' },
      { kind: 'SET_PIN' },
      { kind: 'CHANGE_ROLE', role: 'KITCHEN' },
      { kind: 'DEACTIVATE' },
    ] as const) {
      expect(decide(manager, waiter, change)).toBe('ALLOWED');
    }
    expect(decide(manager, person('ravi', 'WAITER', false), { kind: 'REACTIVATE' })).toBe(
      'ALLOWED',
    );
  });

  it('refuses everyone who does not manage staff (deny by default)', () => {
    for (const role of ['CASHIER', 'WAITER', 'KITCHEN'] as const) {
      const actor: StaffActor = { staffId: 'x', role, secondFactorFresh: true };
      expect(decide(actor, waiter, { kind: 'EDIT' })).toBe('DENIED');
      expect(decide(actor, null, { kind: 'CREATE', role: 'WAITER' })).toBe('DENIED');
    }
  });

  it('never deactivates or re-roles the Owner, and only the Owner changes their own record', () => {
    expect(decide(confirmedOwner, ownerRecord, { kind: 'DEACTIVATE' })).toBe('OWNER_RECORD');
    expect(decide(confirmedOwner, ownerRecord, { kind: 'CHANGE_ROLE', role: 'MANAGER' })).toBe(
      'OWNER_RECORD',
    );
    expect(decide(confirmedOwner, ownerRecord, { kind: 'REACTIVATE' })).toBe('OWNER_RECORD');
    expect(decide(owner, ownerRecord, { kind: 'SET_PIN' })).toBe('ALLOWED');
    expect(decide(owner, ownerRecord, { kind: 'EDIT' })).toBe('ALLOWED');
    expect(decide(manager, ownerRecord, { kind: 'SET_PIN' })).toBe('OWNER_ONLY');
    expect(decide(manager, ownerRecord, { kind: 'EDIT' })).toBe('OWNER_ONLY');
  });

  it('lets nobody deactivate themselves or change their own role', () => {
    expect(decide(manager, managerSelf, { kind: 'DEACTIVATE' })).toBe('OWN_RECORD');
    expect(decide(manager, managerSelf, { kind: 'CHANGE_ROLE', role: 'CASHIER' })).toBe(
      'OWN_RECORD',
    );
    // Their own name, contact and PIN are theirs to change.
    expect(decide(manager, managerSelf, { kind: 'EDIT' })).toBe('ALLOWED');
    expect(decide(manager, managerSelf, { kind: 'SET_PIN' })).toBe('ALLOWED');
  });

  it('keeps other managers’ records to the Owner', () => {
    expect(decide(manager, otherManager, { kind: 'EDIT' })).toBe('OWNER_ONLY');
    expect(decide(manager, otherManager, { kind: 'SET_PIN' })).toBe('OWNER_ONLY');
    expect(decide(owner, otherManager, { kind: 'EDIT' })).toBe('ALLOWED');
    expect(decide(owner, otherManager, { kind: 'SET_PIN' })).toBe('ALLOWED');
  });

  it('[AUTH-003] lets a manager open a locked login, but not the Owner’s or another manager’s', () => {
    expect(decide(manager, waiter, { kind: 'UNLOCK' })).toBe('ALLOWED');
    expect(decide(manager, managerSelf, { kind: 'UNLOCK' })).toBe('ALLOWED');
    // The lock on the Owner's password guards Owner-only actions from guessing.
    expect(decide(manager, ownerRecord, { kind: 'UNLOCK' })).toBe('OWNER_ONLY');
    expect(decide(manager, otherManager, { kind: 'UNLOCK' })).toBe('OWNER_ONLY');
    // No second factor needed: unlocking gives nobody a new role.
    expect(decide(owner, otherManager, { kind: 'UNLOCK' })).toBe('ALLOWED');
    expect(decide(owner, ownerRecord, { kind: 'UNLOCK' })).toBe('ALLOWED');
  });

  it('says when there is nothing to deactivate or reactivate', () => {
    expect(decide(manager, person('ravi', 'WAITER', false), { kind: 'DEACTIVATE' })).toBe(
      'ALREADY_INACTIVE',
    );
    expect(decide(manager, waiter, { kind: 'REACTIVATE' })).toBe('ALREADY_ACTIVE');
  });

  it('offers the roles each person can give', () => {
    expect(rolesOffered(manager)).toEqual(['CASHIER', 'WAITER', 'KITCHEN']);
    expect(rolesOffered(owner)).toEqual(ASSIGNABLE_ROLES);
    expect(rolesOffered(manager, waiter)).toEqual(['CASHIER', 'WAITER', 'KITCHEN']);
    expect(rolesOffered(owner, waiter)).toEqual(ASSIGNABLE_ROLES);
    // Only their current role: a manager cannot change another manager's, or their own.
    expect(rolesOffered(manager, otherManager)).toEqual(['MANAGER']);
    expect(rolesOffered(manager, managerSelf)).toEqual(['MANAGER']);
  });

  it('never gives the Owner role', () => {
    expect(isAssignableRole('OWNER')).toBe(false);
    expect(ROLES.filter(isAssignableRole)).toEqual(ASSIGNABLE_ROLES);
  });
});

describe('[AUTH-006] creating or removing managers needs the Owner’s second factor', () => {
  const managerChanges: [StaffTarget | null, StaffChange][] = [
    [null, { kind: 'CREATE', role: 'MANAGER' }],
    [waiter, { kind: 'CHANGE_ROLE', role: 'MANAGER' }],
    [otherManager, { kind: 'CHANGE_ROLE', role: 'WAITER' }],
    [otherManager, { kind: 'DEACTIVATE' }],
    [person('meera', 'MANAGER', false), { kind: 'REACTIVATE' }],
  ];

  it('refuses managers', () => {
    for (const [target, change] of managerChanges) {
      expect(decide(manager, target, change)).toBe('OWNER_ONLY');
    }
  });

  it('asks the Owner to confirm password and second factor first', () => {
    for (const [target, change] of managerChanges) {
      expect(decide(owner, target, change)).toBe('SECOND_FACTOR_REQUIRED');
      expect(decide(confirmedOwner, target, change)).toBe('ALLOWED');
    }
  });

  it('does not ask for it when a manager keeps their role', () => {
    expect(decide(owner, otherManager, { kind: 'CHANGE_ROLE', role: 'MANAGER' })).toBe('ALLOWED');
  });
});

describe('[AUTH-012] staff management with a custom role', () => {
  const captain: RoleChoice = {
    role: 'WAITER',
    customRole: { added: ['BILL_PRINT_AND_PAYMENT'], removed: [] },
  };
  const headCashier: RoleChoice = {
    role: 'CASHIER',
    customRole: { added: ['STAFF_MANAGE'], removed: [] },
  };
  const shiftLead: RoleChoice = {
    role: 'MANAGER',
    customRole: { added: [], removed: ['STAFF_MANAGE'] },
  };
  const holding = (staffId: string, choice: RoleChoice, active = true): StaffTarget => ({
    staffId,
    ...choice,
    active,
  });

  it('follows what the actor’s custom role adds or takes away', () => {
    const kiran: StaffActor = { staffId: 'kiran', ...headCashier, secondFactorFresh: false };
    expect(decide(kiran, waiter, { kind: 'SET_PIN' })).toBe('ALLOWED');
    expect(decide(kiran, null, { kind: 'CREATE', ...captain })).toBe('ALLOWED');
    // Managers, and anyone else who manages staff, stay the Owner's.
    expect(decide(kiran, otherManager, { kind: 'SET_PIN' })).toBe('OWNER_ONLY');
    expect(decide(kiran, holding('mohan', headCashier), { kind: 'EDIT' })).toBe('OWNER_ONLY');
    expect(decide(kiran, null, { kind: 'CREATE', role: 'MANAGER' })).toBe('OWNER_ONLY');

    const lead: StaffActor = { staffId: 'vikram', ...shiftLead, secondFactorFresh: false };
    expect(decide(lead, waiter, { kind: 'EDIT' })).toBe('DENIED');
    expect(rolesOffered(lead)).toEqual([]);
  });

  it('gives a custom role like its base role', () => {
    const ravi = holding('ravi', captain);
    expect(decide(manager, null, { kind: 'CREATE', ...captain })).toBe('ALLOWED');
    expect(decide(manager, waiter, { kind: 'CHANGE_ROLE', ...captain })).toBe('ALLOWED');
    expect(decide(manager, ravi, { kind: 'CHANGE_ROLE', role: 'WAITER' })).toBe('ALLOWED');
    expect(decide(manager, ravi, { kind: 'DEACTIVATE' })).toBe('ALLOWED');
    expect(mayGiveRole(manager, null, captain)).toBe(true);
    // The person's built-in base role is a change from their custom role, so it is decided.
    expect(rolesOffered(manager, ravi)).toEqual(['CASHIER', 'WAITER', 'KITCHEN']);
  });

  it('[AUTH-006] treats a custom role that makes someone a manager or a staff manager as a manager’s', () => {
    expect(isManagerRole(captain)).toBe(false);
    expect(isManagerRole(headCashier)).toBe(true);
    expect(isManagerRole(shiftLead)).toBe(true);
    expect(isManagerRole({ role: 'MANAGER' })).toBe(true);
    expect(isManagerRole({ role: 'CASHIER' })).toBe(false);

    const changes: [StaffTarget | null, StaffChange][] = [
      [null, { kind: 'CREATE', ...headCashier }],
      [null, { kind: 'CREATE', ...shiftLead }],
      [person('kiran', 'CASHIER'), { kind: 'CHANGE_ROLE', ...headCashier }],
      [holding('kiran', headCashier), { kind: 'CHANGE_ROLE', role: 'CASHIER' }],
      [holding('kiran', headCashier), { kind: 'DEACTIVATE' }],
      [holding('kiran', headCashier, false), { kind: 'REACTIVATE' }],
      // Staff management taken away from a manager, or given back.
      [otherManager, { kind: 'CHANGE_ROLE', ...shiftLead }],
      [holding('meera', shiftLead), { kind: 'CHANGE_ROLE', role: 'MANAGER' }],
      // A staff manager made a full manager.
      [holding('kiran', headCashier), { kind: 'CHANGE_ROLE', role: 'MANAGER' }],
    ];
    for (const [target, change] of changes) {
      expect(decide(manager, target, change)).toBe('OWNER_ONLY');
      expect(decide(owner, target, change)).toBe('SECOND_FACTOR_REQUIRED');
      expect(decide(confirmedOwner, target, change)).toBe('ALLOWED');
    }
    expect(mayGiveRole(manager, null, headCashier)).toBe(false);
    expect(mayGiveRole(owner, null, headCashier)).toBe(true);
    // Their name, PIN and lock are the Owner's, or their own, to change.
    expect(decide(manager, holding('kiran', headCashier), { kind: 'SET_PIN' })).toBe('OWNER_ONLY');
    expect(decide(owner, holding('kiran', headCashier), { kind: 'SET_PIN' })).toBe('ALLOWED');
  });

  it('lets nobody change their own custom role', () => {
    const kiran: StaffActor = { staffId: 'kiran', ...headCashier, secondFactorFresh: true };
    expect(
      decide(kiran, holding('kiran', headCashier), { kind: 'CHANGE_ROLE', role: 'CASHIER' }),
    ).toBe('OWN_RECORD');
    expect(decide(kiran, holding('kiran', headCashier), { kind: 'SET_PIN' })).toBe('ALLOWED');
  });
});

describe('[AUTH-001] PINs', () => {
  it('have exactly the configured number of digits', () => {
    expect(isValidPin('1234', 4)).toBe(true);
    expect(isValidPin('123456', 6)).toBe(true);
    expect(isValidPin('123456', 4)).toBe(false);
    expect(isValidPin('1234', 6)).toBe(false);
    expect(isValidPin('12a4', 4)).toBe(false);
    expect(isValidPin(' 123', 4)).toBe(false);
    expect(isValidPin('', 4)).toBe(false);
  });
});
