import { screen, waitFor, within } from '@testing-library/react';
import type { CustomRoleRequest } from '@rp/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { login, STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  CAPTAIN,
  customRole,
  HEAD_CASHIER,
  personRole,
  roleList,
  RUNNER,
} from './roles-fixture.js';
import {
  ownerSecurity,
  SECOND_FACTOR_REQUIRED,
  staffList,
  staffView,
  team,
} from './staff-fixture.js';

const RAVI = STAFF.WAITER.staffId;

function rolesServer(role: 'MANAGER' | 'OWNER' = 'OWNER'): FakeServer {
  return signsInAs(server(), role)
    .on('GET', '/api/v1/roles', () => ({ status: 200, body: roleList() }))
    .on('GET', '/api/v1/staff', () => ({ status: 200, body: staffList() }))
    .on('GET', '/api/v1/auth/owner/security', () => ({ status: 200, body: ownerSecurity() }));
}

const staffPages = () => screen.getByRole('navigation', { name: t('staff.pages.label') });
const dashboardNav = () => screen.getByRole('navigation', { name: t('dashboard.navigation') });
const rowOf = async (name: string) =>
  (await screen.findByRole('heading', { level: 3, name })).closest('li') as HTMLElement;
const actionsFor = (name: string) =>
  screen.findByRole('group', { name: t('customRoles.actionsFor', { name }) });
const buttonNames = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .map((button) => button.textContent);
const permission = (capability: 'BILL_PRINT_AND_PAYMENT' | 'STAFF_MANAGE' | 'ORDER_CREATE') =>
  screen.getByRole('combobox', { name: new RegExp(`^${t(`capabilities.${capability}`)}`) });
const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent);

