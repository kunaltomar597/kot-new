import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  canApproveOverride,
  DEFAULT_PERMISSION_MATRIX,
  evaluatePermission,
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
