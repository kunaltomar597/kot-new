import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  ownerSecurity,
  PRIYA,
  SECOND_FACTOR_REQUIRED,
  staffChanged,
  staffList,
  staffView,
  team,
} from './staff-fixture.js';

const RAVI = STAFF.WAITER.staffId;

function staffServer(role: 'MANAGER' | 'OWNER' = 'MANAGER'): FakeServer {
  return signsInAs(server(), role)
    .on('GET', '/api/v1/staff', () => ({ status: 200, body: staffList() }))
    .on('GET', '/api/v1/auth/owner/security', () => ({ status: 200, body: ownerSecurity() }));
}

const nav = () => screen.getByRole('navigation', { name: t('dashboard.navigation') });
const actionsFor = (name: string) =>
  screen.findByRole('group', { name: t('staff.actionsFor', { name }) });
const buttonNames = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .map((button) => button.textContent);
const dialog = (name: string) => screen.findByRole('dialog', { name });
const toastSays = (text: string) => screen.findByText(text);

async function fillPerson(
  user: UserEvent,
  within_: HTMLElement,
  fields: { name?: string; phone?: string; pin?: string; pinAgain?: string },
) {
  const box = within(within_);
  if (fields.name !== undefined) {
    await user.clear(box.getByLabelText(new RegExp(`^${t('staff.form.name')}`)));
    await user.type(box.getByLabelText(new RegExp(`^${t('staff.form.name')}`)), fields.name);
  }
  if (fields.phone !== undefined)
    await user.type(box.getByLabelText(t('staff.form.phone')), fields.phone);
  if (fields.pin !== undefined) {
    await user.clear(box.getByLabelText(new RegExp(`^${t('staff.form.pin')}\\b(?! again)`)));
    await user.type(
      box.getByLabelText(new RegExp(`^${t('staff.form.pin')}\\b(?! again)`)),
      fields.pin,
    );
  }
  if (fields.pinAgain !== undefined) {
    await user.clear(box.getByLabelText(new RegExp(`^${t('staff.form.pinAgain')}`)));
    await user.type(
      box.getByLabelText(new RegExp(`^${t('staff.form.pinAgain')}`)),
      fields.pinAgain,
    );
  }
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MGR-004] the Staff page', () => {
  it('lists everyone with role and state, offering a manager only what they may do', async () => {
    const { container } = await renderConsole({
      fake: staffServer(),
      path: '/manage/staff',
      signedIn: 'MANAGER',
    });
    expect(await screen.findByRole('heading', { level: 2, name: t('staff.title') })).toBeVisible();
    expect(within(nav()).getByRole('link', { name: t('dashboard.section.staff') })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The Owner's own security is not a manager's page.
    expect(
      within(nav()).queryByRole('link', { name: t('dashboard.section.security') }),
    ).not.toBeInTheDocument();

    expect(buttonNames(await actionsFor('Ravi'))).toEqual([
      t('staff.edit'),
      t('staff.changePin'),
      t('staff.unlock'),
      t('staff.deactivate'),
    ]);
    // Their own record, but not their role or whether they work here.
    expect(buttonNames(await actionsFor('Meera'))).toEqual([t('staff.edit'), t('staff.changePin')]);
    expect(buttonNames(await actionsFor('Priya'))).toEqual([t('staff.reactivate')]);
    expect(
      screen.queryByRole('group', { name: t('staff.actionsFor', { name: 'Kunal' }) }),
    ).toBeNull();

    expect(screen.getByText(/^Locked until \d\d:\d\d$/)).toBeVisible();
    expect(screen.getByText(t('staff.inactive'))).toBeVisible();
    expect(screen.getByText(t('staff.phone', { phone: '+91 98765 43210' }))).toBeVisible();
    expect(screen.getByText(t('staff.you'))).toBeVisible();
    expect(screen.getByText(new RegExp(t('staff.managersByOwner')))).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('adds a waiter, checking the name and the PIN typed twice before sending', async () => {
    const fake = staffServer()
      .on(
        'GET',
        '/api/v1/staff',
        () => ({ status: 200, body: staffList() }),
        () => ({
          status: 200,
          body: staffList([
            ...team(),
            staffView('WAITER', { id: RAVI.replace('104', '108'), displayName: 'Sunil' }),
          ]),
        }),
      )
      .on('POST', '/api/v1/staff', (call) => ({
        status: 201,
        body: staffView('WAITER', {
          id: RAVI.replace('104', '108'),
          displayName: (call.body as { displayName: string }).displayName,
        }),
      }));
    const { user } = await renderConsole({ fake, path: '/manage/staff', signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('staff.add') }));
    const add = await dialog(t('staff.form.addTitle'));
    // A manager gives the team's roles, never Manager (AUTH-006).
    const role = within(add).getByRole('combobox', { name: t('staff.form.role') });
    expect(
      within(role)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([t('roles.CASHIER'), t('roles.WAITER'), t('roles.KITCHEN')]);
    expect(role).toHaveValue('WAITER');

    await user.click(within(add).getByRole('button', { name: t('staff.form.add') }));
    expect(within(add).getByText(t('staff.form.nameRequired'))).toBeVisible();
    expect(within(add).getByText(t('staff.form.pinInvalid', { length: 4 }))).toBeVisible();

    await fillPerson(user, add, {
      name: 'Sunil',
      phone: '98765 43210',
      pin: '12a34',
      pinAgain: '1235',
    });
    await user.click(within(add).getByRole('button', { name: t('staff.form.add') }));
    expect(within(add).getByText(t('staff.form.pinMismatch'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/staff')).toHaveLength(0);

    await fillPerson(user, add, { pinAgain: '1234' });
    await user.click(within(add).getByRole('button', { name: t('staff.form.add') }));
    expect(await toastSays(t('staff.added', { name: 'Sunil' }))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/staff')[0]?.body).toEqual({
      displayName: 'Sunil',
      role: 'WAITER',
      pin: '1234',
      phone: '98765 43210',
      email: null,
    });
    expect(await actionsFor('Sunil')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('edits only what changed, and shows the server’s refusal in the dialog', async () => {
    const fake = staffServer().on(
      'PATCH',
      `/api/v1/staff/${RAVI}`,
      () => ({
        status: 422,
        body: { code: 'VALIDATION_FAILED', message: 'Check the highlighted fields.' },
      }),
      () => ({
        status: 200,
        body: staffView('WAITER', { displayName: 'Ravi K', role: 'CASHIER' }),
      }),
    );
    const { user } = await renderConsole({ fake, path: '/manage/staff', signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Ravi')).getByRole('button', { name: t('staff.edit') }),
    );
    const edit = await dialog(t('staff.form.editTitle', { name: 'Ravi' }));
    expect(within(edit).queryByLabelText(new RegExp(`^${t('staff.form.pin')}`))).toBeNull();
    await fillPerson(user, edit, { name: 'Ravi K' });
    await user.selectOptions(
      within(edit).getByRole('combobox', { name: t('staff.form.role') }),
      'CASHIER',
    );
    await user.click(within(edit).getByRole('button', { name: t('staff.form.save') }));
    expect(await within(edit).findByRole('alert')).toHaveTextContent(
      'Check the highlighted fields.',
    );
    await user.click(within(edit).getByRole('button', { name: t('staff.form.save') }));
    expect(await toastSays(t('staff.saved', { name: 'Ravi K' }))).toBeVisible();
    expect(fake.callsTo('PATCH', `/api/v1/staff/${RAVI}`).map((call) => call.body)).toEqual([
      { displayName: 'Ravi K', role: 'CASHIER' },
      { displayName: 'Ravi K', role: 'CASHIER' },
    ]);
  });

  it('[AUTH-003] [AUTH-008] sets a PIN, unlocks, deactivates with a reason and reactivates', async () => {
    const fake = staffServer()
      .on('PUT', `/api/v1/staff/${RAVI}/pin`, () => ({ status: 204 }))
      .on('POST', '/api/v1/auth/unlock', () => ({ status: 204 }))
      .on('POST', `/api/v1/staff/${RAVI}/deactivate`, () => ({
        status: 200,
        body: staffView('WAITER', { active: false }),
      }))
      .on('POST', `/api/v1/staff/${PRIYA.id}/reactivate`, () => ({
        status: 200,
        body: { ...PRIYA, active: true },
      }));
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/staff',
      signedIn: 'MANAGER',
    });

    await user.click(
      within(await actionsFor('Ravi')).getByRole('button', { name: t('staff.changePin') }),
    );
    const pin = await dialog(t('staff.pin.title', { name: 'Ravi' }));
    expect(pin).toHaveAccessibleDescription(t('staff.pin.description'));
    await fillPerson(user, pin, { pin: '4321', pinAgain: '4321' });
    await expectNoAxeViolations(container);
    await user.click(within(pin).getByRole('button', { name: t('staff.pin.save') }));
    expect(await toastSays(t('staff.pinSaved', { name: 'Ravi' }))).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/staff/${RAVI}/pin`)[0]?.body).toEqual({ pin: '4321' });

    await user.click(
      within(await actionsFor('Ravi')).getByRole('button', { name: t('staff.unlock') }),
    );
    expect(await toastSays(t('staff.unlocked', { name: 'Ravi' }))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/auth/unlock')[0]?.body).toEqual({ staffId: RAVI });

    await user.click(
      within(await actionsFor('Ravi')).getByRole('button', { name: t('staff.deactivate') }),
    );
    const deactivate = await dialog(t('staff.deactivateDialog.title', { name: 'Ravi' }));
    expect(deactivate).toHaveAccessibleDescription(
      t('staff.deactivateDialog.description', { name: 'Ravi' }),
    );
    const confirm = within(deactivate).getByRole('button', {
      name: t('staff.deactivateDialog.confirm'),
    });
    expect(confirm).toBeDisabled();
    await user.type(
      within(deactivate).getByLabelText(t('staff.deactivateDialog.reason')),
      'Left the job',
    );
    await user.click(confirm);
    expect(await toastSays(t('staff.deactivated', { name: 'Ravi' }))).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/staff/${RAVI}/deactivate`)[0]?.body).toEqual({
      reason: 'Left the job',
    });

    await user.click(
      within(await actionsFor('Priya')).getByRole('button', { name: t('staff.reactivate') }),
    );
    const reactivate = await dialog(t('staff.reactivateDialog.title', { name: 'Priya' }));
    await user.click(
      within(reactivate).getByRole('button', { name: t('staff.reactivateDialog.confirm') }),
    );
    expect(await toastSays(t('staff.reactivated', { name: 'Priya' }))).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/staff/${PRIYA.id}/reactivate`)).toHaveLength(1);
  });

  it('[ORD-010] follows staff changes made on other screens', async () => {
    const fake = staffServer().on(
      'GET',
      '/api/v1/staff',
      () => ({ status: 200, body: staffList() }),
      () => ({
        status: 200,
        body: staffList(team().filter((person) => person.displayName !== 'Ravi')),
      }),
    );
    const { sockets } = await renderConsole({ fake, path: '/manage/staff', signedIn: 'MANAGER' });
    expect(await actionsFor('Ravi')).toBeVisible();
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', staffChanged(1));
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('group', { name: t('staff.actionsFor', { name: 'Ravi' }) }),
      ).toBeNull();
    });
  });
});

describe('[AUTH-006] the Owner’s second factor', () => {
  it('asks for password and authenticator code before adding a manager, then adds them', async () => {
    const vikram = staffView('MANAGER', {
      id: '0199a0e0-0000-7000-8000-000000000107',
      displayName: 'Vikram',
    });
    const fake = staffServer('OWNER')
      .on(
        'POST',
        '/api/v1/staff',
        () => SECOND_FACTOR_REQUIRED,
        () => ({ status: 201, body: vikram }),
      )
      .on(
        'POST',
        '/api/v1/auth/step-up',
        () => ({
          status: 401,
          body: {
            code: 'INVALID_CREDENTIALS',
            message: 'That did not match. Check and try again.',
          },
        }),
        () => ({ status: 200, body: { secondFactorValidUntil: '2026-09-28T10:10:00.000Z' } }),
      );
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/staff',
      signedIn: 'OWNER',
    });
    expect(
      within(nav()).getByRole('link', { name: t('dashboard.section.security') }),
    ).toBeVisible();
    await user.click(await screen.findByRole('button', { name: t('staff.add') }));
    const add = await dialog(t('staff.form.addTitle'));
    await fillPerson(user, add, { name: 'Vikram', pin: '5678', pinAgain: '5678' });
    await user.selectOptions(
      within(add).getByRole('combobox', { name: t('staff.form.role') }),
      'MANAGER',
    );
    await user.click(within(add).getByRole('button', { name: t('staff.form.add') }));

    const confirm = await dialog(t('secondFactor.title'));
    await within(confirm).findByLabelText(new RegExp(`^${t('secondFactor.password')}`));
    await expectNoAxeViolations(container);
    await user.type(
      within(confirm).getByLabelText(new RegExp(`^${t('secondFactor.password')}`)),
      'correct horse battery',
    );
    await user.type(
      within(confirm).getByLabelText(new RegExp(`^${t('secondFactor.code')}`)),
      '12 34 5',
    );
    await user.click(within(confirm).getByRole('button', { name: t('secondFactor.confirm') }));
    expect(within(confirm).getByText(t('secondFactor.codeInvalid'))).toBeVisible();

    await user.type(within(confirm).getByLabelText(new RegExp(`^${t('secondFactor.code')}`)), '6');
    await user.click(within(confirm).getByRole('button', { name: t('secondFactor.confirm') }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'That did not match. Check and try again.',
    );

    // Lost the phone: a recovery code, typed however.
    await user.click(within(confirm).getByRole('button', { name: t('secondFactor.useRecovery') }));
    const recovery = within(confirm).getByLabelText(
      new RegExp(`^${t('secondFactor.recoveryCode')}`),
    );
    await user.type(recovery, 'abcd efgh');
    expect(recovery).toHaveValue('ABCD-EFGH');
    await user.click(within(confirm).getByRole('button', { name: t('secondFactor.confirm') }));

    expect(await toastSays(t('staff.added', { name: 'Vikram' }))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/auth/step-up').map((call) => call.body)).toEqual([
      { password: 'correct horse battery', secondFactor: { kind: 'TOTP', code: '123456' } },
      {
        password: 'correct horse battery',
        secondFactor: { kind: 'RECOVERY_CODE', code: 'ABCD-EFGH' },
      },
    ]);
    // Tried, confirmed, sent again.
    expect(fake.callsTo('POST', '/api/v1/staff')).toHaveLength(2);
    expect(fake.callsTo('POST', '/api/v1/staff')[1]?.body).toMatchObject({ role: 'MANAGER' });
  });

  it('keeps the dialog open when the Owner cancels, and sends them to set up first', async () => {
    const fake = staffServer('OWNER')
      .on('POST', '/api/v1/staff', () => SECOND_FACTOR_REQUIRED)
      .on(
        'GET',
        '/api/v1/auth/owner/security',
        () => ({ status: 200, body: ownerSecurity() }),
        () => ({
          status: 200,
          body: ownerSecurity({ hasAuthenticator: false, recoveryCodesLeft: 0 }),
        }),
      );
    const { user } = await renderConsole({ fake, path: '/manage/staff', signedIn: 'OWNER' });
    const deactivateMeera = async () => {
      await user.click(
        within(await actionsFor('Meera')).getByRole('button', { name: t('staff.deactivate') }),
      );
      const reason = await dialog(t('staff.deactivateDialog.title', { name: 'Meera' }));
      await user.type(
        within(reason).getByLabelText(t('staff.deactivateDialog.reason')),
        'Moved city',
      );
      fake.on(
        'POST',
        `/api/v1/staff/${STAFF.MANAGER.staffId}/deactivate`,
        () => SECOND_FACTOR_REQUIRED,
      );
      await user.click(
        within(reason).getByRole('button', { name: t('staff.deactivateDialog.confirm') }),
      );
      return reason;
    };

    const reason = await deactivateMeera();
    const confirm = await dialog(t('secondFactor.title'));
    await user.click(within(confirm).getByRole('button', { name: t('secondFactor.cancel') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('secondFactor.title') })).toBeNull();
    });
    // Nothing happened and nothing failed: the reason is still there to try again.
    expect(reason).toBeVisible();
    expect(within(reason).queryByRole('alert')).toBeNull();
    await user.click(
      within(reason).getByRole('button', { name: t('staff.deactivateDialog.confirm') }),
    );

    // No authenticator yet: nothing to confirm with, so the Owner is sent to set one up.
    const setUp = await dialog(t('secondFactor.title'));
    expect(await within(setUp).findByText(t('secondFactor.notSetUp'))).toBeVisible();
    await user.click(within(setUp).getByRole('button', { name: t('secondFactor.openSecurity') }));
    expect(
      await screen.findByRole('heading', { level: 2, name: t('ownerSecurity.title') }),
    ).toBeVisible();
  });
});

describe('[SEC-003] [AUTH-010] who opens the Staff and Security pages', () => {
  it('does not open Staff for a cashier', async () => {
    await renderConsole({
      fake: signsInAs(server(), 'CASHIER'),
      signedIn: 'CASHIER',
      path: '/manage/staff',
    });
    expect(
      await screen.findByText(t('modes.notAllowed', { mode: t('modes.manage') })),
    ).toBeInTheDocument();
  });

  it('takes a manager from Security back to the overview', async () => {
    await renderConsole({ fake: staffServer(), signedIn: 'MANAGER', path: '/manage/security' });
    expect(
      await screen.findByRole('region', { name: t('dashboard.overview.glance') }),
    ).toBeVisible();
  });
});

describe('[AUTH-001] the sign-in screen', () => {
  it('shows a person added on another screen without a reload', async () => {
    const fake = server().on(
      'GET',
      '/api/v1/auth/staff-tiles',
      () => ({ status: 200, body: { staff: [STAFF.CASHIER] } }),
      () => ({ status: 200, body: { staff: [STAFF.CASHIER, STAFF.WAITER] } }),
    );
    const { sockets } = await renderConsole({ fake });
    expect(await screen.findByRole('button', { name: /Asha/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Ravi/ })).toBeNull();
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', staffChanged(1));
    });
    expect(await screen.findByRole('button', { name: /Ravi/ })).toBeVisible();
  });
});
