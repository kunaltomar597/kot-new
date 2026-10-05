import { describe, expect, it } from 'vitest';
import {
  ArchiveRoleRequest,
  CreateStaffRequest,
  CustomRoleRequest,
  CustomRoleView,
  DeactivateStaffRequest,
  LoginResponse,
  OwnerSecurityResponse,
  SetStaffPinRequest,
  StaffView,
  UpdateStaffRequest,
} from '../src/index.js';

const id = (n: number) => `01926a3e-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('[MGR-004] staff administration requests', () => {
  const ravi = { displayName: 'Ravi', role: 'WAITER', pin: '4321' };

  it('adds a person with a name, a role they can be given and a PIN', () => {
    expect(CreateStaffRequest.safeParse(ravi).success).toBe(true);
    expect(
      CreateStaffRequest.safeParse({ ...ravi, phone: '+91 98765 43210', email: 'ravi@example.in' })
        .success,
    ).toBe(true);
    expect(CreateStaffRequest.safeParse({ ...ravi, displayName: '  ' }).success).toBe(false);
    // The one Owner is set up at installation, never added here.
    expect(CreateStaffRequest.safeParse({ ...ravi, role: 'OWNER' }).success).toBe(false);
    expect(CreateStaffRequest.safeParse({ ...ravi, phone: 'call me' }).success).toBe(false);
    expect(CreateStaffRequest.safeParse({ ...ravi, active: false }).success).toBe(false);
  });

  it('changes only what is given, at least one thing', () => {
    expect(UpdateStaffRequest.safeParse({ role: 'CASHIER' }).success).toBe(true);
    expect(UpdateStaffRequest.safeParse({ phone: null }).success).toBe(true);
    expect(UpdateStaffRequest.safeParse({}).success).toBe(false);
    expect(UpdateStaffRequest.safeParse({ pin: '1234' }).success).toBe(false);
  });

  it('asks why someone is deactivated', () => {
    expect(DeactivateStaffRequest.safeParse({ reason: 'Left the restaurant' }).success).toBe(true);
    expect(DeactivateStaffRequest.safeParse({ reason: ' ' }).success).toBe(false);
    expect(DeactivateStaffRequest.safeParse({}).success).toBe(false);
  });

  it('shows whether a PIN is set, never the PIN', () => {
    const view = {
      id: id(1),
      displayName: 'Ravi',
      role: 'WAITER',
      customRole: null,
      active: true,
      phone: null,
      email: null,
      photoId: null,
      hasPin: true,
      lockedUntil: null,
      createdAt: '2026-09-28T10:00:00.000Z',
      updatedAt: '2026-09-28T10:00:00.000Z',
    };
    expect(StaffView.parse({ ...view, pin: '4321', secretHash: 'x' })).toEqual(view);
  });
});

describe('[AUTH-012] custom roles', () => {
  const captain = {
    name: 'Captain',
    baseRole: 'WAITER',
    added: ['BILL_PRINT_AND_PAYMENT'],
    removed: [],
  };

  it('combines known permissions on top of a role people can be given', () => {
    expect(CustomRoleRequest.parse({ ...captain, name: '  Captain ' }).name).toBe('Captain');
    expect(CustomRoleRequest.safeParse({ ...captain, baseRole: 'OWNER' }).success).toBe(false);
    expect(CustomRoleRequest.safeParse({ ...captain, added: ['FLY'] }).success).toBe(false);
    expect(CustomRoleRequest.safeParse({ ...captain, name: '' }).success).toBe(false);
    expect(CustomRoleRequest.safeParse({ ...captain, builtIn: true }).success).toBe(false);
    expect(ArchiveRoleRequest.safeParse({ reason: 'No longer needed' }).success).toBe(true);
  });

  it('gives a person a custom role by id, or the built-in role with null', () => {
    expect(
      CreateStaffRequest.safeParse({
        displayName: 'Ravi',
        role: 'WAITER',
        customRoleId: id(7),
        pin: '4321',
      }).success,
    ).toBe(true);
    expect(UpdateStaffRequest.safeParse({ customRoleId: id(7) }).success).toBe(true);
    expect(UpdateStaffRequest.safeParse({ customRoleId: null }).success).toBe(true);
    expect(UpdateStaffRequest.safeParse({ customRoleId: 'captain' }).success).toBe(false);
  });

  it('tells a person at sign-in what their custom role changes, and lists roles with their people', () => {
    const login = LoginResponse.shape.staff.parse({
      id: id(1),
      displayName: 'Ravi',
      role: 'WAITER',
      customRole: { id: id(7), name: 'Captain', added: ['BILL_PRINT_AND_PAYMENT'], removed: [] },
    });
    expect(login.customRole?.added).toEqual(['BILL_PRINT_AND_PAYMENT']);
    expect(
      CustomRoleView.safeParse({
        id: id(7),
        ...captain,
        staffCount: 2,
        archivedAt: null,
        updatedAt: '2026-10-05T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('[AUTH-001] [AUTH-002] PINs in requests', () => {
  it('are digits only', () => {
    expect(SetStaffPinRequest.safeParse({ pin: '123456' }).success).toBe(true);
    expect(SetStaffPinRequest.safeParse({ pin: '12a4' }).success).toBe(false);
    expect(SetStaffPinRequest.safeParse({ pin: '123' }).success).toBe(false);
  });
});

describe('[AUTH-006] the Owner’s sign-in security', () => {
  it('says what is set up, never a secret', () => {
    const security = {
      hasPassword: true,
      hasAuthenticator: false,
      recoveryCodesLeft: 0,
      secondFactorValidUntil: null,
    };
    expect(OwnerSecurityResponse.parse({ ...security, secret: 'JBSWY3DP' })).toEqual(security);
  });
});
