import type { CustomRoleView, PersonCustomRole } from '@rp/contracts';

/** Custom roles for the Roles page and staff editor tests (P4-02e). */

const UPDATED = '2026-10-05T10:00:00.000Z';

export function customRole(overrides: Partial<CustomRoleView> = {}): CustomRoleView {
  return {
    id: '0199a0e0-0000-7000-8000-00000000c001',
    name: 'Captain',
    baseRole: 'WAITER',
    added: ['BILL_PRINT_AND_PAYMENT'],
    removed: [],
    staffCount: 0,
    archivedAt: null,
    updatedAt: UPDATED,
    ...overrides,
  };
}

/** A waiter who also prints bills and takes payments. */
export const CAPTAIN = customRole();

/** A cashier who looks after staff: counts as a manager. */
export const HEAD_CASHIER = customRole({
  id: '0199a0e0-0000-7000-8000-00000000c002',
  name: 'Head cashier',
  baseRole: 'CASHIER',
  added: ['STAFF_MANAGE'],
  staffCount: 1,
});

/** A waiter who no longer takes orders; archived. */
export const RUNNER = customRole({
  id: '0199a0e0-0000-7000-8000-00000000c003',
  name: 'Runner',
  added: [],
  removed: ['ORDER_CREATE'],
  archivedAt: UPDATED,
});

/** As the server lists them: by name, archived ones included. */
export function roleList(roles: CustomRoleView[] = [CAPTAIN, HEAD_CASHIER, RUNNER]) {
  return { roles };
}

/** A custom role as a person's record and sign-in carry it. */
export function personRole(role: CustomRoleView): PersonCustomRole {
  return { id: role.id, name: role.name, added: role.added, removed: role.removed };
}
