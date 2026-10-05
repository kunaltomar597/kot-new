import {
  ASSIGNABLE_ROLES,
  CAPABILITIES,
  type Capability,
  checkCustomRole,
  OWNER_ONLY_CAPABILITIES,
} from '@rp/domain';
import { describe, expect, it } from 'vitest';
import {
  activeRoleNames,
  CAPABILITY_GROUPS,
  changeOf,
  changesFor,
  checkRole,
  countsAsManager,
  emptyRoleForm,
  grantWith,
  roleChanged,
  roleFormOf,
  roleRequestOf,
  rolesInOrder,
  withBaseRole,
  withChange,
} from '../src/manage/staff/roles-view.js';
import { CAPTAIN, HEAD_CASHIER, RUNNER } from './roles-fixture.js';

describe('[AUTH-012] the role editor', () => {
  it('lists every permission once, except what only the Owner may do', () => {
    const listed: Capability[] = Object.values(CAPABILITY_GROUPS).flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect(
      CAPABILITIES.filter((capability) => !listed.includes(capability)).sort((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(['DATA_ADMIN', 'LICENSE_MANAGE', 'TAX_AND_INVOICE_SETTINGS']);
    expect(listed.some((capability) => OWNER_ONLY_CAPABILITIES.has(capability))).toBe(false);
  });

  it('offers only settings that change something, the base role’s own first', () => {
    // Allowed outright: can only be taken away.
    expect(changesFor('WAITER', 'ORDER_CREATE')).toEqual(['BASE', 'REMOVE']);
    // Never allowed: can only be added.
    expect(changesFor('WAITER', 'BILL_PRINT_AND_PAYMENT')).toEqual(['BASE', 'ADD']);
    // Own tables only, or with a manager's PIN: given outright or taken away.
    expect(changesFor('WAITER', 'TABLE_MOVE_MERGE')).toEqual(['BASE', 'ADD', 'REMOVE']);
    expect(changesFor('CASHIER', 'ITEM_VOID_AFTER_PREP')).toEqual(['BASE', 'ADD', 'REMOVE']);
    expect(grantWith('WAITER', 'TABLE_MOVE_MERGE', 'BASE')).toBe('OWN');
    expect(grantWith('WAITER', 'TABLE_MOVE_MERGE', 'ADD')).toBe('ALLOW');
    expect(grantWith('WAITER', 'TABLE_MOVE_MERGE', 'REMOVE')).toBe('DENY');
  });

  it('never builds a role the server refuses', () => {
    for (const baseRole of ASSIGNABLE_ROLES) {
      for (const capability of Object.values(CAPABILITY_GROUPS).flat()) {
        for (const change of changesFor(baseRole, capability)) {
          const request = roleRequestOf(
            withChange({ ...emptyRoleForm(baseRole), name: 'Role' }, capability, change),
          );
          expect(checkCustomRole(baseRole, request), `${baseRole} ${capability} ${change}`).toEqual(
            [],
          );
        }
      }
    }
  });

  it('sends what changed, in the matrix’s order, and nothing for the base role’s own', () => {
    let form = { ...emptyRoleForm('WAITER'), name: ' Captain ' };
    form = withChange(form, 'DISCOUNT_WITHIN_LIMIT', 'ADD');
    form = withChange(form, 'BILL_PRINT_AND_PAYMENT', 'ADD');
    form = withChange(form, 'TABLE_MOVE_MERGE', 'REMOVE');
    form = withChange(form, 'DISCOUNT_WITHIN_LIMIT', 'BASE');
    expect(changeOf(form, 'BILL_PRINT_AND_PAYMENT')).toBe('ADD');
    expect(changeOf(form, 'DISCOUNT_WITHIN_LIMIT')).toBe('BASE');
    expect(roleRequestOf(form)).toEqual({
      name: 'Captain',
      baseRole: 'WAITER',
      added: ['BILL_PRINT_AND_PAYMENT'],
      removed: ['TABLE_MOVE_MERGE'],
    });
  });

  it('keeps the changes that still mean something on another base role', () => {
    const captain = withChange(roleFormOf(CAPTAIN), 'ORDER_CREATE', 'REMOVE');
    // A cashier already takes payments; taking orders away still means something.
    expect(roleRequestOf(withBaseRole(captain, 'CASHIER'))).toMatchObject({
      baseRole: 'CASHIER',
      added: [],
      removed: ['ORDER_CREATE'],
    });
    // The kitchen never takes orders, but taking payments is new.
    expect(roleRequestOf(withBaseRole(captain, 'KITCHEN'))).toMatchObject({
      baseRole: 'KITCHEN',
      added: ['BILL_PRINT_AND_PAYMENT'],
      removed: [],
    });
  });

  it('checks the name like the server: given, short, and nobody else’s', () => {
    const taken = ['Owner', 'Manager', 'Cashier', 'Waiter', 'Kitchen', 'Head cashier'];
    const named = (name: string) => ({ ...emptyRoleForm(), name });
    expect(checkRole(named('  '), taken)).toEqual({ name: 'nameRequired' });
    expect(checkRole(named('x'.repeat(41)), taken)).toEqual({ name: 'nameRequired' });
    expect(checkRole(named(' waiter '), taken)).toEqual({ name: 'nameTaken' });
    expect(checkRole(named('HEAD CASHIER'), taken)).toEqual({ name: 'nameTaken' });
    expect(checkRole(named('Captain'), taken)).toEqual({});
    // An archived role's name is free again, and a role keeps its own.
    expect(activeRoleNames([CAPTAIN, HEAD_CASHIER, RUNNER], CAPTAIN.id)).toEqual(['Head cashier']);
  });

  it('notices when nothing changed, whatever the order permissions were listed in', () => {
    const role = {
      ...CAPTAIN,
      added: ['DISCOUNT_WITHIN_LIMIT', 'BILL_PRINT_AND_PAYMENT'] as Capability[],
    };
    expect(roleChanged(role, roleFormOf(role))).toBe(false);
    expect(roleChanged(role, { ...roleFormOf(role), name: 'Captain ' })).toBe(false);
    expect(roleChanged(role, withChange(roleFormOf(role), 'BILL_REPRINT', 'ADD'))).toBe(true);
    expect(roleChanged(role, withBaseRole(roleFormOf(role), 'CASHIER'))).toBe(true);
  });

  it('[AUTH-006] marks the roles that make someone a manager', () => {
    expect(countsAsManager(CAPTAIN)).toBe(false);
    expect(countsAsManager(HEAD_CASHIER)).toBe(true);
    expect(countsAsManager({ baseRole: 'MANAGER', added: [], removed: ['MENU_MANAGE'] })).toBe(
      true,
    );
  });

  it('lists active roles first', () => {
    expect(rolesInOrder([RUNNER, CAPTAIN, HEAD_CASHIER]).map((role) => role.name)).toEqual([
      'Captain',
      'Head cashier',
      'Runner',
    ]);
  });
});
