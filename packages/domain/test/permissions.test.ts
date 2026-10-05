import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  canApproveOverride,
  checkCustomRole,
  DEFAULT_PERMISSION_MATRIX,
  evaluatePermission,
  grantFor,
  grantOf,
  OWNER_ONLY_CAPABILITIES,
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
  const captain = {
    role: 'WAITER' as const,
    customRole: {
      added: ['BILL_PRINT_AND_PAYMENT', 'ORDER_APPROVE_CUSTOMER'] as const,
      removed: ['ITEM_CANCEL_BEFORE_PREP'] as const,
    },
  };

  it('adds capabilities outright, takes others away and leaves the rest to the base role', () => {
    expect(grantOf(captain, 'BILL_PRINT_AND_PAYMENT')).toBe('ALLOW');
    // A waiter approves orders for their own tables only; the captain approves them for any.
    expect(grantOf(captain, 'ORDER_APPROVE_CUSTOMER')).toBe('ALLOW');
    expect(grantOf(captain, 'ITEM_CANCEL_BEFORE_PREP')).toBe('DENY');
    expect(grantOf(captain, 'ITEM_VOID_AFTER_PREP')).toBe('OVERRIDE');
    expect(grantOf(captain, 'MENU_MANAGE')).toBe('DENY');
    expect(grantOf({ role: 'CASHIER' }, 'INVOICE_VOID')).toBe('OVERRIDE');
    expect(grantOf({ role: 'CASHIER', customRole: null }, 'INVOICE_VOID')).toBe('OVERRIDE');
  });

  it('keeps tax and invoice settings, data administration and the licence to the Owner', () => {
    expect([...OWNER_ONLY_CAPABILITIES].sort()).toEqual([
      'DATA_ADMIN',
      'LICENSE_MANAGE',
      'TAX_AND_INVOICE_SETTINGS',
    ]);
    expect(
      checkCustomRole('MANAGER', { added: ['TAX_AND_INVOICE_SETTINGS'], removed: [] }),
    ).toEqual([{ capability: 'TAX_AND_INVOICE_SETTINGS', problem: 'OWNER_ONLY' }]);
  });

  it('accepts anything a manager may do, and taking away anything the base role may do', () => {
    expect(checkCustomRole('WAITER', captain.customRole)).toEqual([]);
    expect(
      checkCustomRole('CASHIER', { added: ['STAFF_MANAGE', 'DAY_END_CLOSE'], removed: [] }),
    ).toEqual([]);
    expect(checkCustomRole('MANAGER', { added: [], removed: ['DAY_END_CLOSE'] })).toEqual([]);
  });

  it('refuses changes that change nothing, contradict each other or repeat', () => {
    expect(
      checkCustomRole('WAITER', {
        added: ['ORDER_CREATE', 'MENU_MANAGE', 'MENU_MANAGE'],
        removed: ['DAY_END_CLOSE', 'MENU_MANAGE', 'BILL_REQUEST', 'BILL_REQUEST'],
      }),
    ).toEqual([
      { capability: 'ORDER_CREATE', problem: 'ALREADY_ALLOWED' },
      { capability: 'MENU_MANAGE', problem: 'REPEATED' },
      { capability: 'DAY_END_CLOSE', problem: 'NOT_GRANTED' },
      { capability: 'MENU_MANAGE', problem: 'BOTH' },
      { capability: 'BILL_REQUEST', problem: 'REPEATED' },
    ]);
  });
});
