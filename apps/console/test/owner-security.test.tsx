import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupedKey } from '../src/owner/OwnerSecurityScreen.js';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { ownerSecurity, SECOND_FACTOR_REQUIRED } from './staff-fixture.js';

const ENROLMENT = {
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUri:
    'otpauth://totp/Spice%20Route:Kunal?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Spice%20Route&algorithm=SHA1&digits=6&period=30',
};
const RECOVERY_CODES = [
  'ABCD-EFGH',
  'JKLM-NPQR',
  'STUV-WXYZ',
  '2345-6789',
  'AB23-CD45',
  'EF67-GH89',
  'JK23-LM45',
  'NP67-QR89',
  'ST23-UV45',
  'WX67-YZ89',
];

function ownerServer(...security: ReturnType<typeof ownerSecurity>[]): FakeServer {
  return signsInAs(server(), 'OWNER').on(
    'GET',
    '/api/v1/auth/owner/security',
    ...security.map((body) => () => ({ status: 200, body })),
  );
}

const dialog = (name: string) => screen.findByRole('dialog', { name });
/** The field labelled exactly `label` (a required field's label ends in " *"). */
const field = (box: HTMLElement, label: string) =>
  within(box).getByLabelText(
    new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\*)?$`),
  );

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[AUTH-006] the Owner’s sign-in security', () => {
  it('sets the first password without a second factor, checking length and the repeat', async () => {
    const fresh = ownerSecurity({
      hasPassword: false,
      hasAuthenticator: false,
      recoveryCodesLeft: 0,
    });
    const fake = ownerServer(fresh, { ...fresh, hasPassword: true }).on(
      'POST',
      '/api/v1/auth/owner/password',
      () => ({ status: 204 }),
    );
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/security',
      signedIn: 'OWNER',
    });
    expect(await screen.findByText(t('ownerSecurity.password.notSet'))).toBeVisible();
    expect(screen.getByText(t('ownerSecurity.authenticator.notSet'))).toBeVisible();
    expect(screen.getAllByText(t('ownerSecurity.notSetUp'))).toHaveLength(2);
    // Recovery codes come with the authenticator.
    expect(screen.queryByText(t('ownerSecurity.recovery.title'))).toBeNull();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: t('ownerSecurity.password.setAction') }));
    const set = await dialog(t('ownerSecurity.password.setAction'));
    expect(within(set).queryByLabelText(t('ownerSecurity.password.current'))).toBeNull();
    await user.type(field(set, t('ownerSecurity.password.new')), 'too short');
    await user.click(within(set).getByRole('button', { name: t('ownerSecurity.password.save') }));
    expect(within(set).getByText(t('ownerSecurity.password.tooShort'))).toBeVisible();
    await user.type(field(set, t('ownerSecurity.password.new')), ' but longer');
    await user.type(field(set, t('ownerSecurity.password.again')), 'too short but long');
    await user.click(within(set).getByRole('button', { name: t('ownerSecurity.password.save') }));
    expect(within(set).getByText(t('ownerSecurity.password.mismatch'))).toBeVisible();
    await user.type(field(set, t('ownerSecurity.password.again')), 'er');
    await user.click(within(set).getByRole('button', { name: t('ownerSecurity.password.save') }));

    expect(await screen.findByText(t('ownerSecurity.password.saved'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/auth/owner/password')[0]?.body).toEqual({
      newPassword: 'too short but longer',
    });
    expect(await screen.findByText(t('ownerSecurity.password.set'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/auth/step-up')).toHaveLength(0);
  });

  it('adds the authenticator by QR code or key, then shows the recovery codes once', async () => {
    const before = ownerSecurity({ hasAuthenticator: false, recoveryCodesLeft: 0 });
    const fake = ownerServer(before, ownerSecurity())
      .on('POST', '/api/v1/auth/owner/totp/enroll', () => ({ status: 200, body: ENROLMENT }))
      .on(
        'POST',
        '/api/v1/auth/owner/totp/confirm',
        () => ({
          status: 422,
          body: {
            code: 'INVALID_CODE',
            message: 'That code did not match. Enter the current code from the app.',
          },
        }),
        () => ({ status: 200, body: { recoveryCodes: RECOVERY_CODES } }),
      );
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/security',
      signedIn: 'OWNER',
    });
    await user.click(
      await screen.findByRole('button', { name: t('ownerSecurity.authenticator.add') }),
    );
    const add = await dialog(t('ownerSecurity.authenticator.add'));
    expect(
      within(add).getByRole('img', { name: t('ownerSecurity.authenticator.qrLabel') }),
    ).toBeVisible();
    expect(within(add).getByText(groupedKey(ENROLMENT.secret))).toBeVisible();
    expect(groupedKey(ENROLMENT.secret)).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    await expectNoAxeViolations(container);

    const code = field(add, t('ownerSecurity.authenticator.code'));
    await user.type(code, '12345');
    await user.click(
      within(add).getByRole('button', { name: t('ownerSecurity.authenticator.confirm') }),
    );
    expect(within(add).getByText(t('secondFactor.codeInvalid'))).toBeVisible();
    await user.type(code, '6');
    await user.click(
      within(add).getByRole('button', { name: t('ownerSecurity.authenticator.confirm') }),
    );
    expect(await within(add).findByRole('alert')).toHaveTextContent('That code did not match.');
    await user.click(
      within(add).getByRole('button', { name: t('ownerSecurity.authenticator.confirm') }),
    );

    const codes = await dialog(t('ownerSecurity.recovery.saveTitle'));
    const list = within(codes).getByRole('list', { name: t('ownerSecurity.recovery.codes') });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(RECOVERY_CODES);
    // Only "I have saved them" closes it: Escape does not lose the codes.
    await user.keyboard('{Escape}');
    expect(codes).toBeVisible();
    await user.click(
      within(codes).getByRole('button', { name: t('ownerSecurity.recovery.saved') }),
    );
    expect(await screen.findByText(t('ownerSecurity.authenticator.done'))).toBeVisible();
    expect(await screen.findByText(t('ownerSecurity.recovery.left', { count: 10 }))).toBeVisible();
    expect(
      fake.callsTo('POST', '/api/v1/auth/owner/totp/confirm').map((call) => call.body),
    ).toEqual([{ code: '123456' }, { code: '123456' }]);
  });

  it('asks for the second factor before replacing the authenticator or changing the password', async () => {
    const fake = ownerServer(ownerSecurity({ recoveryCodesLeft: 3 }))
      .on(
        'POST',
        '/api/v1/auth/owner/totp/enroll',
        () => SECOND_FACTOR_REQUIRED,
        () => ({ status: 200, body: ENROLMENT }),
      )
      .on('POST', '/api/v1/auth/step-up', () => ({
        status: 200,
        body: { secondFactorValidUntil: '2026-09-28T10:10:00.000Z' },
      }))
      .on('POST', '/api/v1/auth/owner/password', () => ({ status: 204 }));
    const { user } = await renderConsole({ fake, path: '/manage/security', signedIn: 'OWNER' });
    expect(await screen.findByText(t('ownerSecurity.recovery.left', { count: 3 }))).toBeVisible();

    await user.click(
      screen.getByRole('button', { name: t('ownerSecurity.authenticator.replace') }),
    );
    const confirm = await dialog(t('secondFactor.title'));
    await user.type(
      await within(confirm).findByLabelText(new RegExp(`^${t('secondFactor.password')}`)),
      'correct horse battery',
    );
    await user.type(field(confirm, t('secondFactor.code')), '654321');
    await user.click(within(confirm).getByRole('button', { name: t('secondFactor.confirm') }));
    const add = await dialog(t('ownerSecurity.authenticator.add'));
    expect(
      within(add).getByRole('img', { name: t('ownerSecurity.authenticator.qrLabel') }),
    ).toBeVisible();
    await user.click(
      within(add).getByRole('button', { name: t('ownerSecurity.authenticator.cancel') }),
    );

    // The confirmation holds, so changing the password goes straight through.
    await user.click(
      screen.getByRole('button', { name: t('ownerSecurity.password.changeAction') }),
    );
    const change = await dialog(t('ownerSecurity.password.changeAction'));
    await user.type(field(change, t('ownerSecurity.password.current')), 'correct horse battery');
    await user.type(field(change, t('ownerSecurity.password.new')), 'staple battery horse');
    await user.type(field(change, t('ownerSecurity.password.again')), 'staple battery horse');
    await user.click(
      within(change).getByRole('button', { name: t('ownerSecurity.password.save') }),
    );
    expect(await screen.findByText(t('ownerSecurity.password.changed'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/auth/owner/password')[0]?.body).toEqual({
      currentPassword: 'correct horse battery',
      newPassword: 'staple battery horse',
    });
    expect(fake.callsTo('POST', '/api/v1/auth/step-up')).toHaveLength(1);
  });
});
