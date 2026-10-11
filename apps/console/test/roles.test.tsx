import type { RoleView } from '@rp/contracts';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addable,
  included,
  roleProblem,
  roleRequestOf,
  sortRoles,
} from '../src/manage/staff/roles-view.js';
import {
  fromRoleChoice,
  roleChoiceOf,
  roleChoices,
  updateRequestOf,
} from '../src/manage/staff/staff-view.js';
import type { FakeServer } from './fake-server.js';
import { STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { ownerSecurity, staffList, staffView } from './staff-fixture.js';

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CAPTAIN = uuid(1201);

function role(overrides: Partial<RoleView> = {}): RoleView {
  return {
    id: CAPTAIN,
    name: 'Senior captain',
    baseRole: 'WAITER',
    builtIn: false,
    capabilities: ['ORDER_APPROVE_CUSTOMER', 'DISCOUNT_WITHIN_LIMIT'],
    staffCount: 1,
    archivedAt: null,
    ...overrides,
  };
}

function roles(): RoleView[] {
  return [
    role({ id: uuid(1211), name: 'Waiter', builtIn: true, capabilities: [], staffCount: 3 }),
    role({ id: uuid(1212), name: 'Owner', baseRole: 'OWNER', builtIn: true, capabilities: [] }),
    role(),
    role({
      id: uuid(1202),
      name: 'Old role',
      staffCount: 0,
      archivedAt: '2026-09-20T10:00:00.000Z',
    }),
  ];
}

function rolesServer(as: 'MANAGER' | 'OWNER'): FakeServer {
  return signsInAs(server(), as)
    .on('GET', '/api/v1/roles', () => ({ status: 200, body: { roles: roles() } }))
    .on('GET', '/api/v1/staff', () => ({ status: 200, body: staffList() }))
    .on('GET', '/api/v1/auth/owner/security', () => ({ status: 200, body: ownerSecurity() }));
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[AUTH-012] what a custom role may add', () => {
  it('offers only what the base role lacks, never staff or Owner-only powers', () => {
    expect(addable('WAITER')).toContain('ORDER_APPROVE_CUSTOMER');
    expect(addable('WAITER')).not.toContain('ORDER_CREATE');
    expect(addable('WAITER')).not.toContain('STAFF_MANAGE');
    expect(included('WAITER')).toContain('ORDER_CREATE');
    expect(addable('KITCHEN')).not.toContain('ITEM_MARK_PREPARING_READY');
  });

  it('checks the name and that something is added, and sends only what adds', () => {
    const form = { name: 'Head chef', baseRole: 'KITCHEN' as const, capabilities: [] };
    expect(roleProblem(form, roles())).toBe('NOTHING_ADDED');
    expect(roleProblem({ ...form, capabilities: ['MENU_MANAGE'] }, roles())).toBeUndefined();
    expect(
      roleProblem({ ...form, name: 'senior captain', capabilities: ['MENU_MANAGE'] }, roles()),
    ).toBe('NAME_TAKEN');
    // Its own name is not taken when it is edited.
    expect(
      roleProblem(
        { ...form, name: 'Senior captain', capabilities: ['MENU_MANAGE'] },
        roles(),
        CAPTAIN,
      ),
    ).toBeUndefined();
    expect(
      roleRequestOf({
        name: ' Head chef ',
        baseRole: 'KITCHEN',
        capabilities: ['MENU_MANAGE', 'ITEM_MARK_PREPARING_READY'],
      }),
    ).toEqual({ name: 'Head chef', baseRole: 'KITCHEN', capabilities: ['MENU_MANAGE'] });
    const sorted = sortRoles(roles());
    expect(sorted.builtIn.map((entry) => entry.baseRole)).toEqual(['OWNER', 'WAITER']);
    expect(sorted.custom.map((entry) => entry.name)).toEqual(['Senior captain', 'Old role']);
  });

  it('offers custom roles under their base role when giving someone a role', () => {
    const choices = roleChoices(['CASHIER', 'WAITER'], roles(), (r) => r);
    expect(choices.map((choice) => choice.value)).toEqual([
      'CASHIER',
      'WAITER',
      `custom:${CAPTAIN}`,
    ]);
    expect(fromRoleChoice(`custom:${CAPTAIN}`, roles())).toEqual({
      role: 'WAITER',
      customRoleId: CAPTAIN,
    });
    expect(fromRoleChoice('CASHIER', roles())).toEqual({ role: 'CASHIER', customRoleId: '' });
    expect(roleChoiceOf({ role: 'WAITER', customRoleId: CAPTAIN })).toBe(`custom:${CAPTAIN}`);
    const ravi = staffView('WAITER');
    const form = {
      displayName: ravi.displayName,
      role: 'WAITER' as const,
      customRoleId: CAPTAIN,
      phone: '',
      email: '',
      pin: '',
      pinAgain: '',
    };
    expect(updateRequestOf(ravi, form)).toEqual({ customRoleId: CAPTAIN });
    expect(
      updateRequestOf({ ...ravi, customRoleId: CAPTAIN }, { ...form, customRoleId: '' }),
    ).toEqual({
      customRoleId: null,
    });
    expect(updateRequestOf(ravi, { ...form, role: 'CASHIER', customRoleId: '' })).toEqual({
      role: 'CASHIER',
    });
  });
});

