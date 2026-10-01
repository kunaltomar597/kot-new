import { describe, expect, it } from 'vitest';
import {
  actorGrant,
  CAPABILITIES,
  canApproveOverride,
  checkCustomRole,
  CUSTOM_ROLE_GRANTABLE,
  DEFAULT_PERMISSION_MATRIX,
  evaluatePermission,
  extraCapabilitiesOf,
  grantFor,
  OWNER_SECOND_FACTOR_CAPABILITIES,
  ROLES,
} from '../src/index.js';

describe('[AUTH-010] role permission matrix (BRD §4.2)', () => {
  it('defines a grant for every capability and role', () => {
    expect(Object.keys(DEFAULT_PERMISSION_MATRIX).sort()).toEqual([...CAPABILITIES].sort());
    for (const capability of CAPABILITIES) {
      for (const role of ROLES) {
        expect(['ALLOW', 'OWN', 'OVERRIDE', 'DENY']).toContain(grantFor(role, capability));
      }
    }
  });

  it('matches key rows of the BRD table', () => {
    expect(grantFor('WAITER', 'ORDER_APPROVE_CUSTOMER')).toBe('OWN');
    expect(grantFor('KITCHEN', 'ORDER_CREATE')).toBe('DENY');
    expect(grantFor('CASHIER', 'ITEM_VOID_AFTER_PREP')).toBe('OVERRIDE');
    expect(grantFor('WAITER', 'ITEM_VOID_AFTER_PREP')).toBe('OVERRIDE');
    expect(grantFor('KITCHEN', 'ITEM_MARK_PREPARING_READY')).toBe('ALLOW');
    expect(grantFor('KITCHEN', 'ITEM_MARK_PICKED_UP')).toBe('ALLOW');
    expect(grantFor('KITCHEN', 'ITEM_MARK_SERVED')).toBe('DENY');
    expect(grantFor('KITCHEN', 'STOCK_MANAGE')).toBe('ALLOW');
    expect(grantFor('WAITER', 'BILL_REQUEST')).toBe('ALLOW');
    expect(grantFor('WAITER', 'BILL_PRINT_AND_PAYMENT')).toBe('DENY');
    expect(grantFor('MANAGER', 'TAX_AND_INVOICE_SETTINGS')).toBe('DENY');
    expect(grantFor('OWNER', 'DATA_ADMIN')).toBe('ALLOW');
    expect(grantFor('MANAGER', 'DATA_ADMIN')).toBe('DENY');
    expect(grantFor('CASHIER', 'REPORTS_VIEW_EXPORT')).toBe('OWN');
    expect(grantFor('MANAGER', 'LICENSE_VIEW')).toBe('ALLOW');
    expect(grantFor('MANAGER', 'LICENSE_MANAGE')).toBe('DENY');
  });

  it('[AUTH-006] marks owner second-factor capabilities', () => {
    expect(OWNER_SECOND_FACTOR_CAPABILITIES.has('DATA_ADMIN')).toBe(true);
    expect(OWNER_SECOND_FACTOR_CAPABILITIES.has('MENU_MANAGE')).toBe(false);
  });
});

describe('[AUTH-011] permission evaluation', () => {
  it('allows, denies and scopes to own tables', () => {
    expect(evaluatePermission('MANAGER', 'MENU_MANAGE')).toEqual({
      allowed: true,
      viaOverride: false,
    });
    expect(evaluatePermission('WAITER', 'MENU_MANAGE')).toEqual({
      allowed: false,
      reason: 'DENIED',
    });
    expect(evaluatePermission('WAITER', 'ORDER_APPROVE_CUSTOMER')).toEqual({
      allowed: false,
      reason: 'NOT_OWN',
    });
    expect(evaluatePermission('WAITER', 'ORDER_APPROVE_CUSTOMER', { isOwn: true })).toEqual({
      allowed: true,
      viaOverride: false,
    });
  });

  it('requires a manager or owner PIN for override actions', () => {
    expect(evaluatePermission('CASHIER', 'INVOICE_VOID')).toEqual({
      allowed: false,
      reason: 'NEEDS_OVERRIDE',
    });
    expect(
      evaluatePermission('CASHIER', 'INVOICE_VOID', { overrideApproverRole: 'CASHIER' }),
    ).toEqual({
      allowed: false,
      reason: 'NEEDS_OVERRIDE',
    });
    expect(
      evaluatePermission('CASHIER', 'INVOICE_VOID', { overrideApproverRole: 'MANAGER' }),
    ).toEqual({
      allowed: true,
      viaOverride: true,
    });
    expect(canApproveOverride('OWNER')).toBe(true);
    expect(canApproveOverride('WAITER')).toBe(false);
  });
});