async function confirmSecondFactor(user: Awaited<ReturnType<typeof renderConsole>>['user']) {
  const confirm = await screen.findByRole('dialog', { name: t('secondFactor.title') });
  await user.type(
    await within(confirm).findByLabelText(new RegExp(`^${t('secondFactor.password')}`)),
    'correct horse battery',
  );
  await user.type(
    within(confirm).getByLabelText(new RegExp(`^${t('secondFactor.code')}`)),
    '123456',
  );
  await user.click(within(confirm).getByRole('button', { name: t('secondFactor.confirm') }));
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[AUTH-012] the Roles page', () => {
  it('shows a manager the custom roles to give, without changing them', async () => {
    const { container } = await renderConsole({
      fake: rolesServer('MANAGER'),
      path: '/manage/staff/roles',
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('customRoles.title') }),
    ).toBeVisible();
    expect(
      within(staffPages()).getByRole('link', { name: t('staff.pages.roles') }),
    ).toHaveAttribute('aria-current', 'page');

    const captain = within(await rowOf('Captain'));
    expect(captain.getByText(t('customRoles.basedOn', { role: t('roles.WAITER') }))).toBeVisible();
    expect(
      captain.getByText(t('customRoles.adds', { list: t('capabilities.BILL_PRINT_AND_PAYMENT') })),
    ).toBeVisible();
    expect(captain.getByText(t('customRoles.people', { count: 0 }))).toBeVisible();
    const headCashier = within(await rowOf('Head cashier'));
    expect(headCashier.getByText(t('customRoles.countsAsManager'))).toBeVisible();
    expect(headCashier.getByText(t('customRoles.people', { count: 1 }))).toBeVisible();
    const runner = within(await rowOf('Runner'));
    expect(runner.getByText(t('customRoles.archived'))).toBeVisible();
    expect(
      runner.getByText(t('customRoles.takesAway', { list: t('capabilities.ORDER_CREATE') })),
    ).toBeVisible();

    // Only the Owner creates and changes roles.
    expect(screen.getByText(new RegExp(t('customRoles.ownerOnly')))).toBeVisible();
    expect(screen.queryByRole('button', { name: t('customRoles.add') })).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('keeps the role editor to the Owner', async () => {
    await renderConsole({
      fake: rolesServer('MANAGER'),
      path: '/manage/staff/roles/new',
      signedIn: 'MANAGER',
    });
    expect(await screen.findByRole('heading', { level: 2, name: t('staff.title') })).toBeVisible();
  });

  it('[AUTH-006] lets the Owner create a role after confirming the second factor', async () => {
    const created = customRole({ id: '0199a0e0-0000-7000-8000-00000000c009' });
    const fake = rolesServer()
      .on(
        'GET',
        '/api/v1/roles',
        () => ({ status: 200, body: roleList([HEAD_CASHIER, RUNNER]) }),
        () => ({ status: 200, body: roleList([HEAD_CASHIER, RUNNER]) }),
        () => ({ status: 200, body: roleList([created, HEAD_CASHIER, RUNNER]) }),
      )
      .on(
        'POST',
        '/api/v1/roles',
        () => SECOND_FACTOR_REQUIRED,
        () => ({ status: 201, body: created }),
      )
      .on('POST', '/api/v1/auth/step-up', () => ({
        status: 200,
        body: { secondFactorValidUntil: '2026-10-05T10:10:00.000Z' },
      }));
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/staff/roles',
      signedIn: 'OWNER',
    });
    await user.click(await screen.findByRole('button', { name: t('customRoles.add') }));
    expect(
      await screen.findByRole('heading', { level: 2, name: t('customRoles.editor.newTitle') }),
    ).toBeVisible();
    const create = screen.getByRole('button', { name: t('customRoles.editor.create') });
    await user.click(create);
    expect(screen.getByText(t('customRoles.editor.nameRequired'))).toBeVisible();
    const name = screen.getByLabelText(new RegExp(`^${t('customRoles.editor.name')}`));
    await user.type(name, 'waiter');
    expect(screen.getByText(t('customRoles.editor.nameTaken'))).toBeVisible();
    await user.clear(name);
    await user.type(name, 'Captain');

    expect(screen.getByRole('combobox', { name: /^Built on/ })).toHaveValue('WAITER');
    const payments = permission('BILL_PRINT_AND_PAYMENT');
    expect(optionLabels(payments)).toEqual([
      t('customRoles.editor.asBase', {
        grant: t('customRoles.editor.grants.DENY'),
        role: t('roles.WAITER'),
      }),
      t('customRoles.editor.grants.ALLOW'),
    ]);
    await user.selectOptions(payments, 'ADD');
    expect(payments).toHaveAccessibleDescription(t('customRoles.editor.changed'));
    // What only the Owner may do is not offered at all.
    expect(
      screen.queryByRole('combobox', { name: t('capabilities.TAX_AND_INVOICE_SETTINGS') }),
    ).toBeNull();
    await expectNoAxeViolations(container);

    await user.click(create);
    await confirmSecondFactor(user);
    expect(await screen.findByText(t('customRoles.created', { name: 'Captain' }))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/roles').map((call) => call.body)).toEqual([
      { name: 'Captain', baseRole: 'WAITER', added: ['BILL_PRINT_AND_PAYMENT'], removed: [] },
      { name: 'Captain', baseRole: 'WAITER', added: ['BILL_PRINT_AND_PAYMENT'], removed: [] },
    ] satisfies CustomRoleRequest[]);
    expect(await rowOf('Captain')).toBeVisible();
  });

  it('changes a role, saying who it reaches and when it makes someone a manager', async () => {
    const fake = rolesServer().on('PUT', `/api/v1/roles/${HEAD_CASHIER.id}`, (call) => ({
      status: 200,
      body: { ...HEAD_CASHIER, ...(call.body as CustomRoleRequest) },
    }));
    const { user } = await renderConsole({
      fake,
      path: `/manage/staff/roles/${HEAD_CASHIER.id}`,
      signedIn: 'OWNER',
    });
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: t('customRoles.editor.editTitle', { name: 'Head cashier' }),
      }),
    ).toBeVisible();
    expect(screen.getByText(t('customRoles.editor.staffNote', { count: 1 }))).toBeVisible();
    expect(screen.getByText(t('customRoles.editor.managerNote'))).toBeVisible();

    // Saving without a change sends nothing.
    await user.click(screen.getByRole('button', { name: t('customRoles.editor.save') }));
    expect(
      await screen.findByRole('heading', { level: 2, name: t('customRoles.title') }),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/roles/${HEAD_CASHIER.id}`)).toHaveLength(0);

    await user.click(
      within(await actionsFor('Head cashier')).getByRole('button', { name: 'Edit' }),
    );
    const staff = await waitFor(() => permission('STAFF_MANAGE'));
    expect(staff).toHaveValue('ADD');
    await user.selectOptions(staff, 'BASE');
    expect(screen.queryByText(t('customRoles.editor.managerNote'))).toBeNull();
    await user.selectOptions(permission('ORDER_CREATE'), 'REMOVE');
    await user.click(screen.getByRole('button', { name: t('customRoles.editor.save') }));
    expect(await screen.findByText(t('customRoles.saved', { name: 'Head cashier' }))).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/roles/${HEAD_CASHIER.id}`)[0]?.body).toEqual({
      name: 'Head cashier',
      baseRole: 'CASHIER',
      added: [],
      removed: ['ORDER_CREATE'],
    });
  });

  it('archives a role nobody has, with a reason, and restores an archived one', async () => {
    const fake = rolesServer()
      .on('POST', `/api/v1/roles/${CAPTAIN.id}/archive`, () => ({
        status: 200,
        body: { ...CAPTAIN, archivedAt: '2026-10-05T11:00:00.000Z' },
      }))
      .on('POST', `/api/v1/roles/${RUNNER.id}/restore`, () => ({
        status: 200,
        body: { ...RUNNER, archivedAt: null },
      }));
    const { user } = await renderConsole({
      fake,
      path: '/manage/staff/roles',
      signedIn: 'OWNER',
    });
    expect(buttonNames(await actionsFor('Captain'))).toEqual([
      t('customRoles.edit'),
      t('customRoles.archive'),
    ]);
    // Someone has it: they need another role first.
    expect(buttonNames(await actionsFor('Head cashier'))).toEqual([t('customRoles.edit')]);
    expect(within(await rowOf('Head cashier')).getByText(t('customRoles.inUse'))).toBeVisible();
    expect(buttonNames(await actionsFor('Runner'))).toEqual([t('customRoles.restore')]);

    await user.click(
      within(await actionsFor('Captain')).getByRole('button', { name: t('customRoles.archive') }),
    );
    const archive = await screen.findByRole('dialog', {
      name: t('customRoles.archiveDialog.title', { name: 'Captain' }),
    });
    await user.type(
      within(archive).getByLabelText(t('customRoles.archiveDialog.reason')),
      'Nobody needs it',
    );
    await user.click(
      within(archive).getByRole('button', { name: t('customRoles.archiveDialog.confirm') }),
    );
    expect(
      await screen.findByText(t('customRoles.archivedDone', { name: 'Captain' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/roles/${CAPTAIN.id}/archive`)[0]?.body).toEqual({
      reason: 'Nobody needs it',
    });

    await user.click(
      within(await actionsFor('Runner')).getByRole('button', { name: t('customRoles.restore') }),
    );
    const restore = await screen.findByRole('dialog', {
      name: t('customRoles.restoreDialog.title', { name: 'Runner' }),
    });
    await user.click(
      within(restore).getByRole('button', { name: t('customRoles.restoreDialog.confirm') }),
    );
    expect(await screen.findByText(t('customRoles.restored', { name: 'Runner' }))).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/roles/${RUNNER.id}/restore`)).toHaveLength(1);
  });
});