describe('[AUTH-012] [MGR-004] the Roles page', () => {
  it('shows a manager the roles without changing them', async () => {
    const { container } = await renderConsole({
      fake: rolesServer('MANAGER'),
      path: '/manage/staff/roles',
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('customRoles.title') }),
    ).toBeVisible();
    const captain = (
      await screen.findByRole('heading', { level: 4, name: 'Senior captain' })
    ).closest('li') as HTMLElement;
    expect(
      within(captain).getByText(t('customRoles.onBase', { role: t('roles.WAITER') })),
    ).toBeVisible();
    expect(
      within(captain).getByText(
        t('customRoles.adds', {
          list: `${t('capabilities.ORDER_APPROVE_CUSTOMER')}; ${t('capabilities.DISCOUNT_WITHIN_LIMIT')}`,
        }),
      ),
    ).toBeVisible();
    expect(screen.getByText(t('customRoles.ownerOnly'), { exact: false })).toBeVisible();
    expect(screen.queryByRole('button', { name: t('customRoles.add') })).toBeNull();
    expect(
      screen.queryByRole('group', {
        name: t('customRoles.actionsFor', { name: 'Senior captain' }),
      }),
    ).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('lets the Owner add a role built on the kitchen role', async () => {
    const fake = rolesServer('OWNER').on('POST', '/api/v1/roles', () => ({
      status: 201,
      body: role({
        id: uuid(1203),
        name: 'Head chef',
        baseRole: 'KITCHEN',
        capabilities: ['MENU_MANAGE'],
      }),
    }));
    const { user } = await renderConsole({ fake, path: '/manage/staff/roles', signedIn: 'OWNER' });
    await user.click(await screen.findByRole('button', { name: t('customRoles.add') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('customRoles.form.addTitle') }),
    );
    await user.type(
      dialog.getByLabelText(new RegExp(`^${t('customRoles.form.name')}`)),
      'Head chef',
    );
    await user.selectOptions(
      dialog.getByLabelText(new RegExp(`^${t('customRoles.form.base')}`)),
      'KITCHEN',
    );
    await user.click(dialog.getByRole('button', { name: t('customRoles.form.create') }));
    expect(dialog.getByText(t('customRoles.form.nothingAdded'))).toBeVisible();
    await user.click(dialog.getByRole('checkbox', { name: t('capabilities.MENU_MANAGE') }));
    await user.click(dialog.getByRole('button', { name: t('customRoles.form.create') }));
    expect(await screen.findByText(t('customRoles.added', { name: 'Head chef' }))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/roles')[0]?.body).toEqual({
      name: 'Head chef',
      baseRole: 'KITCHEN',
      capabilities: ['MENU_MANAGE'],
    });
  });

  it('gives a person a custom role from the Staff page', async () => {
    const fake = rolesServer('MANAGER').on(
      'PATCH',
      `/api/v1/staff/${STAFF.WAITER.staffId}`,
      () => ({
        status: 200,
        body: { ...staffView('WAITER'), customRoleId: CAPTAIN, customRoleName: 'Senior captain' },
      }),
    );
    const { user } = await renderConsole({ fake, path: '/manage/staff', signedIn: 'MANAGER' });
    await user.click(
      within(
        await screen.findByRole('group', {
          name: t('staff.actionsFor', { name: STAFF.WAITER.displayName }),
        }),
      ).getByRole('button', { name: t('staff.edit') }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await user.selectOptions(dialog.getByLabelText(t('staff.form.role')), `custom:${CAPTAIN}`);
    await user.click(dialog.getByRole('button', { name: t('staff.form.save') }));
    expect(fake.callsTo('PATCH', `/api/v1/staff/${STAFF.WAITER.staffId}`)[0]?.body).toEqual({
      customRoleId: CAPTAIN,
    });
  });
});