describe('[AUTH-012] custom roles', () => {
  it('may add what a manager does, never managing staff or the Owner-only actions', () => {
    expect(CUSTOM_ROLE_GRANTABLE).toContain('REPORTS_VIEW_EXPORT');
    expect(CUSTOM_ROLE_GRANTABLE).toContain('DISCOUNT_ABOVE_LIMIT');
    expect(CUSTOM_ROLE_GRANTABLE).toContain('MENU_MANAGE');
    for (const never of [
      'STAFF_MANAGE',
      'TAX_AND_INVOICE_SETTINGS',
      'DATA_ADMIN',
      'LICENSE_MANAGE',
    ]) {
      expect(CUSTOM_ROLE_GRANTABLE).not.toContain(never);
    }
  });

  it('adds grants on top of the base role, and nothing else', () => {
    const captain = {
      role: 'WAITER' as const,
      extraCapabilities: ['ORDER_APPROVE_CUSTOMER' as const, 'DISCOUNT_WITHIN_LIMIT' as const],
    };
    expect(actorGrant(captain, 'ORDER_APPROVE_CUSTOMER')).toBe('ALLOW');
    expect(actorGrant(captain, 'DISCOUNT_WITHIN_LIMIT')).toBe('ALLOW');
    expect(actorGrant(captain, 'BILL_PRINT_AND_PAYMENT')).toBe('DENY');
    expect(actorGrant({ role: 'WAITER' }, 'ORDER_APPROVE_CUSTOMER')).toBe('OWN');
    // A stored capability that may not be granted is ignored.
    expect(
      actorGrant({ role: 'WAITER', extraCapabilities: ['STAFF_MANAGE'] }, 'STAFF_MANAGE'),
    ).toBe('DENY');
    expect(
      evaluatePermission('CASHIER', 'ITEM_VOID_AFTER_PREP', {
        extraCapabilities: ['ITEM_VOID_AFTER_PREP'],
      }),
    ).toEqual({ allowed: true, viaOverride: false });
    expect(evaluatePermission('CASHIER', 'ITEM_VOID_AFTER_PREP')).toEqual({
      allowed: false,
      reason: 'NEEDS_OVERRIDE',
    });
  });

  it('keeps only what really adds to the base role', () => {
    expect(
      extraCapabilitiesOf('WAITER', [
        'REPORTS_VIEW_EXPORT',
        'ORDER_CREATE',
        'STAFF_MANAGE',
        'NOT_A_CAPABILITY',
        'REPORTS_VIEW_EXPORT',
        'ORDER_APPROVE_CUSTOMER',
      ]),
    ).toEqual(['ORDER_APPROVE_CUSTOMER', 'REPORTS_VIEW_EXPORT']);
  });

  it('checks the name, base role and capabilities', () => {
    const draft = {
      name: 'Senior captain',
      baseRole: 'WAITER' as const,
      capabilities: ['DISCOUNT_WITHIN_LIMIT'],
    };
    expect(checkCustomRole(draft, ['Manager', 'Head chef'])).toEqual([]);
    expect(checkCustomRole({ ...draft, name: ' senior CAPTAIN ' }, ['Senior captain'])).toEqual([
      'NAME_TAKEN',
    ]);
    expect(checkCustomRole({ ...draft, name: ' ' }, [])).toEqual(['NAME_REQUIRED']);
    expect(checkCustomRole({ ...draft, baseRole: 'MANAGER' }, [])).toEqual(['BASE_ROLE_INVALID']);
    expect(checkCustomRole({ ...draft, capabilities: ['DATA_ADMIN'] }, [])).toEqual([
      'CAPABILITY_NOT_GRANTABLE',
    ]);
    expect(checkCustomRole({ ...draft, capabilities: ['ORDER_CREATE'] }, [])).toEqual([
      'NOTHING_ADDED',
    ]);
  });
});