describe('[AUTH-012] [MGR-004] custom roles on the People page', () => {
  it('shows people’s custom roles and gives one', async () => {
    const people = team().map((person) =>
      person.id === STAFF.CASHIER.staffId
        ? { ...person, customRole: personRole(HEAD_CASHIER) }
        : person,
    );
    const fake = rolesServer('MANAGER')
      .on('GET', '/api/v1/staff', () => ({ status: 200, body: staffList(people) }))
      .on('PATCH', `/api/v1/staff/${RAVI}`, () => ({
        status: 200,
        body: staffView('WAITER', { customRole: personRole(CAPTAIN) }),
      }));
    const { user } = await renderConsole({ fake, path: '/manage/staff', signedIn: 'MANAGER' });
    const asha = within(await rowOf('Asha'));
    expect(asha.getByText('Head cashier (Cashier)')).toBeVisible();
    // Their role manages staff, so only the Owner changes their record.
    expect(
      screen.queryByRole('group', { name: t('staff.actionsFor', { name: 'Asha' }) }),
    ).toBeNull();

    await user.click(
      within(
        await screen.findByRole('group', { name: t('staff.actionsFor', { name: 'Ravi' }) }),
      ).getByRole('button', { name: t('staff.edit') }),
    );
    const edit = await screen.findByRole('dialog', {
      name: t('staff.form.editTitle', { name: 'Ravi' }),
    });
    const role = within(edit).getByRole('combobox', { name: t('staff.form.role') });
    await waitFor(() => {
      expect(optionLabels(role)).toEqual([
        t('roles.CASHIER'),
        t('roles.WAITER'),
        t('roles.KITCHEN'),
        'Captain (Waiter)',
      ]);
    });
    await user.selectOptions(role, `custom:${CAPTAIN.id}`);
    await user.click(within(edit).getByRole('button', { name: t('staff.form.save') }));
    expect(await screen.findByText(t('staff.saved', { name: 'Ravi' }))).toBeVisible();
    expect(fake.callsTo('PATCH', `/api/v1/staff/${RAVI}`)[0]?.body).toEqual({
      role: 'WAITER',
      customRoleId: CAPTAIN.id,
    });
  });

  it('opens the dashboard on Staff for a cashier whose custom role looks after staff', async () => {
    const headCashier = login('CASHIER');
    const fake = rolesServer().on('POST', '/api/v1/auth/pin-login', () => ({
      status: 200,
      body: {
        ...headCashier,
        staff: { ...headCashier.staff, customRole: personRole(HEAD_CASHIER) },
      },
    }));
    await renderConsole({ fake, path: '/manage', signedIn: 'CASHIER' });
    expect(await screen.findByRole('heading', { level: 2, name: t('staff.title') })).toBeVisible();
    expect(
      within(dashboardNav())
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([t('dashboard.section.alerts'), t('dashboard.section.staff')]);
    expect(screen.getByText(/Head cashier/)).toBeVisible();
  });
});
